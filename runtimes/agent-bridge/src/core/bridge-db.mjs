import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { PHASE_LABELS, computePatchApplyOrder } from "../domain/model.mjs";
import { BridgeEngine } from "../domain/engine.mjs";
import { SqliteStore } from "../store/sqlite-store.mjs";
import { executeTaskWakeupDriver } from "../runtime/drivers.mjs";
import { WatchdogService, isProcessAlive } from "../runtime/watchdog-service.mjs";
import { ensureResidentWakeupDaemon } from "./wakeup-daemon.mjs";

export { PHASE_LABELS };

/**
 * Resolve the shared SQLite database path.
 */
export function resolveBridgeDbPath() {
  if (process.env.AGENT_BRIDGE_DB) {
    return path.resolve(process.env.AGENT_BRIDGE_DB);
  }
  throw new Error(
    "AGENT_BRIDGE_DB must name a caller-configured shared database path."
  );
}

/**
 * Compatibility & Runtime Facade over `SqliteStore` (Layer 2), `BridgeEngine` (Layer 1),
 * `WatchdogService` & `Drivers` (Layer 3).
 *
 * Preserves 100% of the v0.5.0 `BridgeDatabase` public contract while exposing
 * v1.0.0 Research Router, Durable Effects, Two-Phase Message Consumption,
 * Inline Cards / Spill Pointers, and Dual-Layer Watchdog APIs.
 */
export class BridgeDatabase {
  /**
   * @param {string} [dbPath]
   */
  constructor(dbPath = resolveBridgeDbPath()) {
    this.dbPath = path.resolve(dbPath);
    this.store = new SqliteStore(this.dbPath);
    this.db = this.store.db;

    // Route sequence allocation through `this.nextSeq()` so external test hooks remain interceptable
    this._rawNextSeq = this.store.nextSeq.bind(this.store);
    this.store.nextSeq = () => this.nextSeq();

    this.onMessageSent = null;
    this._localWaiters = new Set();
    this._watcherTimer = null;
    this._fsWatcher = null;
    this._lastWatchedSeq = 0;

    this.engine = new BridgeEngine({
      repos: this.store,
      isWakeupGuarded: () =>
        process.env.BRIDGE_WAKEUP_TURN === "1" ||
        process.env.BRIDGE_DISABLE_CLI_WAKEUP === "1",
      defaultCwd: () => process.cwd(),
      isPidAlive: isProcessAlive,
    });

    this.watchdog = new WatchdogService({
      engine: this.engine,
      dbPath: this.dbPath,
    });

    this.engine.onMessageCommitted = (saved) => {
      this._notifyLocalWaiters();
      if (typeof this.onMessageSent === "function") {
        try {
          this.onMessageSent(saved);
        } catch {
          // Durable event remains persisted even if listener throws
        }
      }
      if (saved.wakeup_status === "pending") {
        this._scheduleWakeupForMessage(saved);
      }
    };
  }

  // ===========================================================================
  // Control, Policy & Cursor Sequence
  // ===========================================================================

  getControlState() {
    return this.engine.getControlState();
  }

  setControlState({ paused, reason = null, routerMode = undefined }) {
    const state = this.engine.setControlState({ paused, reason, routerMode });
    if (!paused) {
      const pending = this.db
        .prepare(
          `SELECT m.* FROM messages m JOIN wakeup_routes r ON r.task_id = m.task_id
           WHERE r.enabled = 1 AND m.wakeup_status = 'pending' AND m.status = 'unread'
           GROUP BY m.task_id`
        )
        .all();
      for (const message of pending) {
        this._scheduleWakeupForMessage(message);
      }
    }
    return state;
  }

  setRouterMode(args) {
    return this.engine.setRouterMode(args);
  }

  syncPolicy(args) {
    return this.engine.syncPolicy(args);
  }

  admitExecution() {
    return this.engine.admitExecution();
  }

  nextSeq() {
    return this._rawNextSeq();
  }

  getCurrentSeq() {
    return this.store.getCurrentSeq();
  }

  // ===========================================================================
  // Messaging, Subscriptions, Router Decisions & Handback
  // ===========================================================================

  sendMessage(args) {
    return this.engine.sendMessage(args);
  }

  getMessageById(id) {
    return this.engine.getMessageById(id);
  }

  readMessages(args = {}) {
    return this.engine.readMessages(args);
  }

  async waitForReply({ messageId, timeoutMs = 30000, pollIntervalMs = 400 }) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const reply = this.store.findFirstReply(messageId);
      if (reply) return reply;
      await this._waitForNextTickOrNotification(
        Math.min(pollIntervalMs, Math.max(20, deadline - Date.now()))
      );
    }
    return null;
  }

  subscribeThread(args) {
    return this.engine.subscribeThread(args);
  }

  listSubscriptions(args = {}) {
    return this.engine.listSubscriptions(args);
  }

  handback(args) {
    return this.engine.handback(args);
  }

  listRouterDecisions(args = {}) {
    return this.engine.listRouterDecisions(args);
  }

  approveRouterDecision(args) {
    const res = this.engine.approveRouterDecision(args);
    if (res.dispatchMessage?.wakeup_status === "pending") {
      this._scheduleWakeupForMessage(res.dispatchMessage);
    }
    return res;
  }

  retryTaskDelivery(args) {
    const res = this.engine.retryTaskDelivery(args);
    const route = this.getWakeupRoute(args.taskId);
    if (route && route.enabled && route.driver !== "manual" && !this.getControlState().paused) {
      try {
        ensureResidentWakeupDaemon(this.dbPath);
      } catch {
        // ignore
      }
    }
    return res;
  }

  readCard(args) {
    return this.engine.readCard(args);
  }

  getWatchdogStatus() {
    return this.watchdog.getStatus();
  }

  runWatchdogSweep(args = {}) {
    return this.watchdog.runSweep(args);
  }

  // ===========================================================================
  // Cross-Process Watcher & Wakeup Delivery Drivers
  // ===========================================================================

  _notifyLocalWaiters() {
    for (const waiter of this._localWaiters) {
      try {
        waiter();
      } catch {
        // ignore
      }
    }
  }

  _waitForNextTickOrNotification(timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._localWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(20, timeoutMs));
      this._localWaiters.add(done);
    });
  }

  startCrossProcessWatcher({
    agent = null,
    intervalMs = 350,
    onNewMessages = null,
  } = {}) {
    this._lastWatchedSeq = this.getCurrentSeq();

    const checkSqliteUpdates = () => {
      try {
        const currentSeq = this.getCurrentSeq();
        if (currentSeq <= this._lastWatchedSeq) return;
        const prevSeq = this._lastWatchedSeq;
        this._lastWatchedSeq = currentSeq;

        this._notifyLocalWaiters();

        if (typeof onNewMessages === "function") {
          const newMsgs = this.readMessages({
            toAgent: agent || "*",
            afterSeq: prevSeq,
            markAsRead: false,
            markConsumed: false,
            limit: 50,
          });
          if (newMsgs.length > 0) {
            onNewMessages(newMsgs, {
              previousCursor: prevSeq,
              currentCursor: currentSeq,
            });
          }
        }
      } catch {
        // Ignore transient SQLite busy errors during background watch
      }
    };

    if (!this._watcherTimer) {
      this._watcherTimer = setInterval(checkSqliteUpdates, intervalMs);
      if (typeof this._watcherTimer.unref === "function") {
        this._watcherTimer.unref();
      }
    }

    if (!this._fsWatcher) {
      try {
        const dbDir = path.dirname(this.dbPath);
        const dbBase = path.basename(this.dbPath);
        this._fsWatcher = fs.watch(
          dbDir,
          { persistent: false },
          (_eventType, filename) => {
            if (!filename || filename.startsWith(dbBase)) {
              checkSqliteUpdates();
            }
          }
        );
      } catch {
        // Fallback to interval timer only
      }
    }
  }

  stopCrossProcessWatcher() {
    if (this._watcherTimer) {
      clearInterval(this._watcherTimer);
      this._watcherTimer = null;
    }
    if (this._fsWatcher) {
      try {
        this._fsWatcher.close();
      } catch {
        // ignore
      }
      this._fsWatcher = null;
    }
  }

  getWakeupRoute(taskId, toAgent = null) {
    return this.engine.getWakeupRoute(taskId, toAgent);
  }

  getWakeupRoutes(taskId) { return this.engine.getWakeupRoutes(taskId); }

  configureWakeupRoute(args) {
    const route = this.engine.configureWakeupRoute(args);
    if (
      route &&
      route.enabled &&
      route.driver !== "manual" &&
      !this.getControlState().paused
    ) {
      try {
        ensureResidentWakeupDaemon(this.dbPath);
      } catch {
        // ignore
      }
    }
    return route;
  }

  recordWakeupFailure(taskId, messageIds = [], errorMsg = "wakeup_failed", toAgent = null) {
    return this.engine.recordWakeupFailure(taskId, messageIds, errorMsg, toAgent);
  }

  claimPendingWakeup(
    taskId,
    { workerPid = process.pid, includeDispatched = false, bypassCircuitBreaker = false, toAgent = null } = {}
  ) {
    return this.engine.claimPendingWakeup(taskId, {
      workerPid,
      includeDispatched,
      bypassCircuitBreaker,
      toAgent,
    });
  }

  completeWakeupDelivery(taskId, messageIds = [], options = {}) {
    return this.engine.completeWakeupDelivery(taskId, messageIds, options);
  }

  confirmWakeupDelivery(args = {}) {
    return this.engine.confirmWakeupDelivery(args);
  }

  async executeWakeupDelivery(
    taskId,
    {
      driverOverride = null,
      toAgent = null,
      workerPid = process.pid,
      includeDispatched = false,
      bypassCircuitBreaker = false,
    } = {}
  ) {
    return executeTaskWakeupDriver(this.engine, taskId, {
      driverOverride,
      toAgent,
      workerPid,
      includeDispatched,
      bypassCircuitBreaker,
    });
  }

  _scheduleWakeupForMessage(msg) {
    if (
      !msg ||
      msg.wakeup_status !== "pending" ||
      !msg.task_id ||
      this.getControlState().paused
    ) {
      return;
    }
    const route = this.getWakeupRoute(msg.task_id, msg.to_agent);
    if (!route || !route.enabled) return;

    this._notifyLocalWaiters();

    const effectiveDriver =
      process.env.BRIDGE_WAKEUP_DRIVER ||
      route.driver ||
      (process.env.BRIDGE_WAKEUP_COMMAND ? "custom_command" : null) ||
      (process.env.BRIDGE_CODEX_APP_SERVER_URL ? "app_server_ws" : null) ||
      (process.env.CODEX_BIN ? "cli_resume" : null) ||
      "host_poll";

    if (effectiveDriver === "manual") return;

    let daemonHandle = null;
    try {
      daemonHandle = ensureResidentWakeupDaemon(this.dbPath);
    } catch {
      // ignore
    }

    // If resident superagent daemon is active, it drains durable `bridge_effects` directly via fs.watch + PassesPump.
    // Fallback to one-shot `--deliver-task` only when daemon spawning is disabled or unavailable.
    if (daemonHandle) return;

    const coalesceMs = Number(
      process.env.BRIDGE_WAKEUP_COALESCE_MS ?? route.coalesce_ms ?? 800
    );
    const daemonScriptPath = fileURLToPath(
      new URL("./wakeup-daemon.mjs", import.meta.url)
    );
    try {
      const child = spawn(
        process.execPath,
        [
          daemonScriptPath,
          "--deliver-task",
          msg.task_id,
          this.dbPath,
          String(coalesceMs),
          "",
          msg.to_agent,
        ],
        {
          detached: true,
          stdio: "ignore",
          env: { ...process.env, BRIDGE_WAKEUP_TURN: "1" },
        }
      );
      child.on("error", (err) => {
        try {
          this.recordWakeupFailure(
            msg.task_id,
            [msg.id],
            err?.message || String(err),
            msg.to_agent
          );
        } catch {}
      });
      child.unref();
    } catch (err) {
      this.recordWakeupFailure(
        msg.task_id,
        [msg.id],
        err?.message || String(err)
      );
    }
  }

  // ===========================================================================
  // Tasks, Leases, Patches & Validations
  // ===========================================================================

  createTask(args) {
    return this.engine.createTask(args);
  }

  getTaskById(id) {
    return this.engine.getTaskById(id);
  }

  getMandate(taskId) {
    return this.engine.getMandate(taskId);
  }

  verifyAndBindTask(args) {
    return this.engine.verifyAndBindTask(args);
  }

  listTasks(args = {}) {
    return this.engine.listTasks(args);
  }

  claimTask(args) {
    return this.engine.claimTask(args);
  }

  updateTaskPhase(args) {
    return this.engine.updateTaskPhase(args);
  }

  completeTask(args) {
    return this.engine.completeTask(args);
  }

  updateTaskContract(args) { return this.engine.updateTaskContract(args); }
  submitTaskReceipt(args) { return this.engine.submitTaskReceipt(args); }
  acceptTaskDelivery(args) { return this.engine.acceptTaskDelivery(args); }
  answerTaskDecision(args) { return this.engine.answerTaskDecision(args); }
  processTaskContinuation(args) { return this.engine.processTaskContinuation(args); }
  signalTaskEvent(args) { return this.engine.signalTaskEvent(args); }

  getRuntimeInfo() {
    const root = new URL("../../", import.meta.url);
    const pkg = JSON.parse(fs.readFileSync(new URL("package.json", root), "utf8"));
    const manifest = new URL("release-manifest.json", root);
    const release = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, "utf8")) : {};
    const hasEvents = Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bridge_task_events'").get());
    return { version: pkg.version, releaseId: release.releaseId || null,
      protocolVersions: [1, 2], schemaVersion: hasEvents ? (this.db.prepare("PRAGMA table_info(wakeup_routes)").all().some(c => c.name === "to_agent" && c.pk > 0) ? 3 : 2) : 1,
      capabilities: ["task_contract", "task_receipt", "decision_answer", "task_handoff", "task_continuation"] };
  }

  async waitForTask({ taskId, timeoutMs = 60000, pollIntervalMs = 500 }) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const task = this.getTaskById(taskId);
      if (!task) return null;
      if (["completed", "failed", "cancelled"].includes(task.status)) {
        return task;
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    return this.getTaskById(taskId);
  }

  grantTaskLease(args) {
    return this.engine.grantTaskLease(args);
  }

  getTaskLease(taskId) {
    return this.engine.getTaskLease(taskId);
  }

  revokeTaskLease(taskId) {
    return this.engine.revokeTaskLease(taskId);
  }

  submitPatch(args) {
    return this.engine.submitPatch(args);
  }

  getPatch(patchId, options = {}) {
    return this.engine.getPatch(patchId, options);
  }

  listPatches(options = {}) {
    return this.engine.listPatches(options);
  }

  _computePatchApplyOrder(patches) {
    return computePatchApplyOrder(patches);
  }

  recordValidation(args) {
    return this.engine.recordValidation(args);
  }

  getTaskOverview(taskId) {
    return this.engine.getTaskOverview(taskId);
  }

  // ===========================================================================
  // Coalesced Cursor Polling & Active Delivery Wait
  // ===========================================================================

  async pollUpdates({
    toAgent = null,
    taskId = null,
    afterSeq = 0,
    markMessagesRead = false,
    waitMs = 0,
    settleMs = 0,
    pollIntervalMs = 300,
  }) {
    const fetchSnapshot = (shouldMarkRead = false) => {
      const messages = this.readMessages({
        toAgent: toAgent || "*",
        taskId,
        afterSeq,
        markAsRead: false,
        markConsumed: false,
        limit: 100,
      });

      const patches = this.store.listPatches({
        taskId,
        toAgent,
        afterSeq,
        includeRawContent: false,
        limit: 100,
      });

      const validations = this.store
        .listValidations({
          taskId,
          afterSeq,
          limit: 50,
          orderDesc: false,
        })
        .map(({ details, ...v }) => v);

      const pageEnd = Math.min(
        messages.length === 100 ? messages.at(-1).seq : Infinity,
        patches.length === 100 ? patches.at(-1).seq : Infinity,
        validations.length === 50 ? validations.at(-1).seq : Infinity
      );
      const pageMessages = messages.filter((m) => m.seq <= pageEnd);
      const pagePatches = patches.filter((p) => p.seq <= pageEnd);
      const pageValidations = validations.filter((v) => v.seq <= pageEnd);

      if (shouldMarkRead && pageMessages.length > 0) {
        const nowIso = new Date().toISOString();
        const mark = this.db.prepare(
          "UPDATE messages SET status = 'read', read_at = COALESCE(read_at, ?), consumed_at = COALESCE(consumed_at, ?) WHERE id = ?"
        );
        for (const m of pageMessages) {
          mark.run(nowIso, nowIso, m.id);
        }
      }

      let maxSeq = Number(afterSeq);
      for (const item of [...pageMessages, ...pagePatches, ...pageValidations]) {
        maxSeq = Math.max(maxSeq, item.seq);
      }

      return {
        hasUpdates:
          messages.length > 0 || patches.length > 0 || validations.length > 0,
        previousCursor: Number(afterSeq),
        nextCursor: maxSeq,
        messages: pageMessages,
        patches: pagePatches,
        validations: pageValidations,
        taskState: taskId
          ? (() => {
              const found = this.getTaskById(taskId);
              if (!found) return undefined;
              const { prompt, result, metadata, ...t } = found;
              return t;
            })()
          : undefined,
      };
    };

    const effectiveSettleMs = Math.max(0, Number(settleMs || 0));
    let snap = fetchSnapshot(false);
    const deadline = waitMs && waitMs > 0 ? Date.now() + waitMs : 0;

    while (!snap.hasUpdates && deadline > 0 && Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await this._waitForNextTickOrNotification(
        Math.min(pollIntervalMs, remaining)
      );
      snap = fetchSnapshot(false);
    }

    if (snap.hasUpdates && effectiveSettleMs > 0) {
      let lastSeenSeq = snap.nextCursor;
      let quietDeadline = Date.now() + effectiveSettleMs;
      const maxSettleCap =
        deadline > 0
          ? Math.min(deadline, Date.now() + effectiveSettleMs * 4)
          : Date.now() + effectiveSettleMs * 4;

      while (Date.now() < quietDeadline && Date.now() < maxSettleCap) {
        const waitSlice = Math.min(
          pollIntervalMs,
          quietDeadline - Date.now(),
          maxSettleCap - Date.now()
        );
        if (waitSlice <= 0) break;
        await this._waitForNextTickOrNotification(waitSlice);
        const latest = fetchSnapshot(false);
        if (latest.nextCursor > lastSeenSeq) {
          lastSeenSeq = latest.nextCursor;
          quietDeadline = Date.now() + effectiveSettleMs;
        }
      }
    }

    return fetchSnapshot(Boolean(markMessagesRead));
  }

  async waitForDelivery({
    taskId = null,
    toAgent = "codex",
    afterSeq = null,
    settleMs = 2500,
    timeoutMs = 600000,
    markMessagesRead = false,
    deliverToHost = false,
    confirmDelivery = false,
    receipt = null,
  } = {}) {
    let resolvedAfterSeq = afterSeq;
    const route = taskId ? this.getWakeupRoute(taskId, toAgent) : null;
    if (resolvedAfterSeq === null || resolvedAfterSeq === undefined) {
      const lastWoken = Number(route?.last_woken_seq || 0);
      let lastActiveOutbound = 0;
      if (taskId) {
        const outMsg = this.db
          .prepare(
            `SELECT COALESCE(MAX(seq), 0) AS m FROM messages WHERE task_id = ? AND from_agent = ?`
          )
          .get(taskId, toAgent);
        const outVal = this.db
          .prepare(
            `SELECT COALESCE(MAX(seq), 0) AS m FROM task_validations WHERE task_id = ? AND validator_agent = ?`
          )
          .get(taskId, toAgent);
        lastActiveOutbound = Math.max(
          Number(outMsg?.m || 0),
          Number(outVal?.m || 0)
        );
      }
      const baselineSeq = Math.max(lastWoken, lastActiveOutbound);
      const unreadParams = [toAgent, baselineSeq];
      let taskClause = "";
      if (taskId) {
        taskClause = "AND task_id = ?";
        unreadParams.push(taskId);
      }
      const minUnreadRow = this.db
        .prepare(
          `SELECT MIN(seq) AS min_seq FROM messages WHERE to_agent = ? AND status = 'unread' AND seq > ? ${taskClause}`
        )
        .get(...unreadParams);
      if (
        minUnreadRow &&
        minUnreadRow.min_seq !== null &&
        minUnreadRow.min_seq !== undefined
      ) {
        resolvedAfterSeq = Math.max(
          baselineSeq,
          Number(minUnreadRow.min_seq) - 1
        );
      } else {
        resolvedAfterSeq = this.getCurrentSeq();
      }
    }

    const pollResult = await this.pollUpdates({
      toAgent,
      taskId,
      afterSeq: resolvedAfterSeq,
      markMessagesRead,
      waitMs: timeoutMs,
      settleMs,
    });

    const inboundMessages = pollResult.messages.filter(
      (m) => toAgent === "*" || m.to_agent === toAgent || m.to_agent === "all"
    );

    let deliveryReceipt = null;
    let deliveryConfirmed = false;
    let hostDeliveryError = null;

    if (inboundMessages.length > 0 && taskId) {
      const msgIds = inboundMessages.map((m) => m.id);
      const nowIso = new Date().toISOString();

      const markDispatchedStmt = this.db.prepare(
        `UPDATE messages
         SET wakeup_status = CASE WHEN wakeup_status = 'delivered' THEN 'delivered' ELSE 'dispatched' END,
             wakeup_dispatched_at = COALESCE(wakeup_dispatched_at, ?)
         WHERE id = ?`
      );
      for (const id of msgIds) {
        markDispatchedStmt.run(nowIso, id);
      }
      this.db
        .prepare(
          `UPDATE wakeup_routes SET last_dispatched_at = ?, updated_at = ? WHERE task_id = ? AND to_agent = ?`
        )
        .run(nowIso, nowIso, taskId, toAgent);

      if (deliverToHost) {
        const execOutcome = await this.executeWakeupDelivery(taskId, {
          includeDispatched: true,
          toAgent,
        });
        if (execOutcome.delivered && execOutcome.receipt?.accepted) {
          deliveryConfirmed = true;
          deliveryReceipt = execOutcome.receipt;
        } else {
          hostDeliveryError = execOutcome.error || "host_delivery_not_accepted";
        }
      } else if (confirmDelivery && receipt) {
        const confirmOutcome = this.confirmWakeupDelivery({
          taskId,
          messageIds: msgIds,
          toAgent,
          maxSeq: pollResult.nextCursor,
          receipt,
        });
        if (confirmOutcome.confirmed) {
          deliveryConfirmed = true;
          deliveryReceipt = confirmOutcome.receipt;
        } else {
          hostDeliveryError = confirmOutcome.error;
        }
      }
    }

    const finalReceipt = [...inboundMessages]
      .reverse()
      .find((m) => m.metadata?.delivery?.final === true);
    const manifest = finalReceipt?.metadata?.delivery;
    const deliveryTask = taskId ? this.getTaskById(taskId) : null;
    const artifactDeliveryComplete = Boolean(
      deliveryTask &&
        manifest &&
        finalReceipt.from_agent === deliveryTask.assigned_to &&
        manifest.revision === deliveryTask.delivery_version &&
        Array.isArray(manifest.patchIds) &&
        manifest.patchIds.every((id) => {
          const p = this.getPatch(id, { includeRawContent: false });
          return (
            p &&
            p.taskId === taskId &&
            p.fromAgent === finalReceipt.from_agent &&
            !p.supersededBy
          );
        }) &&
        this.listPatches({ taskId, activeOnly: true }).patches.every((p) =>
          manifest.patchIds.includes(p.patchId)
        )
    );

    const refreshedRoute = taskId ? this.getWakeupRoute(taskId, toAgent) : route;
    const refreshedMessages = pollResult.messages.map(
      (m) => this.getMessageById(m.id) || m
    );

    const summaryLines = inboundMessages.map(
      (m) =>
        `- [seq=${m.seq}] (${m.from_agent} -> ${m.to_agent}) ${
          m.subject || "(no subject)"
        } [id=${m.id}]`
    );
    const patchSummaryLines = pollResult.patches.map(
      (p) =>
        `- [patch=${p.patchId}, seq=${p.seq}] (${p.artifactKind}) files=${(
          p.targetFiles || []
        ).join(", ")}`
    );

    const wakeupPrompt = pollResult.hasUpdates
      ? [
          `[MCP Active Wakeup] Passive agent delivered ${
            inboundMessages.length
          } message(s) and ${pollResult.patches.length} patch(es) (cursor ${
            pollResult.previousCursor
          } -> ${pollResult.nextCursor})${
            taskId ? ` for taskId=${taskId}` : ""
          }.`,
          ...(summaryLines.length > 0 ? ["Messages:", ...summaryLines] : []),
          ...(patchSummaryLines.length > 0
            ? ["Patches:", ...patchSummaryLines]
            : []),
          `Next step: Inspect messages/patches (already included in this wakeup payload or via bridge_read_messages / bridge_get_patch) and proceed with validation.`,
        ].join("\n")
      : null;

    return {
      ...pollResult,
      messages: refreshedMessages.map(({ content, metadata, ...m }) => ({
        ...m,
        contentPreview: String(content || "").slice(0, 240),
      })),
      artifactDeliveryComplete,
      artifactDeliveryEvidence: artifactDeliveryComplete
        ? "sender_final_manifest_and_artifacts"
        : "partial_or_no_final_manifest",
      artifactReceiptMessageId: finalReceipt?.id || null,
      wokenUp: deliveryConfirmed,
      updatesReceived: pollResult.hasUpdates,
      delivered: deliveryConfirmed,
      deliveryState: deliveryConfirmed
        ? "delivered_confirmed"
        : pollResult.hasUpdates
          ? "updates_received"
          : "idle",
      deliveryReceipt,
      hostDeliveryError,
      coalescedSettleMs: settleMs,
      wakeupRoute: refreshedRoute,
      route: refreshedRoute,
      wakeupPrompt,
      hostForwardAction:
        pollResult.hasUpdates && refreshedRoute?.target_session_id
          ? {
              recommendedTool: "send_message_to_thread",
              targetSessionId: refreshedRoute.target_session_id,
              threadId: refreshedRoute.thread_id,
              message: wakeupPrompt,
              arguments: {
                threadId: refreshedRoute.target_session_id,
                prompt: wakeupPrompt,
              },
            }
          : null,
    };
  }

  // ===========================================================================
  // Shared Context, Session History & Bridge Summary
  // ===========================================================================

  setContext(args) {
    return this.engine.setContext(args);
  }

  getContext(key) {
    return this.engine.getContext(key);
  }

  listContext() {
    return this.engine.listContext();
  }

  recordSession(args) {
    return this.engine.recordSession(args);
  }

  getLatestSession(agent) {
    return this.engine.getLatestSession(agent);
  }

  listSessions(agent = null, limit = 20) {
    return this.engine.listSessions(agent, limit);
  }

  getSummaryStats() {
    return this.store.getSummaryStats();
  }
}
