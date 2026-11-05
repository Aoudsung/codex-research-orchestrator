import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { BridgeDatabase, resolveBridgeDbPath } from "../core/bridge-db.mjs";
import { HealthBoard } from "./health-board.mjs";
import { SlotScheduler } from "./slot-scheduler.mjs";
import { EffectsQueue, Later } from "../store/effects-queue.mjs";
import { RouterService } from "./router-service.mjs";
import { WatchdogService, isProcessAlive } from "./watchdog-service.mjs";
import { PassesPump } from "./passes.mjs";
import { executeTaskWakeupDriver } from "./drivers.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_ROOT = path.resolve(__dirname, "..");

const SOURCE_SUBDIRS = ["core", "domain", "store", "runtime", "servers"];

export function getMaxSourceMtimeMs() {
  let maxMtime = 0;
  for (const sub of SOURCE_SUBDIRS) {
    const dir = path.join(SRC_ROOT, sub);
    try {
      for (const entry of fs.readdirSync(dir)) {
        if (!entry.endsWith(".mjs")) continue;
        const st = fs.statSync(path.join(dir, entry));
        if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs;
      }
    } catch {
      // ignore
    }
  }
  return maxMtime;
}

export function getDaemonStateFilePath(dbPath = resolveBridgeDbPath()) {
  return path.join(path.dirname(path.resolve(dbPath)), "wakeup-daemon.json");
}

export function getDaemonStopMarkerPath(dbPath = resolveBridgeDbPath()) {
  return path.join(path.dirname(path.resolve(dbPath)), "wakeup-daemon.stopped");
}

export function readDaemonState(dbPath = resolveBridgeDbPath()) {
  const statePath = getDaemonStateFilePath(dbPath);
  try {
    if (!fs.existsSync(statePath)) return null;
    const raw = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return {
      ...raw,
      alive: isProcessAlive(raw?.pid),
    };
  } catch {
    return null;
  }
}

export function stopResidentSuperagentDaemon(
  dbPath = resolveBridgeDbPath(),
  { markManualStop = false } = {}
) {
  const resolvedDbPath = path.resolve(dbPath);
  const existing = readDaemonState(resolvedDbPath);
  const statePath = getDaemonStateFilePath(resolvedDbPath);
  const stopMarker = getDaemonStopMarkerPath(resolvedDbPath);

  if (markManualStop) {
    try {
      fs.mkdirSync(path.dirname(stopMarker), { recursive: true });
      fs.writeFileSync(
        stopMarker,
        JSON.stringify({ stoppedAt: new Date().toISOString() }, null, 2)
      );
    } catch {
      // ignore
    }
  }

  if (existing && existing.alive && existing.pid) {
    try {
      process.kill(Number(existing.pid), "SIGTERM");
    } catch {
      // ignore
    }
  }
  try {
    if (fs.existsSync(statePath)) {
      fs.unlinkSync(statePath);
    }
  } catch {
    // ignore
  }
}

export function ensureResidentSuperagentDaemon(
  dbPath = resolveBridgeDbPath(),
  { clearStopMarker = false, respectStop = false } = {}
) {
  if (
    process.env.BRIDGE_DISABLE_WAKEUP_DAEMON === "1" ||
    process.env.BRIDGE_WAKEUP_DAEMON_PROCESS === "1"
  ) {
    return null;
  }

  const resolvedDbPath = path.resolve(dbPath);
  const stopMarker = getDaemonStopMarkerPath(resolvedDbPath);
  if (clearStopMarker) {
    try {
      if (fs.existsSync(stopMarker)) fs.unlinkSync(stopMarker);
    } catch {
      // ignore
    }
  } else if (respectStop && fs.existsSync(stopMarker)) {
    return {
      stoppedManually: true,
      dbPath: resolvedDbPath,
    };
  }

  const currentCodeMtime = getMaxSourceMtimeMs();
  const existing = readDaemonState(resolvedDbPath);

  if (existing && existing.alive) {
    const daemonMtime = Number(existing.codeMtimeMs || 0);
    if (daemonMtime >= currentCodeMtime - 1) {
      return existing;
    }
    try {
      process.kill(Number(existing.pid), "SIGTERM");
    } catch {
      // ignore
    }
  }

  try {
    const child = spawn(process.execPath, [__filename, resolvedDbPath], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        AGENT_BRIDGE_DB: resolvedDbPath,
        BRIDGE_WAKEUP_DAEMON_PROCESS: "1",
      },
    });
    child.unref();
    return {
      pid: child.pid,
      dbPath: resolvedDbPath,
      codeMtimeMs: currentCodeMtime,
      spawned: true,
    };
  } catch {
    return null;
  }
}

export async function runSuperagentDaemonLoop(dbPath = resolveBridgeDbPath()) {
  const resolvedDbPath = path.resolve(dbPath);
  const statePath = getDaemonStateFilePath(resolvedDbPath);
  const bootMtimeMs = getMaxSourceMtimeMs();

  const current = readDaemonState(resolvedDbPath);
  if (
    current &&
    current.alive &&
    Number(current.pid) !== process.pid &&
    Number(current.codeMtimeMs || 0) >= bootMtimeMs - 1
  ) {
    process.exit(0);
  }

  const bootIso = new Date().toISOString();
  const writeState = (extra = {}) => {
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(
        statePath,
        JSON.stringify(
          {
            pid: process.pid,
            version: "1.1.0",
            dbPath: resolvedDbPath,
            codeMtimeMs: bootMtimeMs,
            startedAt: bootIso,
            heartbeatAt: new Date().toISOString(),
            ...extra,
          },
          null,
          2
        )
      );
    } catch {
      // ignore
    }
  };

  writeState();

  const bridgeDb = new BridgeDatabase(resolvedDbPath);
  const engine = bridgeDb.engine;
  const repos = bridgeDb.store;
  const healthBoard = new HealthBoard({ repos, pid: process.pid });
  const daemonHealth = healthBoard.claim("daemon", { initialState: "ready" });
  const effectsHealth = healthBoard.claim("effects", { initialState: "ready" });
  const slotScheduler = new SlotScheduler();

  const routerService = new RouterService({
    engine,
    healthBoard,
    dbPath: resolvedDbPath,
  });
  const watchdogService = new WatchdogService({
    engine,
    healthBoard,
    slotScheduler,
    dbPath: resolvedDbPath,
  });

  const coalesceMs = Number(process.env.BRIDGE_WAKEUP_COALESCE_MS ?? 800);
  const unconfirmedGraceMs = Number(
    process.env.BRIDGE_UNCONFIRMED_DISPATCH_GRACE_MS ?? 3500
  );

  const effectsQueue = new EffectsQueue({
    repos,
    healthHandle: effectsHealth,
  });

  // Register standard durable Effect handlers
  const dispatchRoute = async (effect, route) => {
    if (engine.getControlState().paused) {
      throw new Later(2000, "bridge_paused");
    }
    const taskId = effect.payload?.taskId || effect.effect_key;
    if (!route || !route.enabled || route.driver === "manual") {
      return { skipped: true, reason: "no_enabled_auto_route" };
    }
    if (Number(route.consecutive_failures || 0) >= 3 && effect.priority !== "human_priority") {
      return { skipped: true, reason: "delivery_circuit_open" };
    }

    const candidates = repos
      .queryMessages({
        toAgent: route.to_agent,
        taskId,
        unreadOnly: true,
        limit: 50,
      })
      .filter((m) =>
        ["pending", "dispatched", "failed"].includes(m.wakeup_status)
      );

    if (candidates.length === 0) {
      return { skipped: true, reason: "no_candidates" };
    }

    const nowMs = Date.now();
    const newest = candidates[candidates.length - 1];
    const newestCreatedMs = Date.parse(newest.created_at || "") || nowMs;
    if (nowMs - newestCreatedMs < coalesceMs) {
      throw new Later(
        Math.max(100, coalesceMs - (nowMs - newestCreatedMs)),
        "quiet_window_coalescing"
      );
    }

    const hasPending = candidates.some(
      (c) => c.wakeup_status === "pending" || c.wakeup_status === "failed"
    );
    if (!hasPending) {
      const newestDispatchedMs =
        Date.parse(newest.wakeup_dispatched_at || newest.created_at || "") ||
        nowMs;
      if (nowMs - newestDispatchedMs < unconfirmedGraceMs) {
        throw new Later(
          Math.max(200, unconfirmedGraceMs - (nowMs - newestDispatchedMs)),
          "awaiting_in_turn_confirmation"
        );
      }
    }

    const userInitiated =
      effect.priority === "human_priority" ||
      Boolean(effect.payload?.userInitiated);

    return slotScheduler.runWithSlot(`${taskId}:${route.to_agent}`, { userInitiated }, async () => {
      const outcome = await executeTaskWakeupDriver(engine, taskId, {
        toAgent: route.to_agent,
        workerPid: process.pid,
        includeDispatched: true,
        bypassCircuitBreaker: userInitiated,
      });
      if (outcome.claimed && !outcome.delivered && outcome.driver !== "manual") {
        throw new Error(outcome.error || "Wakeup delivery not accepted by host");
      }
      return outcome;
    });
  };

  effectsQueue.registerHandler("wakeup", async (effect) => {
    const taskId = effect.payload?.taskId || effect.effect_key;
    const routes = repos.listTaskRoutes(taskId);
    let failure = null;
    for (const route of routes) {
      try { await dispatchRoute(effect, route); }
      catch (error) { failure ||= error; }
    }
    if (failure) throw failure;
    return { ok: true };
  });

  effectsQueue.registerHandler("task_continue", (effect) => {
    const result = engine.processTaskContinuation(effect.payload);
    if (result?.deferred) throw new Later(result.retryAfterMs || 30000, result.reason || "waiting_for_trigger");
    return result;
  });

  effectsQueue.registerHandler("control_notice", async () => {
    // Notice message was atomically written by syncPolicy; wakeup effect handles live push if route is enabled.
    return { ok: true };
  });

  effectsQueue.registerHandler("fanout", async () => {
    return { ok: true };
  });

  effectsQueue.registerHandler("channel_check", async (effect) => {
    const taskId = effect.effect_key;
    const task = engine.getTaskById(taskId);
    if (!task || ["completed", "failed", "cancelled"].includes(task.status)) {
      return { skipped: true };
    }
    for (const route of repos.listTaskRoutes(taskId)) {
      if (!route.enabled || route.driver === "manual") continue;
      await executeTaskWakeupDriver(engine, taskId, {
        toAgent: route.to_agent,
        workerPid: process.pid,
        includeDispatched: true,
      });
    }
    return { ok: true };
  });

  let fsWatcher = null;
  let controlsWatcher = null;

  const cleanup = async () => {
    await pump.stop();
    try {
      fsWatcher?.close();
    } catch {}
    try {
      controlsWatcher?.close();
    } catch {}
    routerService.stop();
    watchdogService.stop();
    effectsHealth.release();
    daemonHealth.release();
    process.exit(0);
  };

  const pump = new PassesPump({
    intervalMs: 2000,
    passes: [
      {
        name: "hot_reload_check",
        run: () => {
          if (!fs.existsSync(resolvedDbPath)) {
            return cleanup();
          }
          const latestMtime = getMaxSourceMtimeMs();
          if (latestMtime > bootMtimeMs + 1) {
            try {
              const replacement = spawn(
                process.execPath,
                [__filename, resolvedDbPath],
                {
                  detached: true,
                  stdio: "ignore",
                  env: {
                    ...process.env,
                    AGENT_BRIDGE_DB: resolvedDbPath,
                    BRIDGE_WAKEUP_DAEMON_PROCESS: "1",
                  },
                }
              );
              replacement.unref();
            } catch {
              // ignore
            }
            process.exit(0);
          }
        },
      },
      {
        name: "router_policy_sync",
        run: () => {
          routerService.syncOnce();
        },
      },
      {
        name: "legacy_route_enqueue_bridge",
        run: () => {
          // Ensure any legacy direct DB inserts or pending route messages without an effect entry are enqueued
          if (engine.getControlState().paused) return;
          const routes = repos.listRoutes({ enabledOnly: true });
          for (const r of routes) {
            if (r.driver === "manual") continue;
            if (Number(r.consecutive_failures || 0) >= 3) continue;
            const pending = repos
              .queryMessages({
                toAgent: r.to_agent,
                taskId: r.task_id,
                unreadOnly: true,
                limit: 10,
              })
              .filter((m) =>
                ["pending", "dispatched", "failed"].includes(m.wakeup_status)
              );
            if (pending.length > 0) {
              const existing = repos
                .listEffects({ kind: "wakeup", limit: 200 })
                .find((e) => e.effect_key === r.task_id);
              if (!existing) {
                effectsQueue.enqueue({
                  kind: "wakeup",
                  effectKey: r.task_id,
                  payload: { taskId: r.task_id, reason: "route_sweep" },
                });
              }
            }
          }
        },
      },
      {
        name: "watchdog_sweep",
        run: () => {
          watchdogService.runSweep();
        },
      },
      {
        name: "effects_drain",
        run: async () => {
          await effectsQueue.drainDue({ limit: 25 });
          daemonHealth.ready("active");
          writeState({
            routerMode: engine.getControlState().routerMode,
            slots: slotScheduler.status(),
          });
        },
      },
    ],
  });

  engine.onEffectsEnqueued = () => {
    pump.kick();
  };

  try {
    const dbDir = path.dirname(resolvedDbPath);
    const dbBase = path.basename(resolvedDbPath);
    fsWatcher = fs.watch(dbDir, { persistent: true }, (_event, filename) => {
      if (!filename || filename.startsWith(dbBase)) {
        pump.kick();
      }
    });
  } catch {
    // 2s periodic pump remains active
  }

  if (routerService.controlsPath) {
    try {
      const ctrlDir = path.dirname(routerService.controlsPath);
      if (fs.existsSync(ctrlDir)) {
        controlsWatcher = fs.watch(
          ctrlDir,
          { persistent: false },
          (_ev, filename) => {
            if (!filename || filename === "controls.md") {
              pump.kick();
            }
          }
        );
      }
    } catch {
      // ignore
    }
  }

  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);

  routerService.syncOnce({ force: true });
  await pump.start();
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(__filename)
) {
  const targetDb = process.argv[2] || resolveBridgeDbPath();
  runSuperagentDaemonLoop(targetDb);
}
