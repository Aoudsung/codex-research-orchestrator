import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  DEFAULT_EXTERNAL_CHANNEL_CHECK_MS,
  DEFAULT_HANDBACK_STALE_MS,
  DEFAULT_ORPHAN_ROUTE_TIMEOUT_MS,
  DEFAULT_UNCONSUMED_GRACE_MS,
  detectNeedsReviewEvidenceUsage,
  detectRepeatedValidationSpin,
  detectStaleHandbacks,
  findOrphanedInFlightRoutes,
  findUnconsumedDeliveredMessages,
  shouldScheduleExternalChannelCheck,
  shouldTripDeliveryCircuitBreaker,
} from "../domain/watchdog-rules.mjs";
import { resolveResearchProjectRoot } from "./router-service.mjs";

export function isProcessAlive(pid) {
  const num = Number(pid);
  if (!Number.isInteger(num) || num <= 0) return false;
  try {
    process.kill(num, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/**
 * Read `needs_review` record IDs from `.research-memory/memory.sqlite3` strictly read-only.
 * Never creates or mutates any database files.
 */
function readNeedsReviewRecordIds(projectRoot) {
  if (!projectRoot) return new Set();
  const memDbPath = path.join(projectRoot, ".research-memory", "memory.sqlite3");
  if (!fs.existsSync(memDbPath)) return new Set();

  let memDb = null;
  try {
    memDb = new DatabaseSync(memDbPath, { readOnly: true, timeout: 2000 });
    memDb.exec("PRAGMA query_only = ON;");
    const tables = memDb
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'records'`
      )
      .all();
    if (tables.length === 0) return new Set();
    const cols = memDb.prepare(`PRAGMA table_info(records)`).all();
    const hasStatus = cols.some((c) => c.name === "status");
    const hasReviewState = cols.some((c) => c.name === "review_state");
    const ids = new Set();
    if (hasStatus) {
      for (const r of memDb
        .prepare(`SELECT id FROM records WHERE status = 'needs_review'`)
        .all()) {
        if (r?.id) ids.add(String(r.id));
      }
    }
    if (hasReviewState) {
      for (const r of memDb
        .prepare(`SELECT id FROM records WHERE review_state = 'needs_review'`)
        .all()) {
        if (r?.id) ids.add(String(r.id));
      }
    }
    return ids;
  } catch {
    return new Set();
  } finally {
    try {
      memDb?.close();
    } catch {
      // ignore
    }
  }
}

/**
 * Append deduplicated L2 objective events to `<projectRoot>/.optimizer/watchdog-events.jsonl`.
 * Keeps the file strictly UNCHANGED if all `dedupeKey`s were already recorded.
 */
function appendOptimizerEvents(projectRoot, alerts = []) {
  if (!projectRoot || !Array.isArray(alerts) || alerts.length === 0) {
    return { written: 0, filePath: null };
  }
  const optimizerDir = path.join(projectRoot, ".optimizer");
  const filePath = path.join(optimizerDir, "watchdog-events.jsonl");
  const existingKeys = new Set();

  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf8");
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed?.dedupeKey) existingKeys.add(parsed.dedupeKey);
        } catch {
          // ignore malformed line
        }
      }
    }
  } catch {
    // ignore read error
  }

  const fresh = alerts.filter(
    (a) => a && a.dedupeKey && !existingKeys.has(a.dedupeKey)
  );
  if (fresh.length === 0) {
    return { written: 0, filePath };
  }

  fs.mkdirSync(optimizerDir, { recursive: true });
  const payload = `${fresh.map((e) => JSON.stringify(e)).join("\n")}\n`;
  fs.appendFileSync(filePath, payload, "utf8");
  return { written: fresh.length, filePath };
}

/**
 * Dual-Layer Watchdog Service:
 * - L1 Infrastructure Self-Healing (zero LLM cost):
 *   1. Reaps dead/timed-out `in_flight` worker locks
 *   2. Recovers phase-1 `delivered` messages that were never phase-2 `consumed` (`consumed_at IS NULL`) with an idempotent `RecoveryNote`
 *   3. Trips 3-strike `person/delivery_failed` circuit breaker
 *   4. Schedules silent external-channel polling ONLY when `awaiting_external_channel` tasks exist
 * - L2 Anti-Spin Semantic Probes (strictly respects Luna / Optimizer boundary):
 *   1. Repeated validation failure spin (`>= 3` consecutive same-category failures)
 *   2. Stale unresolved `bridge_handback` items
 *   3. Active tasks citing `needs_review` records in `.research-memory`
 *   -> Writes deduplicated objective JSONL events to `.optimizer/watchdog-events.jsonl` and raises Workbench `stall_detected` alerts without altering research plans or code.
 */
export class WatchdogService {
  /**
   * @param {object} options
   * @param {import('../domain/engine.mjs').BridgeEngine} options.engine
   * @param {import('./health-board.mjs').HealthBoard | null} [options.healthBoard]
   * @param {import('./slot-scheduler.mjs').SlotScheduler | null} [options.slotScheduler]
   * @param {string | null} [options.projectRoot]
   * @param {string | null} [options.dbPath]
   * @param {(pid: number) => boolean} [options.isPidAlive]
   * @param {number} [options.unconsumedGraceMs]
   * @param {number} [options.orphanTimeoutMs]
   * @param {number} [options.staleHandbackMs]
   * @param {number} [options.externalChannelIntervalMs]
   */
  constructor({
    engine,
    healthBoard = null,
    slotScheduler = null,
    projectRoot = null,
    dbPath = null,
    isPidAlive = isProcessAlive,
    unconsumedGraceMs = Number(
      process.env.BRIDGE_UNCONSUMED_GRACE_MS || DEFAULT_UNCONSUMED_GRACE_MS
    ),
    orphanTimeoutMs = DEFAULT_ORPHAN_ROUTE_TIMEOUT_MS,
    staleHandbackMs = DEFAULT_HANDBACK_STALE_MS,
    externalChannelIntervalMs = DEFAULT_EXTERNAL_CHANNEL_CHECK_MS,
  }) {
    this.engine = engine;
    this.healthBoard = healthBoard;
    this.slotScheduler = slotScheduler;
    this.projectRoot = resolveResearchProjectRoot({
      explicitRoot: projectRoot,
      dbPath,
    });
    this.isPidAlive = isPidAlive;
    this.unconsumedGraceMs = unconsumedGraceMs;
    this.orphanTimeoutMs = orphanTimeoutMs;
    this.staleHandbackMs = staleHandbackMs;
    this.externalChannelIntervalMs = externalChannelIntervalMs;
    this.health = healthBoard
      ? healthBoard.claim("watchdog", { initialState: "starting" })
      : null;
    this._lastExternalChannelCheckMs = 0;
    this._lastSweepSummary = null;
  }

  runSweep({
    nowMs = Date.now(),
    projectRoot = this.projectRoot,
    needsReviewIds = null,
  } = {}) {
    const nowIso = new Date(nowMs).toISOString();
    const ctrl = this.engine.getControlState();

    if (ctrl.paused) {
      this._lastExternalChannelCheckMs = 0;
      this.health?.paused(ctrl.reason || "Bridge paused");
      const summary = {
        paused: true,
        sweptAt: nowIso,
        reapedRoutes: [],
        recoveredMessages: [],
        trippedBreakers: [],
        externalChannelCheck: { shouldCheck: false, activeTaskIds: [] },
        l2Alerts: [],
        optimizerEventsWritten: 0,
      };
      this._lastSweepSummary = summary;
      return summary;
    }

    const effectiveProjectRoot =
      projectRoot !== undefined ? projectRoot : this.projectRoot;
    const flaggedRecordIds =
      needsReviewIds instanceof Set
        ? needsReviewIds
        : Array.isArray(needsReviewIds)
          ? new Set(needsReviewIds)
          : readNeedsReviewRecordIds(effectiveProjectRoot);

    const sweepResult = this.engine.repos.atomic(() => {
      const repos = this.engine.repos;
      const routes = repos.listRoutes();
      const tasks = repos.listTasks({ limit: 200 });
      const allUnreadMessages = repos.queryMessages({
        toAgent: "*",
        unreadOnly: true,
        limit: 500,
      });

      // L1.1: Reap orphaned in-flight routes whose worker PID died or timed out
      const orphaned = findOrphanedInFlightRoutes(routes, {
        isPidAlive: this.isPidAlive,
        nowMs,
        timeoutMs: this.orphanTimeoutMs,
      });
      for (const item of orphaned) {
        const route = repos.getRoute(item.taskId);
        if (!route) continue;
        repos.putRoute({
          ...route,
          in_flight: 0,
          worker_pid: null,
          last_error: `Watchdog reaped orphaned in_flight lock (${item.reason}, pid=${item.workerPid})`,
          updated_at: nowIso,
        });
        const taskMsgs = allUnreadMessages.filter(
          (m) => m.task_id === item.taskId && m.wakeup_status === "dispatched"
        );
        for (const m of taskMsgs) {
          repos.putMessage({ ...m, wakeup_status: "pending" });
        }
        repos.enqueueEffect({
          kind: "wakeup",
          effectKey: item.taskId,
          payload: { taskId: item.taskId, reason: "watchdog_orphan_reaped" },
          dueMs: nowMs,
          nowIso,
        });
      }

      // L1.2: Recover phase-1 `delivered` messages that were never phase-2 `consumed` (`consumed_at IS NULL`)
      const patchesByTask = new Map();
      for (const t of tasks) {
        patchesByTask.set(
          t.id,
          repos.listPatches({ taskId: t.id, includeRawContent: false })
        );
      }

      const unconsumed = findUnconsumedDeliveredMessages(
        allUnreadMessages,
        patchesByTask,
        {
          nowMs,
          graceMs: this.unconsumedGraceMs,
        }
      );

      for (const item of unconsumed) {
        const msg = repos.getMessage(item.messageId);
        if (!msg || msg.handback_reason) continue;
        const route = msg.task_id ? repos.getRoute(msg.task_id) : null;
        if (route && shouldTripDeliveryCircuitBreaker(route)) {
          continue;
        }
        repos.putMessage({
          ...msg,
          wakeup_status: "pending",
          metadata: {
            ...(msg.metadata || {}),
            recoveryNote: item.recoveryNote,
            recoveredAt: nowIso,
          },
        });
        // Roll back route.last_woken_seq below this unconsumed message seq so claimPendingWakeup picks it up!
        if (route && Number(route.last_woken_seq || 0) >= Number(msg.seq || 0)) {
          repos.putRoute({
            ...route,
            last_woken_seq: Math.max(0, Number(msg.seq || 1) - 1),
            updated_at: nowIso,
          });
        }
        if (msg.task_id) {
          repos.enqueueEffect({
            kind: "wakeup",
            effectKey: msg.task_id,
            payload: {
              taskId: msg.task_id,
              messageId: msg.id,
              reason: "watchdog_unconsumed_redelivery",
              recoveryNote: item.recoveryNote,
            },
            dueMs: nowMs,
            nowIso,
          });
        }
      }

      // L1.3: Trip 3-strike delivery circuit breaker on failing routes
      const trippedBreakers = [];
      for (const r of repos.listRoutes()) {
        if (!shouldTripDeliveryCircuitBreaker(r)) continue;
        const task = repos.getTask(r.task_id);
        if (task && !task.metadata?.deliveryCircuitOpen) {
          repos.putTask({
            ...task,
            metadata: {
              ...task.metadata,
              deliveryCircuitOpen: true,
              lastDeliveryError:
                r.last_error || "3 consecutive delivery failures",
            },
            updated_at: nowIso,
          });
          trippedBreakers.push(r.task_id);
        }
      }

      // L1.4: On-demand silent external-channel timer check
      const extCheck = shouldScheduleExternalChannelCheck({
        tasks,
        paused: false,
        lastCheckMs: this._lastExternalChannelCheckMs,
        nowMs,
        intervalMs: this.externalChannelIntervalMs,
      });
      if (extCheck.activeTaskIds.length === 0) {
        // Zero waiting tasks -> stop timer cleanly
        this._lastExternalChannelCheckMs = 0;
      } else if (extCheck.shouldCheck) {
        this._lastExternalChannelCheckMs = nowMs;
        for (const tid of extCheck.activeTaskIds) {
          repos.enqueueEffect({
            kind: "channel_check",
            effectKey: tid,
            payload: { taskId: tid, checkedAt: nowIso },
            dueMs: nowMs,
            nowIso,
          });
        }
      }

      // L2: Anti-Spin & Stale Evidence Semantic Probes
      const validationsByTask = new Map();
      for (const t of tasks) {
        if (["completed", "failed", "cancelled"].includes(t.status)) continue;
        validationsByTask.set(
          t.id,
          repos.listValidations({ taskId: t.id, limit: 25 })
        );
      }

      const spinAlerts = detectRepeatedValidationSpin(validationsByTask, {
        nowIso,
      });
      const staleHbAlerts = detectStaleHandbacks(tasks, {
        nowMs,
        staleMs: this.staleHandbackMs,
        nowIso,
      });
      const staleEvidenceAlerts = detectNeedsReviewEvidenceUsage(
        tasks,
        flaggedRecordIds,
        { nowIso }
      );
      const l2Alerts = [
        ...spinAlerts,
        ...staleHbAlerts,
        ...staleEvidenceAlerts,
      ];

      for (const alert of l2Alerts) {
        const task = repos.getTask(alert.taskId);
        if (!task) continue;
        if (task.metadata?.stallAlert?.dedupeKey === alert.dedupeKey) {
          continue;
        }
        repos.putTask({
          ...task,
          metadata: {
            ...task.metadata,
            stallAlert: {
              ...alert,
              resolvedAt: null,
            },
          },
          updated_at: nowIso,
        });
      }

      return {
        paused: false,
        sweptAt: nowIso,
        reapedRoutes: orphaned,
        recoveredMessages: unconsumed,
        trippedBreakers,
        externalChannelCheck: extCheck,
        l2Alerts,
      };
    });

    const optWrite = appendOptimizerEvents(
      effectiveProjectRoot,
      sweepResult.l2Alerts
    );

    const finalSummary = {
      ...sweepResult,
      optimizerEventsWritten: optWrite.written,
      optimizerEventsPath: optWrite.filePath,
    };

    this._lastSweepSummary = finalSummary;
    this.health?.ready(
      `reaped=${sweepResult.reapedRoutes.length} recovered=${sweepResult.recoveredMessages.length} alerts=${sweepResult.l2Alerts.length}`
    );
    return finalSummary;
  }

  getStatus() {
    const health = this.healthBoard
      ? this.healthBoard.snapshot()
      : {
          overall: "ready",
          components: this.engine.repos.listHealth(),
        };
    const pendingEffects = this.engine.repos.listEffects({ limit: 100 });
    const slots = this.slotScheduler
      ? this.slotScheduler.status()
      : {
          maxWorkers: Number(process.env.BRIDGE_MAX_WORKERS || 3),
          humanReservedSlots: 1,
          normalInUse: 0,
          humanPriorityInUse: 0,
          totalInUse: 0,
          pendingHumanDemand: 0,
          activeKeys: [],
        };
    const attention = this.engine.buildAttentionQueue();
    const control = this.engine.getControlState();

    return {
      control,
      health,
      effectsQueueDepth: pendingEffects.length,
      pendingEffects: pendingEffects.slice(0, 25),
      slots,
      attentionCount: attention.length,
      attention,
      lastSweep: this._lastSweepSummary,
    };
  }

  stop() {
    this.health?.release();
  }
}
