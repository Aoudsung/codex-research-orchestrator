import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { BridgeDatabase, resolveBridgeDbPath } from "./bridge-db.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_ROOT = path.resolve(__dirname, "..");

export function getMaxSourceMtimeMs() {
  let maxMtime = 0;
  for (const sub of ["core", "servers"]) {
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
  return path.join(path.dirname(dbPath), "wakeup-daemon.json");
}

function isPidAlive(pid) {
  const num = Number(pid);
  if (!Number.isInteger(num) || num <= 0) return false;
  try {
    process.kill(num, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

export function readDaemonState(dbPath = resolveBridgeDbPath()) {
  const statePath = getDaemonStateFilePath(dbPath);
  try {
    if (!fs.existsSync(statePath)) return null;
    const raw = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return {
      ...raw,
      alive: isPidAlive(raw?.pid),
    };
  } catch {
    return null;
  }
}

export function stopResidentWakeupDaemon(dbPath = resolveBridgeDbPath()) {
  const resolvedDbPath = path.resolve(dbPath);
  const existing = readDaemonState(resolvedDbPath);
  const statePath = getDaemonStateFilePath(resolvedDbPath);
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

/**
 * Ensure a singleton resident wakeup receiver daemon is running the latest code on disk
 * for the given `dbPath`. If a stale daemon is running older code, it is replaced.
 */
export function ensureResidentWakeupDaemon(dbPath = resolveBridgeDbPath()) {
  if (
    process.env.BRIDGE_DISABLE_WAKEUP_DAEMON === "1" ||
    process.env.BRIDGE_WAKEUP_DAEMON_PROCESS === "1"
  ) {
    return null;
  }

  const resolvedDbPath = path.resolve(dbPath);
  const currentCodeMtime = getMaxSourceMtimeMs();
  const existing = readDaemonState(resolvedDbPath);

  if (existing && existing.alive) {
    const daemonMtime = Number(existing.codeMtimeMs || 0);
    if (daemonMtime >= currentCodeMtime - 1) {
      return existing;
    }
    // Code on disk is newer than running daemon -> terminate old daemon so fresh one takes over
    try {
      process.kill(Number(existing.pid), "SIGTERM");
    } catch {
      // ignore
    }
  }

  try {
    const child = spawn(
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

async function runDaemonLoop(dbPath) {
  const resolvedDbPath = path.resolve(dbPath);
  const statePath = getDaemonStateFilePath(resolvedDbPath);
  const bootMtimeMs = getMaxSourceMtimeMs();

  // Check if another up-to-date daemon is already alive
  const current = readDaemonState(resolvedDbPath);
  if (
    current &&
    current.alive &&
    Number(current.pid) !== process.pid &&
    Number(current.codeMtimeMs || 0) >= bootMtimeMs - 1
  ) {
    process.exit(0);
  }

  const writeState = (extra = {}) => {
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(
        statePath,
        JSON.stringify(
          {
            pid: process.pid,
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

  const bootIso = new Date().toISOString();
  writeState();

  const db = new BridgeDatabase(resolvedDbPath);
  const coalesceMs = Number(process.env.BRIDGE_WAKEUP_COALESCE_MS ?? 800);
  const unconfirmedGraceMs = Number(
    process.env.BRIDGE_UNCONFIRMED_DISPATCH_GRACE_MS ?? 3500
  );
  let sweepInProgress = false;

  const sweepPendingRoutes = async () => {
    if (sweepInProgress) return;
    if (!fs.existsSync(resolvedDbPath)) {
      cleanup();
      return;
    }
    sweepInProgress = true;
    try {
      // Hot-reload check: if source files changed on disk, spawn replacement and exit
      const latestMtime = getMaxSourceMtimeMs();
      if (latestMtime > bootMtimeMs + 1) {
        try {
          const replacement = spawn(process.execPath, [__filename, resolvedDbPath], {
            detached: true,
            stdio: "ignore",
            env: {
              ...process.env,
              AGENT_BRIDGE_DB: resolvedDbPath,
              BRIDGE_WAKEUP_DAEMON_PROCESS: "1",
            },
          });
          replacement.unref();
        } catch {
          // ignore
        }
        process.exit(0);
      }

      const routes = db.db
        .prepare(`SELECT * FROM wakeup_routes WHERE enabled = 1`)
        .all();

      const nowMs = Date.now();
      for (const route of routes) {
        if (!route || route.driver === "manual") continue;

        const candidates = db.db
          .prepare(
            `SELECT id, seq, wakeup_status, wakeup_dispatched_at, created_at
             FROM messages
             WHERE task_id = ? AND to_agent = ? AND status = 'unread'
               AND wakeup_status IN ('pending', 'dispatched')
               AND seq > ?
             ORDER BY seq ASC`
          )
          .all(
            route.task_id,
            route.to_agent,
            Number(route.last_woken_seq || 0)
          );

        if (candidates.length === 0) continue;

        // Check quiet window on newest candidate message
        const newest = candidates[candidates.length - 1];
        const newestCreatedMs = Date.parse(newest.created_at || "") || nowMs;
        if (nowMs - newestCreatedMs < coalesceMs) {
          continue;
        }

        // If all candidates are 'dispatched' (e.g. returned to an in-turn waitForDelivery),
        // give the caller `unconfirmedGraceMs` to confirm receipt before resident daemon takes over
        const hasPending = candidates.some((c) => c.wakeup_status === "pending");
        if (!hasPending) {
          const newestDispatchedMs =
            Date.parse(newest.wakeup_dispatched_at || newest.created_at || "") ||
            nowMs;
          if (nowMs - newestDispatchedMs < unconfirmedGraceMs) {
            continue;
          }
        }

        await db.executeWakeupDelivery(route.task_id, {
          workerPid: process.pid,
          includeDispatched: true,
        });
      }
      writeState();
    } catch {
      // ignore transient sqlite busy errors
    } finally {
      sweepInProgress = false;
    }
  };

  const timer = setInterval(sweepPendingRoutes, 500);
  let fsWatcher = null;
  try {
    const dbDir = path.dirname(resolvedDbPath);
    const dbBase = path.basename(resolvedDbPath);
    fsWatcher = fs.watch(dbDir, { persistent: true }, (_event, filename) => {
      if (!filename || filename.startsWith(dbBase)) {
        sweepPendingRoutes();
      }
    });
  } catch {
    // interval fallback is active
  }

  const cleanup = () => {
    clearInterval(timer);
    try {
      fsWatcher?.close();
    } catch {
      // ignore
    }
    process.exit(0);
  };

  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);

  await sweepPendingRoutes();
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(__filename)
) {
  if (process.argv[2] === "--deliver-task") {
    const [, , , taskId, dbPath, delayMsStr, driverArg] = process.argv;
    const db = new BridgeDatabase(dbPath);
    const failAndExit = (err) => {
      try {
        db.recordWakeupFailure(taskId, [], err?.message || String(err));
      } catch {
        // ignore
      }
      process.exit(1);
    };
    process.on("uncaughtException", failAndExit);
    process.on("unhandledRejection", failAndExit);
    (async () => {
      try {
        const delayMs = Number(delayMsStr);
        if (Number.isFinite(delayMs) && delayMs > 0) {
          await new Promise((r) => setTimeout(r, delayMs));
        }
        await db.executeWakeupDelivery(taskId, {
          driverOverride: driverArg || null,
          workerPid: process.pid,
          includeDispatched: false,
        });
        process.exit(0);
      } catch (err) {
        failAndExit(err);
      }
    })();
  } else {
    const targetDb = process.argv[2] || resolveBridgeDbPath();
    runDaemonLoop(targetDb);
  }
}
