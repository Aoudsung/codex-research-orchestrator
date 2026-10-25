import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { verifyModelMatch } from "./preflight.mjs";
import { sha256Hex } from "./patch-validator.mjs";
import { resolveBinary, runCommand } from "./process-runner.mjs";
import {
  deliverViaAppServerWs,
  deliverViaCodexIpcSocket,
} from "./codex-host-driver.mjs";
import { ensureResidentWakeupDaemon } from "./wakeup-daemon.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");

export const PHASE_LABELS = {
  pending_preflight: "Awaiting preflight",
  ready: "Ready",
  in_progress: "In progress",
  cli_turn_ended: "CLI turn ended (delivery unconfirmed)",
  patch_delivered: "Patch delivered",
  awaiting_validation: "Delivered / awaiting validation",
  validation_failed: "Validation failed",
  awaiting_revision: "Awaiting revision",
  awaiting_review: "Awaiting review",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

/**
 * Resolve the shared SQLite database path.
 */
export function resolveBridgeDbPath() {
  if (process.env.AGENT_BRIDGE_DB) {
    return path.resolve(process.env.AGENT_BRIDGE_DB);
  }
  throw new Error("AGENT_BRIDGE_DB must name a caller-configured shared database path.");
}

export class BridgeDatabase {
  /**
   * @param {string} [dbPath]
   */
  constructor(dbPath = resolveBridgeDbPath()) {
    this.dbPath = dbPath;
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath, { timeout: 10000 });
    this.onMessageSent = null;
    this._localWaiters = new Set();
    this._watcherTimer = null;
    this._fsWatcher = null;
    this._lastWatchedSeq = 0;
    this._initSchema();
  }

  _initSchema() {
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        this.db.exec(`PRAGMA busy_timeout = 10000;`);
        this.db.exec(`
          PRAGMA journal_mode = WAL;
          PRAGMA synchronous = NORMAL;

          CREATE TABLE IF NOT EXISTS bridge_counters (
            name TEXT PRIMARY KEY,
            value INTEGER NOT NULL
          );

          CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            seq INTEGER NOT NULL DEFAULT 0,
            thread_id TEXT NOT NULL,
            task_id TEXT DEFAULT NULL,
            from_agent TEXT NOT NULL,
            to_agent TEXT NOT NULL,
            subject TEXT DEFAULT '',
            content TEXT NOT NULL,
            reply_to TEXT DEFAULT NULL,
            metadata_json TEXT DEFAULT '{}',
            status TEXT NOT NULL DEFAULT 'unread',
            created_at TEXT NOT NULL,
            read_at TEXT DEFAULT NULL
          );

          CREATE INDEX IF NOT EXISTS idx_messages_to_status
            ON messages(to_agent, status, created_at);
          CREATE INDEX IF NOT EXISTS idx_messages_thread
            ON messages(thread_id, created_at);
          CREATE INDEX IF NOT EXISTS idx_messages_reply_to
            ON messages(reply_to);

          CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            from_agent TEXT NOT NULL,
            assigned_to TEXT NOT NULL,
            title TEXT NOT NULL,
            prompt TEXT NOT NULL,
            cwd TEXT DEFAULT '',
            priority TEXT NOT NULL DEFAULT 'normal',
            status TEXT NOT NULL DEFAULT 'pending',
            phase TEXT NOT NULL DEFAULT 'ready',
            phase_label TEXT NOT NULL DEFAULT 'Ready',
            required_model TEXT DEFAULT NULL,
            actual_model TEXT DEFAULT NULL,
            required_conversation_id TEXT DEFAULT NULL,
            bound_conversation_id TEXT DEFAULT NULL,
            delivery_version INTEGER NOT NULL DEFAULT 0,
            permissions_json TEXT DEFAULT '{}',
            lease_status TEXT NOT NULL DEFAULT 'none',
            result TEXT DEFAULT NULL,
            error TEXT DEFAULT NULL,
            session_id TEXT DEFAULT NULL,
            metadata_json TEXT DEFAULT '{}',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            completed_at TEXT DEFAULT NULL
          );

          CREATE INDEX IF NOT EXISTS idx_tasks_assigned_status
            ON tasks(assigned_to, status, created_at);

          CREATE TABLE IF NOT EXISTS patches (
            patch_id TEXT PRIMARY KEY,
            seq INTEGER NOT NULL DEFAULT 0,
            task_id TEXT NOT NULL,
            from_agent TEXT NOT NULL,
            to_agent TEXT NOT NULL,
            conversation_id TEXT DEFAULT NULL,
            model TEXT DEFAULT NULL,
            artifact_kind TEXT NOT NULL DEFAULT 'unified_diff',
            raw_content TEXT NOT NULL,
            sha256 TEXT NOT NULL,
            depends_on_json TEXT NOT NULL DEFAULT '[]',
            supersedes TEXT DEFAULT NULL,
            superseded_by TEXT DEFAULT NULL,
            target_files_json TEXT NOT NULL DEFAULT '[]',
            validation_json TEXT NOT NULL DEFAULT '{}',
            status TEXT NOT NULL DEFAULT 'submitted',
            summary TEXT DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            applied_at TEXT DEFAULT NULL
          );

          CREATE INDEX IF NOT EXISTS idx_patches_task
            ON patches(task_id, seq);

          CREATE TABLE IF NOT EXISTS task_leases (
            task_id TEXT PRIMARY KEY,
            agent TEXT NOT NULL,
            permissions_json TEXT NOT NULL DEFAULT '{}',
            preflight_json TEXT NOT NULL DEFAULT '{}',
            status TEXT NOT NULL DEFAULT 'active',
            granted_at TEXT NOT NULL,
            revoked_at TEXT DEFAULT NULL
          );

          CREATE TABLE IF NOT EXISTS task_validations (
            id TEXT PRIMARY KEY,
            seq INTEGER NOT NULL DEFAULT 0,
            task_id TEXT NOT NULL,
            validator_agent TEXT NOT NULL,
            patch_ids_json TEXT NOT NULL DEFAULT '[]',
            applied INTEGER NOT NULL DEFAULT 0,
            passed INTEGER DEFAULT NULL,
            summary TEXT NOT NULL DEFAULT '',
            details_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL
          );

          CREATE INDEX IF NOT EXISTS idx_task_validations_task
            ON task_validations(task_id, seq);

          CREATE TABLE IF NOT EXISTS shared_context (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            content_type TEXT NOT NULL DEFAULT 'text/plain',
            updated_by TEXT NOT NULL,
            description TEXT DEFAULT '',
            updated_at TEXT NOT NULL
          );

          CREATE TABLE IF NOT EXISTS agent_sessions (
            session_key TEXT PRIMARY KEY,
            agent TEXT NOT NULL,
            external_session_id TEXT DEFAULT NULL,
            model TEXT DEFAULT NULL,
            cwd TEXT DEFAULT '',
            summary TEXT DEFAULT '',
            last_prompt TEXT DEFAULT '',
            last_response TEXT DEFAULT '',
            updated_at TEXT NOT NULL
          );

          CREATE INDEX IF NOT EXISTS idx_agent_sessions_agent
            ON agent_sessions(agent, updated_at);

          CREATE TABLE IF NOT EXISTS wakeup_routes (
            task_id TEXT PRIMARY KEY,
            thread_id TEXT NOT NULL,
            to_agent TEXT NOT NULL,
            target_session_id TEXT NOT NULL,
            driver TEXT NOT NULL DEFAULT 'host_poll',
            wakeup_command TEXT DEFAULT NULL,
            app_server_url TEXT DEFAULT NULL,
            cwd TEXT DEFAULT '',
            enabled INTEGER NOT NULL DEFAULT 1,
            in_flight INTEGER NOT NULL DEFAULT 0,
            worker_pid INTEGER DEFAULT NULL,
            last_woken_seq INTEGER NOT NULL DEFAULT 0,
            last_dispatched_at TEXT DEFAULT NULL,
            last_delivered_at TEXT DEFAULT NULL,
            last_receipt_json TEXT DEFAULT NULL,
            last_turn_id TEXT DEFAULT NULL,
            last_handled_by_client_id TEXT DEFAULT NULL,
            last_error TEXT DEFAULT NULL,
            updated_at TEXT NOT NULL
          );
        `);

        this._migrateExistingTables();
        break;
      } catch (err) {
        if (attempt === 19) throw err;
        try {
          Atomics.wait(
            new Int32Array(new SharedArrayBuffer(4)),
            0,
            0,
            40 * (attempt + 1)
          );
        } catch {
          // ignore
        }
      }
    }
  }

  /**
   * Non-destructively upgrade pre-existing SQLite databases with new columns and backfill metadata.
   */
  _migrateExistingTables() {
    const addColIfMissing = (table, colName, colDef) => {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all();
      if (!cols.some((c) => c.name === colName)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${colName} ${colDef}`);
      }
    };

    addColIfMissing("messages", "seq", "INTEGER NOT NULL DEFAULT 0");
    addColIfMissing("messages", "task_id", "TEXT DEFAULT NULL");
    addColIfMissing("messages", "wakeup_status", "TEXT NOT NULL DEFAULT 'none'");
    addColIfMissing("messages", "wakeup_target_session", "TEXT DEFAULT NULL");
    addColIfMissing("messages", "wakeup_dispatched_at", "TEXT DEFAULT NULL");
    addColIfMissing("messages", "wakeup_delivered_at", "TEXT DEFAULT NULL");
    addColIfMissing("messages", "wakeup_receipt_json", "TEXT DEFAULT NULL");
    addColIfMissing("messages", "processed_at", "TEXT DEFAULT NULL");
    addColIfMissing("messages", "wakeup_error", "TEXT DEFAULT NULL");
    addColIfMissing("wakeup_routes", "worker_pid", "INTEGER DEFAULT NULL");
    addColIfMissing("wakeup_routes", "driver", "TEXT NOT NULL DEFAULT 'host_poll'");
    addColIfMissing("wakeup_routes", "wakeup_command", "TEXT DEFAULT NULL");
    addColIfMissing("wakeup_routes", "app_server_url", "TEXT DEFAULT NULL");
    addColIfMissing("wakeup_routes", "last_receipt_json", "TEXT DEFAULT NULL");
    addColIfMissing("wakeup_routes", "last_turn_id", "TEXT DEFAULT NULL");
    addColIfMissing("wakeup_routes", "last_handled_by_client_id", "TEXT DEFAULT NULL");
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_messages_seq ON messages(seq)`
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_messages_task ON messages(task_id, seq)`
    );

    addColIfMissing("tasks", "phase", "TEXT NOT NULL DEFAULT 'ready'");
    addColIfMissing("tasks", "phase_label", "TEXT NOT NULL DEFAULT 'Ready'");
    addColIfMissing("tasks", "required_model", "TEXT DEFAULT NULL");
    addColIfMissing("tasks", "actual_model", "TEXT DEFAULT NULL");
    addColIfMissing("tasks", "required_conversation_id", "TEXT DEFAULT NULL");
    addColIfMissing("tasks", "bound_conversation_id", "TEXT DEFAULT NULL");
    addColIfMissing("tasks", "delivery_version", "INTEGER NOT NULL DEFAULT 0");
    addColIfMissing("tasks", "permissions_json", "TEXT DEFAULT '{}'");
    addColIfMissing("tasks", "lease_status", "TEXT NOT NULL DEFAULT 'none'");

    addColIfMissing("agent_sessions", "model", "TEXT DEFAULT NULL");

    // Initialize global event sequence counter and backfill seq=0 messages if any
    const unassignedMessages = this.db
      .prepare(
        `SELECT id, metadata_json FROM messages WHERE seq = 0 ORDER BY created_at ASC`
      )
      .all();

    const maxMsgSeq =
      this.db.prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM messages`).get()
        ?.m || 0;
    const maxPatchSeq =
      this.db.prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM patches`).get()
        ?.m || 0;
    const initialMax = Math.max(maxMsgSeq, maxPatchSeq);

    this.db
      .prepare(
        `INSERT INTO bridge_counters (name, value) VALUES ('event_seq', ?)
         ON CONFLICT(name) DO UPDATE SET value = MAX(bridge_counters.value, excluded.value)`
      )
      .run(initialMax);

    if (unassignedMessages.length > 0) {
      const updateMsgStmt = this.db.prepare(
        `UPDATE messages SET seq = ?, task_id = COALESCE(task_id, ?) WHERE id = ?`
      );
      for (const m of unassignedMessages) {
        const seq = this.nextSeq();
        let taskId = null;
        try {
          const meta = JSON.parse(m.metadata_json || "{}");
          taskId = meta.taskId || null;
        } catch {
          // ignore
        }
        updateMsgStmt.run(seq, taskId, m.id);
      }
    }

    // Backfill task binding columns from metadata_json for pre-existing tasks
    const existingTasks = this.db
      .prepare(
        `SELECT id, status, phase, required_model, required_conversation_id, metadata_json FROM tasks`
      )
      .all();
    const updateTaskMetaStmt = this.db.prepare(
      `UPDATE tasks
       SET required_model = COALESCE(required_model, ?),
           required_conversation_id = COALESCE(required_conversation_id, ?),
           bound_conversation_id = COALESCE(bound_conversation_id, ?),
           permissions_json = CASE WHEN permissions_json = '{}' OR permissions_json IS NULL THEN ? ELSE permissions_json END,
           phase = ?,
           phase_label = ?
       WHERE id = ?`
    );

    for (const t of existingTasks) {
      let meta = {};
      try {
        meta = JSON.parse(t.metadata_json || "{}");
      } catch {
        meta = {};
      }
      const reqModel = t.required_model || meta.requiredModel || meta.model || null;
      const reqConv =
        t.required_conversation_id ||
        meta.requiredConversationId ||
        meta.conversationId ||
        null;
      const perms = {};
      if (Array.isArray(meta.writeRoots)) perms.writeRoots = meta.writeRoots;
      if (Array.isArray(meta.readRoots)) perms.readRoots = meta.readRoots;

      let phase = t.phase || "ready";
      if (t.status === "completed") phase = "completed";
      else if (t.status === "failed") phase = "failed";
      else if (t.status === "in_progress" && phase === "ready") phase = "in_progress";

      updateTaskMetaStmt.run(
        reqModel,
        reqConv,
        reqConv,
        JSON.stringify(perms),
        phase,
        PHASE_LABELS[phase] || phase,
        t.id
      );
    }

    // Non-destructively backfill legacy patch messages into `patches` table on first v1.1 migration
    if (unassignedMessages.length > 0) {
      const patchMessages = this.db
        .prepare(
          `SELECT id, seq, from_agent, to_agent, content, subject, metadata_json, created_at FROM messages ORDER BY seq ASC`
        )
        .all();

      const insertLegacyPatch = this.db.prepare(
        `INSERT OR IGNORE INTO patches (
          patch_id, seq, task_id, from_agent, to_agent, conversation_id, model,
          artifact_kind, raw_content, sha256, depends_on_json, supersedes, superseded_by,
          target_files_json, validation_json, status, summary, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, NULL, '[]', '{}', 'submitted', ?, ?, ?)`
      );
      const markSupersededStmt = this.db.prepare(
        `UPDATE patches SET status = 'superseded', superseded_by = ? WHERE patch_id = ? AND task_id = ?`
      );

      for (const pm of patchMessages) {
        let meta = {};
        try {
          meta = JSON.parse(pm.metadata_json || "{}");
        } catch {
          continue;
        }
        if (
          meta.patchId &&
          meta.taskId &&
          (meta.artifactKind === "unified_diff" ||
            meta.artifactKind === "baseline_copy")
        ) {
          const resolvedTo =
            pm.to_agent === pm.from_agent ? "codex" : pm.to_agent;
          insertLegacyPatch.run(
            meta.patchId,
            pm.seq || this.nextSeq(),
            meta.taskId,
            pm.from_agent,
            resolvedTo,
            meta.conversationId || null,
            meta.model || null,
            meta.artifactKind,
            pm.content,
            sha256Hex(pm.content),
            meta.supersedes || null,
            pm.subject || "",
            pm.created_at,
            pm.created_at
          );
          if (meta.supersedes) {
            markSupersededStmt.run(meta.patchId, meta.supersedes, meta.taskId);
          }
          if (meta.model) {
            this.db
              .prepare(
                `UPDATE tasks SET actual_model = COALESCE(actual_model, ?), delivery_version = (SELECT COUNT(*) FROM patches WHERE task_id = ?) WHERE id = ?`
              )
              .run(meta.model, meta.taskId, meta.taskId);
          }
        } else if (meta.taskId && meta.artifactKind === "validation_feedback") {
          this.db
            .prepare(
              `UPDATE tasks SET phase = 'awaiting_revision', phase_label = ? WHERE id = ? AND status = 'in_progress'`
            )
            .run(PHASE_LABELS.awaiting_revision, meta.taskId);
        }
        if (
          meta.taskId &&
          (meta.artifactKind === "unified_diff" ||
            meta.artifactKind === "baseline_copy" ||
            meta.artifactKind === "validation_handoff")
        ) {
          this.db
            .prepare(
              `UPDATE tasks SET phase = 'awaiting_validation', phase_label = ? WHERE id = ? AND status = 'in_progress'`
            )
            .run(PHASE_LABELS.awaiting_validation, meta.taskId);
        }
      }
    }
  }

  /**
   * Atomically allocate the next monotonic cursor sequence number.
   */
  _atomicEvent(work) {
    if (this._eventNotifications) return work();
    this.db.exec("BEGIN IMMEDIATE");
    this._eventNotifications = [];
    let result;
    let notifications;
    try {
      result = work();
      this.db.exec("COMMIT");
      notifications = this._eventNotifications;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this._eventNotifications = null;
    }
    for (const notify of notifications) notify();
    return result;
  }

  nextSeq() {
    const row = this.db
      .prepare(
        `INSERT INTO bridge_counters (name, value) VALUES ('event_seq', 1)
         ON CONFLICT(name) DO UPDATE SET value = bridge_counters.value + 1 RETURNING value`
      )
      .get();
    return Number(row.value);
  }

  getCurrentSeq() {
    const row = this.db
      .prepare(`SELECT value FROM bridge_counters WHERE name = 'event_seq'`)
      .get();
    return Number(row?.value || 0);
  }

  // ===========================================================================
  // Messaging API (with strict routing, replyTo inheritance, receipt & seq cursor)
  // ===========================================================================

  /**
   * Send a message from one agent to another (or 'all').
   * Enforces explicit recipient or replyTo inheritance, blocks accidental self-send,
   * and assigns a monotonic `seq` cursor.
   */
  sendMessage(args) {
    return this._atomicEvent(() => this._sendMessage(args));
  }

  _sendMessage({
    fromAgent,
    toAgent = null,
    content,
    subject = "",
    threadId = null,
    taskId = null,
    replyTo = null,
    metadata = {},
    allowSelfSend = false,
  }) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    let resolvedToAgent = toAgent;
    let resolvedThreadId = threadId;
    let resolvedTaskId = taskId || metadata?.taskId || null;
    let resolvedSubject = subject;
    let inheritedFromReplyTo = false;

    if (replyTo) {
      const parent = this.getMessageById(replyTo);
      if (!parent) {
        const err = new Error(`Parent message for replyTo not found: ${replyTo}`);
        err.code = "REPLY_TARGET_NOT_FOUND";
        throw err;
      }
      if (!resolvedToAgent) {
        resolvedToAgent = parent.from_agent;
        inheritedFromReplyTo = true;
      }
      if (!resolvedThreadId) {
        resolvedThreadId = parent.thread_id;
      }
      if (!resolvedTaskId) {
        resolvedTaskId = parent.task_id || parent.metadata?.taskId || null;
      }
      if (!resolvedSubject && parent.subject) {
        resolvedSubject = parent.subject.startsWith("Re:")
          ? parent.subject
          : `Re: ${parent.subject}`;
      }
      this.db
        .prepare(
          `UPDATE messages SET status = 'replied', read_at = COALESCE(read_at, ?), processed_at = COALESCE(processed_at, ?) WHERE id = ?`
        )
        .run(now, now, replyTo);
    }

    if (!resolvedToAgent) {
      const err = new Error(
        "Missing recipient: you must explicitly specify 'toAgent' (e.g. 'codex', 'antigravity', 'claude-code') or 'replyTo' to inherit the recipient from an existing message. Silent default routing is disabled."
      );
      err.code = "MISSING_RECIPIENT";
      throw err;
    }

    if (
      !allowSelfSend &&
      fromAgent &&
      resolvedToAgent === fromAgent
    ) {
      const err = new Error(
        `Self-routing blocked: fromAgent ('${fromAgent}') and toAgent ('${resolvedToAgent}') are identical. Specify the peer recipient explicitly (e.g. 'toAgent: "codex"') or use 'bridge_reply_message' with 'replyTo'.`
      );
      err.code = "SELF_ROUTING_REJECTED";
      throw err;
    }

    const matchedRoute = resolvedTaskId
      ? this.getWakeupRoute(resolvedTaskId)
      : null;

    if (!resolvedThreadId) {
      resolvedThreadId =
        matchedRoute?.thread_id ||
        (resolvedTaskId ? `task-${resolvedTaskId}` : id);
    }

    const seq = this.nextSeq();
    const enrichedMeta = {
      ...(metadata || {}),
      ...(resolvedTaskId ? { taskId: resolvedTaskId } : {}),
    };

    if (resolvedTaskId && fromAgent) {
      this.db
        .prepare(
          `UPDATE messages SET processed_at = COALESCE(processed_at, ?) WHERE task_id = ? AND to_agent = ? AND status = 'read'`
        )
        .run(now, resolvedTaskId, fromAgent);
    }

    let wakeupStatus = "none";
    let wakeupTargetSession = null;
    if (
      resolvedTaskId &&
      fromAgent !== resolvedToAgent &&
      !enrichedMeta.isWakeupNotification &&
      !enrichedMeta.suppressWakeup
    ) {
      const route = matchedRoute;
      if (route && route.enabled && route.to_agent === resolvedToAgent) {
        if (
          process.env.BRIDGE_WAKEUP_TURN === "1" ||
          process.env.BRIDGE_DISABLE_CLI_WAKEUP === "1"
        ) {
          wakeupStatus = "skipped_wakeup_guard";
        } else {
          wakeupStatus = "pending";
        }
        wakeupTargetSession = route.target_session_id;
      }
    }

    this.db
      .prepare(
        `INSERT INTO messages (
          id, seq, thread_id, task_id, from_agent, to_agent, subject, content, reply_to, metadata_json, status,
          wakeup_status, wakeup_target_session, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unread', ?, ?, ?)`
      )
      .run(
        id,
        seq,
        resolvedThreadId,
        resolvedTaskId,
        fromAgent,
        resolvedToAgent,
        resolvedSubject || "",
        content,
        replyTo,
        JSON.stringify(enrichedMeta),
        wakeupStatus,
        wakeupTargetSession,
        now
      );

    // If message carries validation_feedback metadata, automatically transition task phase accordingly
    if (resolvedTaskId && enrichedMeta.artifactKind === "validation_feedback") {
      this.updateTaskPhase({
        taskId: resolvedTaskId,
        phase:
          enrichedMeta.passed === true
            ? "awaiting_review"
            : "awaiting_revision",
      });
    } else if (resolvedTaskId && enrichedMeta.applied === false) {
      this.updateTaskPhase({
        taskId: resolvedTaskId,
        phase: "awaiting_revision",
      });
    } else if (
      resolvedTaskId &&
      enrichedMeta.artifactKind === "validation_handoff"
    ) {
      this.updateTaskPhase({
        taskId: resolvedTaskId,
        phase: "awaiting_validation",
      });
    }

    const saved = this.getMessageById(id);
    this._eventNotifications.push(() => {
      this._notifyLocalWaiters();
      if (typeof this.onMessageSent === "function") {
        try {
          this.onMessageSent(saved);
        } catch {
          // The durable event remains available if a notification listener fails.
        }
      }
      if (saved.wakeup_status === "pending") this._scheduleWakeupForMessage(saved);
    });
    return {
      ...saved,
      inheritedFromReplyTo,
    };
  }

  /**
   * Retrieve a single message by ID.
   */
  getMessageById(id) {
    const row = this.db
      .prepare(`SELECT * FROM messages WHERE id = ?`)
      .get(id);
    return row ? this._deserializeMessage(row) : null;
  }

  /**
   * Read messages for a target agent, supporting incremental cursor (`afterSeq`) and `taskId` filtering.
   */
  readMessages({
    toAgent,
    fromAgent = null,
    threadId = null,
    taskId = null,
    afterSeq = null,
    unreadOnly = false,
    markAsRead = true,
    limit = 50,
  }) {
    const conditions = [];
    const params = [];

    if (toAgent && toAgent !== "*") {
      conditions.push(`(to_agent = ? OR to_agent = 'all')`);
      params.push(toAgent);
    }
    if (fromAgent) {
      conditions.push(`from_agent = ?`);
      params.push(fromAgent);
    }
    if (threadId) {
      conditions.push(`thread_id = ?`);
      params.push(threadId);
    }
    if (taskId) {
      conditions.push(`task_id = ?`);
      params.push(taskId);
    }
    if (afterSeq !== null && afterSeq !== undefined) {
      conditions.push(`seq > ?`);
      params.push(Number(afterSeq));
    }
    if (unreadOnly) {
      conditions.push(`status = 'unread'`);
    }

    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const orderDirection =
      afterSeq !== null && afterSeq !== undefined ? "ASC" : "DESC";

    let rows = this.db
      .prepare(
        `SELECT * FROM messages ${whereClause} ORDER BY seq ${orderDirection} LIMIT ?`
      )
      .all(...params, limit);

    if (orderDirection === "DESC") {
      rows = rows.reverse();
    }

    if (markAsRead && rows.length > 0) {
      const now = new Date().toISOString();
      const updateStmt = this.db.prepare(
        `UPDATE messages
         SET status = CASE WHEN status = 'unread' THEN 'read' ELSE status END,
             read_at = COALESCE(read_at, ?),
             wakeup_status = CASE WHEN wakeup_status = 'pending' THEN 'skipped_already_read' ELSE wakeup_status END
         WHERE id = ?`
      );

      for (const row of rows) {
        if (row.status === "unread") {
          updateStmt.run(now, row.id);
          row.status = "read";
          row.read_at = now;
          if (row.wakeup_status === "pending") {
            row.wakeup_status = "skipped_already_read";
          }

        }
      }
    }

    return rows.map((r) => this._deserializeMessage(r));
  }

  /**
   * Wait for a reply to a specific message ID.
   */
  async waitForReply({ messageId, timeoutMs = 30000, pollIntervalMs = 400 }) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const reply = this.db
        .prepare(
          `SELECT * FROM messages WHERE reply_to = ? ORDER BY seq ASC LIMIT 1`
        )
        .get(messageId);
      if (reply) {
        return this._deserializeMessage(reply);
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    return null;
  }

  _deserializeMessage(row) {
    let metadata = {};
    try {
      metadata = JSON.parse(row.metadata_json || "{}");
    } catch {
      metadata = {};
    }
    let wakeupReceipt = null;
    if (row.wakeup_receipt_json) {
      try {
        wakeupReceipt = JSON.parse(row.wakeup_receipt_json);
      } catch {
        wakeupReceipt = null;
      }
    }
    return {
      id: row.id,
      seq: Number(row.seq || 0),
      thread_id: row.thread_id,
      task_id: row.task_id || metadata.taskId || null,
      from_agent: row.from_agent,
      to_agent: row.to_agent,
      subject: row.subject,
      content: row.content,
      reply_to: row.reply_to,
      metadata,
      status: row.status,
      wakeup_status: row.wakeup_status || "none",
      wakeup_target_session: row.wakeup_target_session || null,
      wakeup_dispatched_at: row.wakeup_dispatched_at || null,
      wakeup_delivered_at: row.wakeup_delivered_at || null,
      wakeup_receipt: wakeupReceipt,
      processed_at: row.processed_at || null,
      wakeup_error: row.wakeup_error || null,
      created_at: row.created_at,
      read_at: row.read_at,
      replyHint: {
        tool: "bridge_reply_message",
        arguments: {
          replyTo: row.id,
          content: "<your reply>",
        },
      },
    };
  }

  _notifyLocalWaiters() {
    for (const waiter of this._localWaiters) {
      try {
        waiter();
      } catch {
        // ignore
      }
    }
  }

  /**
   * Start a cross-process SQLite watcher so this MCP server process immediately detects
   * messages, patches, and validations written by peer MCP/CLI processes into the shared SQLite file.
   */
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

        // Wake up any local blocking pollUpdates / waitForDelivery / waitForReply promises immediately
        this._notifyLocalWaiters();

        if (typeof onNewMessages === "function") {
          const newMsgs = this.readMessages({
            toAgent: agent || "*",
            afterSeq: prevSeq,
            markAsRead: false,
            limit: 50,
          });
          if (newMsgs.length > 0) {
            onNewMessages(newMsgs, { previousCursor: prevSeq, currentCursor: currentSeq });
          }
        }
      } catch {
        // Ignore transient SQLite lock errors during background watch
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
        this._fsWatcher = fs.watch(dbDir, { persistent: false }, (_eventType, filename) => {
          if (!filename || filename.startsWith(dbBase)) {
            checkSqliteUpdates();
          }
        });
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
      } catch {}
      this._fsWatcher = null;
    }
  }

  _isPidAlive(pid) {
    const num = Number(pid);
    if (!Number.isInteger(num) || num <= 0) return false;
    try {
      process.kill(num, 0);
      return true;
    } catch (err) {
      return err?.code === "EPERM";
    }
  }

  getWakeupRoute(taskId) {
    if (!taskId) return null;
    const row =
      this.db
        .prepare(`SELECT * FROM wakeup_routes WHERE task_id = ?`)
        .get(taskId) || null;
    if (!row) return null;
    let lastReceipt = null;
    if (row.last_receipt_json) {
      try {
        lastReceipt = JSON.parse(row.last_receipt_json);
      } catch {
        lastReceipt = null;
      }
    }
    return {
      ...row,
      last_receipt: lastReceipt,
    };
  }

  /**
   * Configure or update the active wakeup route for a task.
   * Supported drivers:
   * - 'codex_ipc': Connects to `~/.codex/ipc/ipc.sock`, discovers the live Desktop thread owner (`thread-owner-discovery`), starts a new turn (`thread-follower-start-turn` / `thread-follower-steer-turn`), and confirms delivery ONLY after receiving a `turn.id` acceptance receipt.
   * - 'host_poll': (Alias / hybrid for Codex Desktop sessions) Supports in-turn coalesced waiting (`bridge_wait_for_delivery`) AND automatically executes `codex_ipc` / `app_server_ws` host turn-start when the chat is idle or unconfirmed.
   * - 'app_server_ws': Sends JSON-RPC `initialize` -> `initialized` -> `turn/start` to a Codex `app-server` listening on `appServerUrl` (`ws://127.0.0.1:<port>` or `unix:///path/to/sock`) and confirms delivery ONLY upon receiving `result.turn.id`.
   * - 'custom_command': Runs `wakeupCommand` (or `BRIDGE_WAKEUP_COMMAND`) with message/task metadata in env.
   * - 'cli_resume': Spawns `codex exec resume <target_session_id>` (auto-switches to `codex_ipc` and delivers via IPC on `-32600` active-writer conflict).
   * - 'manual': Disables automatic host wakeup execution.
   */
  configureWakeupRoute({
    taskId,
    threadId = null,
    toAgent = "codex",
    targetSessionId,
    driver = "host_poll",
    wakeupCommand = null,
    appServerUrl = null,
    cwd = "",
    enabled = true,
  }) {
    if (!taskId) {
      throw new Error("taskId is required to configure a wakeup route.");
    }
    const existing = this.getWakeupRoute(taskId);
    const nowIso = new Date().toISOString();
    const resolvedThreadId =
      threadId || existing?.thread_id || `example-${taskId}`;
    const resolvedTargetSession =
      targetSessionId || existing?.target_session_id || "";
    const resolvedDriver =
      driver || existing?.driver || "host_poll";
    const resolvedCwd = cwd || existing?.cwd || process.cwd();
    const resolvedEnabled = enabled !== undefined ? (enabled ? 1 : 0) : (existing?.enabled ?? 1);

    this.db
      .prepare(
        `INSERT INTO wakeup_routes (
          task_id, thread_id, to_agent, target_session_id, driver, wakeup_command, app_server_url, cwd, enabled, in_flight, worker_pid, last_woken_seq, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 0, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          thread_id = excluded.thread_id,
          to_agent = excluded.to_agent,
          target_session_id = CASE WHEN excluded.target_session_id != '' THEN excluded.target_session_id ELSE wakeup_routes.target_session_id END,
          driver = excluded.driver,
          wakeup_command = COALESCE(excluded.wakeup_command, wakeup_routes.wakeup_command),
          app_server_url = COALESCE(excluded.app_server_url, wakeup_routes.app_server_url),
          cwd = CASE WHEN excluded.cwd != '' THEN excluded.cwd ELSE wakeup_routes.cwd END,
          enabled = excluded.enabled,
          updated_at = excluded.updated_at`
      )
      .run(
        taskId,
        resolvedThreadId,
        toAgent,
        resolvedTargetSession,
        resolvedDriver,
        wakeupCommand,
        appServerUrl,
        resolvedCwd,
        resolvedEnabled,
        nowIso
      );

    if (resolvedEnabled && resolvedDriver !== "manual") {
      try {
        ensureResidentWakeupDaemon(this.dbPath);
      } catch {
        // ignore
      }
    }

    return this.getWakeupRoute(taskId);
  }

  recordWakeupFailure(taskId, messageIds = [], errorMsg = "wakeup_failed") {
    const nowIso = new Date().toISOString();
    const errText = String(errorMsg || "wakeup_failed");
    if (Array.isArray(messageIds) && messageIds.length > 0) {
      const stmt = this.db.prepare(
        `UPDATE messages SET wakeup_status = 'failed', wakeup_error = ? WHERE id = ?`
      );
      for (const id of messageIds) {
        stmt.run(errText, id);
      }
    } else if (taskId) {
      this.db
        .prepare(
          `UPDATE messages SET wakeup_status = 'failed', wakeup_error = ?
           WHERE task_id = ? AND wakeup_status IN ('pending', 'dispatched')`
        )
        .run(errText, taskId);
    }
    if (taskId) {
      this.db
        .prepare(
          `UPDATE wakeup_routes
           SET in_flight = 0, worker_pid = NULL, last_error = ?, updated_at = ?
           WHERE task_id = ?`
        )
        .run(errText, nowIso, taskId);
    }
  }

  /**
   * Atomically claim pending unread wakeup messages for `taskId` under a PID-checked single-flight lock.
   */
  claimPendingWakeup(
    taskId,
    { workerPid = process.pid, includeDispatched = false } = {}
  ) {
    const route = this.getWakeupRoute(taskId);
    if (!route || !route.enabled) {
      return { claimed: false, reason: "route_disabled_or_missing" };
    }
    const nowIso = new Date().toISOString();

    if (route.in_flight === 1) {
      const holderPid = Number(route.worker_pid || 0);
      if (holderPid > 0 && holderPid !== Number(workerPid) && this._isPidAlive(holderPid)) {
        return {
          claimed: false,
          reason: "already_in_flight",
          holderPid,
        };
      }
      // Lock holder PID is dead or missing: recover any orphaned 'dispatched' unread messages back to 'pending'
      this.db
        .prepare(
          `UPDATE messages
           SET wakeup_status = 'pending'
           WHERE task_id = ? AND to_agent = ? AND status = 'unread' AND wakeup_status = 'dispatched'`
        )
        .run(taskId, route.to_agent);
      this.db
        .prepare(
          `UPDATE wakeup_routes SET in_flight = 0, worker_pid = NULL, updated_at = ? WHERE task_id = ? AND in_flight = 1`
        )
        .run(nowIso, taskId);
    }

    const refreshed = this.getWakeupRoute(taskId);
    const statusFilterSql = includeDispatched
      ? `wakeup_status IN ('pending', 'dispatched', 'failed')`
      : `wakeup_status IN ('pending', 'failed')`;
    const pendingRows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE task_id = ? AND to_agent = ? AND status = 'unread'
           AND ${statusFilterSql} AND seq > ?
         ORDER BY seq ASC`
      )
      .all(taskId, refreshed.to_agent, Number(refreshed.last_woken_seq || 0));

    if (pendingRows.length === 0) {
      return { claimed: false, reason: "no_unread_pending_messages" };
    }

    const lockRes = this.db
      .prepare(
        `UPDATE wakeup_routes
         SET in_flight = 1, worker_pid = ?, last_dispatched_at = ?, updated_at = ?
         WHERE task_id = ? AND in_flight = 0`
      )
      .run(Number(workerPid), nowIso, nowIso, taskId);

    if (!lockRes || lockRes.changes === 0) {
      return { claimed: false, reason: "lock_contention" };
    }

    const markDispatched = this.db.prepare(
      `UPDATE messages SET wakeup_status = 'dispatched', wakeup_dispatched_at = ?, wakeup_error = NULL WHERE id = ?`
    );
    let maxSeq = Number(refreshed.last_woken_seq || 0);
    const messageIds = [];
    for (const r of pendingRows) {
      markDispatched.run(nowIso, r.id);
      messageIds.push(r.id);
      if (Number(r.seq) > maxSeq) maxSeq = Number(r.seq);
    }

    return {
      claimed: true,
      route: this.getWakeupRoute(taskId),
      messageIds,
      messages: pendingRows.map((r) => this._deserializeMessage(r)),
      maxSeq,
    };
  }

  _validHostReceipt(receipt, route) {
    return Boolean(route && receipt?.accepted === true && typeof receipt.turnId === "string" && receipt.turnId && receipt.targetSessionId === route.target_session_id);
  }

  completeWakeupDelivery(
    taskId,
    messageIds = [],
    { delivered = true, maxSeq = 0, error = null, receipt = null } = {}
  ) {
    const route = this.getWakeupRoute(taskId);
    if (delivered && !this._validHostReceipt(receipt, route)) throw new Error("Host acceptance requires accepted:true, turnId and matching targetSessionId");
    for (const id of messageIds) {
      const message = this.getMessageById(id);
      if (!message || message.task_id !== taskId || message.to_agent !== route?.to_agent) throw new Error("Host receipt message binding mismatch");
    }
    maxSeq = Math.max(0, ...messageIds.map((id) => this.getMessageById(id).seq));
    const nowIso = new Date().toISOString();
    const nextStatus = delivered ? "delivered" : "failed";
    const receiptJson =
      delivered && receipt ? JSON.stringify(receipt) : null;
    const turnId = delivered && receipt?.turnId ? String(receipt.turnId) : null;
    const handledByClientId =
      delivered && receipt?.handledByClientId
        ? String(receipt.handledByClientId)
        : null;

    const updateMsg = this.db.prepare(
      `UPDATE messages
       SET wakeup_status = ?,
           wakeup_delivered_at = CASE WHEN ? = 1 THEN ? ELSE wakeup_delivered_at END,
           wakeup_receipt_json = COALESCE(?, wakeup_receipt_json),
           wakeup_error = ?
       WHERE id = ?`
    );
    for (const id of messageIds) {
      updateMsg.run(nextStatus, delivered ? 1 : 0, nowIso, receiptJson, error, id);
    }
    this.db
      .prepare(
        `UPDATE wakeup_routes
         SET in_flight = 0,
             worker_pid = NULL,
             last_woken_seq = CASE WHEN ? = 1 THEN MAX(last_woken_seq, ?) ELSE last_woken_seq END,
             last_delivered_at = CASE WHEN ? = 1 THEN ? ELSE last_delivered_at END,
             last_receipt_json = CASE WHEN ? = 1 AND ? IS NOT NULL THEN ? ELSE last_receipt_json END,
             last_turn_id = CASE WHEN ? = 1 AND ? IS NOT NULL THEN ? ELSE last_turn_id END,
             last_handled_by_client_id = CASE WHEN ? = 1 AND ? IS NOT NULL THEN ? ELSE last_handled_by_client_id END,
             last_error = ?,
             updated_at = ?
         WHERE task_id = ?`
      )
      .run(
        delivered ? 1 : 0,
        Number(maxSeq || 0),
        delivered ? 1 : 0,
        nowIso,
        delivered ? 1 : 0,
        receiptJson,
        receiptJson,
        delivered ? 1 : 0,
        turnId,
        turnId,
        delivered ? 1 : 0,
        handledByClientId,
        handledByClientId,
        error,
        nowIso,
        taskId
      );
    return this.getWakeupRoute(taskId);
  }

  /**
   * Explicitly confirm wakeup delivery AFTER receiving an acceptance receipt from the host
   * (`turnId` or `handledByClientId`). Rejects confirmation if receipt is missing.
   */
  confirmWakeupDelivery({
    taskId,
    messageIds = [],
    maxSeq = null,
    receipt = null,
  } = {}) {
    if (!taskId) {
      throw new Error("taskId is required for confirmWakeupDelivery.");
    }
    const isValidReceipt = this._validHostReceipt(receipt, this.getWakeupRoute(taskId));
    if (!isValidReceipt) {
      return {
        ok: false,
        confirmed: false,
        error:
          "Host receipt with accepted:true, turnId and matching targetSessionId is required before marking wakeup as delivered.",
        route: this.getWakeupRoute(taskId),
      };
    }

    const route = this.getWakeupRoute(taskId);
    const baselineSeq = Number(route?.last_woken_seq || 0);
    let resolvedIds = Array.isArray(messageIds) ? [...messageIds] : [];
    let resolvedMaxSeq = Number(maxSeq || 0);

    if (resolvedIds.length === 0) {
      const rows = this.db
        .prepare(
          `SELECT id, seq FROM messages
           WHERE task_id = ? AND status = 'unread' AND seq > ? AND to_agent = ?
           ORDER BY seq ASC`
        )
        .all(taskId, baselineSeq, route.to_agent);
      for (const r of rows) {
        if (!maxSeq || Number(r.seq) <= Number(maxSeq)) {
          resolvedIds.push(r.id);
          if (Number(r.seq) > resolvedMaxSeq) {
            resolvedMaxSeq = Number(r.seq);
          }
        }
      }
    } else if (!resolvedMaxSeq) {
      for (const id of resolvedIds) {
        const msg = this.getMessageById(id);
        if (msg && msg.seq > resolvedMaxSeq) {
          resolvedMaxSeq = msg.seq;
        }
      }
    }

    const normalizedReceipt = {
      accepted: true,
      acceptedAt: new Date().toISOString(),
      ...receipt,
    };

    const updatedRoute = this.completeWakeupDelivery(taskId, resolvedIds, {
      delivered: true,
      maxSeq: resolvedMaxSeq,
      error: null,
      receipt: normalizedReceipt,
    });

    return {
      ok: true,
      confirmed: true,
      deliveredMessageIds: resolvedIds,
      maxSeq: resolvedMaxSeq,
      receipt: normalizedReceipt,
      route: updatedRoute,
    };
  }

  /**
   * Execute host wakeup delivery for `taskId` using the configured driver (`codex_ipc` / `host_poll`,
   * `app_server_ws`, `custom_command`, or `cli_resume`), starting a new turn on the target host
   * conversation and marking `delivered = true` ONLY after receiving the host's acceptance receipt.
   */
  async executeWakeupDelivery(
    taskId,
    {
      driverOverride = null,
      workerPid = process.pid,
      includeDispatched = false,
    } = {}
  ) {
    let lastOutcome = {
      ok: false,
      delivered: false,
      claimed: false,
      taskId,
      route: this.getWakeupRoute(taskId),
    };

    while (true) {
      const claim = this.claimPendingWakeup(taskId, {
        workerPid,
        includeDispatched,
      });
      if (!claim.claimed) {
        if (!lastOutcome.claimed) {
          lastOutcome = {
            ok: true,
            delivered: false,
            claimed: false,
            reason: claim.reason,
            taskId,
            route: this.getWakeupRoute(taskId),
          };
        }
        break;
      }

      const route = claim.route;
      const driver =
        driverOverride ||
        process.env.BRIDGE_WAKEUP_DRIVER ||
        route.driver ||
        (process.env.BRIDGE_WAKEUP_COMMAND ? "custom_command" : null) ||
        (process.env.BRIDGE_CODEX_APP_SERVER_URL ? "app_server_ws" : null) ||
        (process.env.CODEX_BIN ? "cli_resume" : null) ||
        "codex_ipc";

      if (driver === "manual") {
        const nowIso = new Date().toISOString();
        const revertStmt = this.db.prepare(
          `UPDATE messages SET wakeup_status = 'pending' WHERE id = ? AND wakeup_status = 'dispatched'`
        );
        for (const id of claim.messageIds) {
          revertStmt.run(id);
        }
        this.db
          .prepare(
            `UPDATE wakeup_routes SET in_flight = 0, worker_pid = NULL, updated_at = ? WHERE task_id = ?`
          )
          .run(nowIso, taskId);
        return {
          ok: false,
          delivered: false,
          claimed: true,
          driver: "manual",
          reason: "manual_driver_does_not_auto_deliver",
          route: this.getWakeupRoute(taskId),
        };
      }

      const msgSummaries = (claim.messages || []).map(
        (m) =>
          `- [seq=${m.seq}] (${m.from_agent} -> ${m.to_agent}) ${m.subject || "(no subject)"} [id=${m.id}]`
      );
      const prompt = [
        `[MCP Inbox Wakeup] Unread message(s) [${claim.messageIds.join(", ")}] (up to seq=${claim.maxSeq}) arrived for taskId=${route.task_id}, threadId=${route.thread_id}.`,
        ...(msgSummaries.length > 0 ? ["Messages:", ...msgSummaries] : []),
        `Call bridge_read_messages(toAgent="${route.to_agent}", taskId="${route.task_id}", unreadOnly=true) to inspect and process.`,
      ].join("\n");

      // 1. Custom shell command driver
      if (driver === "custom_command") {
        const cmd = route.wakeup_command || process.env.BRIDGE_WAKEUP_COMMAND;
        if (!cmd) {
          const updatedRoute = this.completeWakeupDelivery(
            taskId,
            claim.messageIds,
            {
              delivered: false,
              maxSeq: claim.maxSeq,
              error: "No wakeup_command or BRIDGE_WAKEUP_COMMAND configured",
            }
          );
          return {
            ok: false,
            delivered: false,
            claimed: true,
            driver,
            error: "No wakeup_command or BRIDGE_WAKEUP_COMMAND configured",
            route: updatedRoute,
          };
        }
        const res = await runCommand({
          command: "/bin/sh",
          args: ["-c", cmd],
          cwd: route.cwd || process.cwd(),
          stdinText: prompt,
          timeoutMs: 30000,
          env: {
            BRIDGE_WAKEUP_TURN: "1",
            BRIDGE_TASK_ID: route.task_id,
            BRIDGE_THREAD_ID: route.thread_id,
            BRIDGE_TARGET_SESSION_ID: route.target_session_id,
            BRIDGE_MESSAGE_IDS: claim.messageIds.join(","),
            BRIDGE_MAX_SEQ: String(claim.maxSeq),
            BRIDGE_WAKEUP_PROMPT: prompt,
          },
        });
        let receipt = null;
        try { receipt = JSON.parse(res.stdout.trim()); } catch { /* No host receipt. */ }
        const accepted = res.ok && this._validHostReceipt(receipt, route);
        if (!accepted) receipt = null;
        const updatedRoute = this.completeWakeupDelivery(
          taskId,
          claim.messageIds,
          {
            delivered: Boolean(accepted),
            maxSeq: claim.maxSeq,
            error: accepted
              ? null
              : res.stderr || res.error || "Forwarded without a bound host acceptance receipt",
            receipt,
          }
        );
        lastOutcome = {
          ok: Boolean(accepted),
          delivered: Boolean(accepted),
          claimed: true,
          driver,
          messageIds: claim.messageIds,
          maxSeq: claim.maxSeq,
          receipt,
          route: updatedRoute,
        };
        if (!accepted) break;
        continue;
      }

      // 2. Official App Server WebSocket / Unix JSON-RPC driver (`app_server_ws`)
      if (driver === "app_server_ws") {
        const appServerUrl =
          route.app_server_url || process.env.BRIDGE_CODEX_APP_SERVER_URL;
        const wsRes = await deliverViaAppServerWs({
          appServerUrl,
          targetSessionId: route.target_session_id,
          prompt,
          cwd: route.cwd || process.cwd(),
          timeoutMs: 20000,
        });
        const accepted = Boolean(
          wsRes.ok && wsRes.delivered && wsRes.receipt?.accepted && wsRes.turnId
        );
        const updatedRoute = this.completeWakeupDelivery(
          taskId,
          claim.messageIds,
          {
            delivered: accepted,
            maxSeq: claim.maxSeq,
            error: accepted ? null : wsRes.error || "app_server_ws_failed",
            receipt: accepted ? wsRes.receipt : null,
          }
        );
        lastOutcome = {
          ok: accepted,
          delivered: accepted,
          claimed: true,
          driver: "app_server_ws",
          turnId: wsRes.turnId || null,
          messageIds: claim.messageIds,
          maxSeq: claim.maxSeq,
          receipt: accepted ? wsRes.receipt : null,
          error: accepted ? null : wsRes.error,
          route: updatedRoute,
        };
        if (!accepted) break;
        continue;
      }

      // 3. Codex Local Host IPC Driver (`codex_ipc` or `host_poll`)
      if (driver === "codex_ipc" || driver === "host_poll") {
        const explicitUrl =
          route.app_server_url || process.env.BRIDGE_CODEX_APP_SERVER_URL || "";
        const useWs =
          explicitUrl.startsWith("ws://") ||
          explicitUrl.startsWith("wss://") ||
          explicitUrl.startsWith("unix://");
        const hostRes = useWs
          ? await deliverViaAppServerWs({
              appServerUrl: explicitUrl,
              targetSessionId: route.target_session_id,
              prompt,
              cwd: route.cwd || process.cwd(),
              timeoutMs: 20000,
            })
          : await deliverViaCodexIpcSocket({
              targetSessionId: route.target_session_id,
              prompt,
              cwd: route.cwd || process.cwd(),
              ipcSocketPath: explicitUrl || null,
              timeoutMs: 20000,
            });

        const accepted = Boolean(
          hostRes.ok &&
            hostRes.delivered &&
            hostRes.receipt?.accepted &&
            hostRes.turnId
        );
        const updatedRoute = this.completeWakeupDelivery(
          taskId,
          claim.messageIds,
          {
            delivered: accepted,
            maxSeq: claim.maxSeq,
            error: accepted ? null : hostRes.error || "codex_ipc_delivery_failed",
            receipt: accepted ? hostRes.receipt : null,
          }
        );
        lastOutcome = {
          ok: accepted,
          delivered: accepted,
          claimed: true,
          driver: hostRes.driver || "codex_ipc",
          mode: hostRes.mode || null,
          turnId: hostRes.turnId || null,
          handledByClientId: hostRes.handledByClientId || null,
          messageIds: claim.messageIds,
          maxSeq: claim.maxSeq,
          receipt: accepted ? hostRes.receipt : null,
          error: accepted ? null : hostRes.error,
          route: updatedRoute,
        };
        if (!accepted) break;
        continue;
      }

      // 4. Headless CLI Resume Driver (`cli_resume`) with automatic fallback to `codex_ipc` on -32600
      const codexBin = resolveBinary("codex", "CODEX_BIN");
      if (!codexBin) {
        const updatedRoute = this.completeWakeupDelivery(
          taskId,
          claim.messageIds,
          {
            delivered: false,
            maxSeq: claim.maxSeq,
            error: "codex binary not found on PATH or CODEX_BIN",
          }
        );
        lastOutcome = {
          ok: false,
          delivered: false,
          claimed: true,
          driver: "cli_resume",
          error: "codex binary not found on PATH or CODEX_BIN",
          route: updatedRoute,
        };
        break;
      }

      const res = await runCommand({
        command: codexBin,
        args: [
          "exec",
          "resume",
          "--json",
          "--skip-git-repo-check",
          route.target_session_id,
          "-",
        ],
        cwd: route.cwd || process.cwd(),
        stdinText: prompt,
        timeoutMs: 0,
        env: { BRIDGE_WAKEUP_TURN: "1" },
      });
      const combinedErr =
        (res.stderr || "") + "\n" + (res.stdout || "") + "\n" + (res.error || "");

      if (
        !res.ok &&
        (combinedErr.includes("already has an active writer") ||
          combinedErr.includes("-32600"))
      ) {
        // Desktop holds active-writer lock -> switch route to `host_poll` (`codex_ipc`) and deliver via IPC socket!
        this.configureWakeupRoute({
          taskId,
          driver: "host_poll",
          enabled: true,
        });
        const ipcFallback = await deliverViaCodexIpcSocket({
          targetSessionId: route.target_session_id,
          prompt,
          cwd: route.cwd || process.cwd(),
          timeoutMs: 20000,
        });
        const accepted = Boolean(
          ipcFallback.ok &&
            ipcFallback.delivered &&
            ipcFallback.receipt?.accepted &&
            ipcFallback.turnId
        );
        const updatedRoute = this.completeWakeupDelivery(
          taskId,
          claim.messageIds,
          {
            delivered: accepted,
            maxSeq: claim.maxSeq,
            error: accepted
              ? null
              : `${combinedErr.trim()} | ipc_fallback: ${ipcFallback.error || "failed"}`,
            receipt: accepted ? ipcFallback.receipt : null,
          }
        );
        lastOutcome = {
          ok: accepted,
          delivered: accepted,
          claimed: true,
          driver: accepted ? "codex_ipc" : "cli_resume",
          turnId: ipcFallback.turnId || null,
          handledByClientId: ipcFallback.handledByClientId || null,
          messageIds: claim.messageIds,
          maxSeq: claim.maxSeq,
          receipt: accepted ? ipcFallback.receipt : null,
          error: accepted ? null : updatedRoute.last_error,
          route: updatedRoute,
        };
        if (!accepted) break;
        continue;
      }

      const cliReceipt = null;
      const updatedRoute = this.completeWakeupDelivery(
        taskId,
        claim.messageIds,
        {
          delivered: false,
          maxSeq: claim.maxSeq,
          error: res.ok
            ? "CLI process exited without host acceptance evidence"
            : res.stderr || res.error || `exitCode=${res.exitCode}`,
          receipt: cliReceipt,
        }
      );
      lastOutcome = {
        ok: Boolean(res.ok),
        delivered: false,
        claimed: true,
        driver: "cli_resume",
        messageIds: claim.messageIds,
        maxSeq: claim.maxSeq,
        receipt: cliReceipt,
        route: updatedRoute,
      };
      break;
    }

    return lastOutcome;
  }

  _scheduleWakeupForMessage(msg) {
    if (!msg || msg.wakeup_status !== "pending" || !msg.task_id) return;
    const route = this.getWakeupRoute(msg.task_id);
    if (!route || !route.enabled) return;

    this._notifyLocalWaiters();

    const effectiveDriver =
      process.env.BRIDGE_WAKEUP_DRIVER ||
      route.driver ||
      (process.env.BRIDGE_WAKEUP_COMMAND ? "custom_command" : null) ||
      (process.env.BRIDGE_CODEX_APP_SERVER_URL ? "app_server_ws" : null) ||
      (process.env.CODEX_BIN ? "cli_resume" : null) ||
      "host_poll";

    if (effectiveDriver === "manual") {
      return;
    }

    // Ensure the singleton resident wakeup receiver daemon is running
    try {
      ensureResidentWakeupDaemon(this.dbPath);
    } catch {
      // ignore
    }

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
        ],
        {
          detached: true,
          stdio: "ignore",
          env: { ...process.env, BRIDGE_WAKEUP_TURN: "1" },
        }
      );
      child.on("error", (err) => {
        try {
          this.recordWakeupFailure(msg.task_id, [msg.id], err?.message || String(err));
        } catch {}
      });
      child.unref();
    } catch (err) {
      this.recordWakeupFailure(msg.task_id, [msg.id], err?.message || String(err));
    }
  }

  // ===========================================================================
  // Task Queue, Binding & Lifecycle State Machine API
  // ===========================================================================

  createTask({
    taskId = null,
    fromAgent,
    assignedTo,
    title,
    prompt,
    cwd = "",
    priority = "normal",
    requiredModel = null,
    actualModel = null,
    requiredConversationId = null,
    boundConversationId = null,
    permissions = {},
    sessionId = null,
    metadata = {},
  }) {
    if (taskId) {
      const existing = this.getTaskById(taskId);
      if (existing) {
        const conflicts = [];
        const check = (name, value, original) => {
          if (value !== null && value !== undefined && value !== "" && JSON.stringify(value) !== JSON.stringify(original)) conflicts.push(name);
        };
        check("fromAgent", fromAgent, existing.from_agent);
        check("assignedTo", assignedTo, existing.assigned_to);
        check("cwd", cwd, existing.cwd);
        check("requiredModel", requiredModel || metadata?.requiredModel || metadata?.model, existing.required_model);
        check("requiredConversationId", requiredConversationId || metadata?.requiredConversationId || sessionId, existing.required_conversation_id);
        check("deliveryMode", metadata?.deliveryMode, existing.metadata?.deliveryMode || "direct");
        for (const key of Object.keys(permissions || {})) check(`permissions.${key}`, permissions[key], existing.permissions[key]);
        if (conflicts.length) throw Object.assign(new Error(`Task reuse conflicts with original scope: ${conflicts.join(", ")}`), { code: "TASK_SCOPE_CONFLICT" });
        return existing;
      }
    }

    const id = taskId || crypto.randomUUID();
    const now = new Date().toISOString();
    const reqModel =
      requiredModel || metadata?.requiredModel || metadata?.model || null;
    const reqConv =
      requiredConversationId ||
      metadata?.requiredConversationId ||
      metadata?.conversationId ||
      sessionId ||
      null;
    const boundConv = boundConversationId || sessionId || reqConv || null;

    const mergedPermissions = {
      ...(permissions || {}),
    };
    if (Array.isArray(metadata?.writeRoots) && !mergedPermissions.writeRoots) {
      mergedPermissions.writeRoots = metadata.writeRoots;
    }
    if (Array.isArray(metadata?.readRoots) && !mergedPermissions.readRoots) {
      mergedPermissions.readRoots = metadata.readRoots;
    }

    const initialPhase = "ready";
    const initialPhaseLabel = PHASE_LABELS[initialPhase];

    this.db
      .prepare(
        `INSERT INTO tasks (
          id, from_agent, assigned_to, title, prompt, cwd, priority,
          status, phase, phase_label,
          required_model, actual_model, required_conversation_id, bound_conversation_id,
          delivery_version, permissions_json, lease_status,
          session_id, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, 0, ?, 'none', ?, ?, ?, ?)`
      )
      .run(
        id,
        fromAgent,
        assignedTo,
        title || prompt.slice(0, 80),
        prompt,
        cwd,
        priority,
        initialPhase,
        initialPhaseLabel,
        reqModel,
        actualModel,
        reqConv,
        boundConv,
        JSON.stringify(mergedPermissions),
        boundConv,
        JSON.stringify(metadata || {}),
        now,
        now
      );

    return this.getTaskById(id);
  }

  getTaskById(id) {
    const row = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id);
    return row ? this._deserializeTask(row) : null;
  }

  /**
   * Verify and bind `actualModel` and `conversationId` against a task's requirements.
   * Throws a structured error on mismatch so silent model/session drift is impossible.
   */
  verifyAndBindTask({
    taskId,
    actualModel = null,
    conversationId = null,
    modelSource = "caller_declared",
    strictModel = true,
  }) {
    const task = this.getTaskById(taskId);
    if (!task) {
      const err = new Error(`Task not found: ${taskId}`);
      err.code = "TASK_NOT_FOUND";
      throw err;
    }

    const reported = ["runtime_init_metadata", "runtime_event_metadata", "claude_json_output", "python_sdk_runtime"].includes(modelSource);
    const effectiveActualModel = actualModel || task.actual_model;
    const completingVerified = modelSource === "complete_task" && task.metadata?.modelEvidence === "runtime_reported" && task.actual_model && (!actualModel || verifyModelMatch(task.actual_model, actualModel).ok);
    if (task.metadata?.requireVerifiedModel && !completingVerified && !["claim_task", "submit_patch", "caller_declared", "antigravity_exec_request"].includes(modelSource) && (!reported || !actualModel)) {
      throw Object.assign(new Error("Required runtime model evidence is missing"), { code: "MODEL_UNVERIFIED" });
    }
    if (task.required_model && (strictModel || effectiveActualModel)) {
      const modelCheck = verifyModelMatch(
        task.required_model,
        effectiveActualModel,
        modelSource
      );
      if (!modelCheck.ok) {
        const err = new Error(modelCheck.error);
        err.code = modelCheck.code;
        throw err;
      }
    }

    if (
      (task.required_conversation_id || task.bound_conversation_id) &&
      conversationId !== (task.required_conversation_id || task.bound_conversation_id)
    ) {
      const err = new Error(
        `Conversation ID mismatch for task '${taskId}': task is strictly bound to conversation '${task.required_conversation_id}', but received '${conversationId}'.`
      );
      err.code = "CONVERSATION_MISMATCH";
      throw err;
    }

    const now = new Date().toISOString();
    const newActualModel = reported ? actualModel : task.actual_model || null;
    const nextMetadata = { ...task.metadata, lastModelObservation: { source: modelSource, reportedModel: reported ? actualModel : null, evidence: reported && actualModel ? "runtime_reported" : "unverified" }, modelEvidence: reported && actualModel ? "runtime_reported" : task.metadata?.modelEvidence || "unverified", modelSource, requestedModel: task.required_model || actualModel || null };
    this.db.prepare("UPDATE tasks SET metadata_json = ? WHERE id = ?").run(JSON.stringify(nextMetadata), taskId);
    const newBoundConv =
      conversationId ||
      task.bound_conversation_id ||
      task.required_conversation_id ||
      null;

    this.db
      .prepare(
        `UPDATE tasks
         SET actual_model = COALESCE(?, actual_model),
             bound_conversation_id = COALESCE(?, bound_conversation_id),
             session_id = COALESCE(?, session_id),
             updated_at = ?
         WHERE id = ?`
      )
      .run(newActualModel, newBoundConv, newBoundConv, now, taskId);

    return this.getTaskById(taskId);
  }

  listTasks({
    assignedTo = null,
    fromAgent = null,
    status = null,
    phase = null,
    limit = 50,
  } = {}) {
    const conditions = [];
    const params = [];
    if (assignedTo && assignedTo !== "*") {
      conditions.push(`assigned_to = ?`);
      params.push(assignedTo);
    }
    if (fromAgent) {
      conditions.push(`from_agent = ?`);
      params.push(fromAgent);
    }
    if (status) {
      conditions.push(`status = ?`);
      params.push(status);
    }
    if (phase) {
      conditions.push(`phase = ?`);
      params.push(phase);
    }
    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks ${whereClause} ORDER BY created_at DESC LIMIT ?`
      )
      .all(...params, limit);
    return rows.map((r) => this._deserializeTask(r));
  }

  claimTask({
    taskId = null,
    agent,
    model = null,
    conversationId = null,
  }) {
    const now = new Date().toISOString();
    let targetId = taskId;
    if (!targetId) {
      const next = this.db
        .prepare(
          `SELECT id FROM tasks WHERE assigned_to = ? AND status IN ('pending', 'in_progress')
           ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END ASC,
           CASE priority
             WHEN 'urgent' THEN 1
             WHEN 'high' THEN 2
             WHEN 'normal' THEN 3
             ELSE 4
           END ASC, created_at ASC LIMIT 1`
        )
        .get(agent);
      if (!next) return null;
      targetId = next.id;
    }

    const existing = this.getTaskById(targetId);
    if (!existing) return null;

    if (existing.assigned_to !== agent) throw new Error("Task participant mismatch");
    if (existing.required_conversation_id && !conversationId) throw new Error("Required execution conversation identity is missing");
    if (existing.required_model && model) {
      this.verifyAndBindTask({
        taskId: targetId,
        actualModel: model,
        conversationId,
        modelSource: "claim_task",
      });
    } else if (model || conversationId) {
      this.verifyAndBindTask({
        taskId: targetId,
        actualModel: model,
        conversationId,
        modelSource: "claim_task",
        strictModel: Boolean(existing.required_model && model),
      });
    }

    const nextPhase =
      existing.phase === "ready" || existing.phase === "pending_preflight"
        ? "in_progress"
        : existing.phase;

    this.db
      .prepare(
        `UPDATE tasks
         SET status = 'in_progress',
             phase = ?,
             phase_label = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(nextPhase, PHASE_LABELS[nextPhase] || nextPhase, now, targetId);

    return this.getTaskById(targetId);
  }

  updateTaskPhase({
    taskId,
    phase,
    result = null,
    error = null,
  }) {
    const task = this.getTaskById(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    const now = new Date().toISOString();
    const phaseLabel = PHASE_LABELS[phase] || phase;

    let status = task.status;
    if (phase === "completed") status = "completed";
    else if (phase === "failed") status = "failed";
    else if (phase === "cancelled") status = "cancelled";
    else if (status === "pending") status = "in_progress";

    this.db
      .prepare(
        `UPDATE tasks
         SET status = ?,
             phase = ?,
             phase_label = ?,
             result = COALESCE(?, result),
             error = COALESCE(?, error),
             updated_at = ?,
             completed_at = CASE WHEN ? IN ('completed', 'failed', 'cancelled') THEN ? ELSE completed_at END
         WHERE id = ?`
      )
      .run(
        status,
        phase,
        phaseLabel,
        result,
        error,
        now,
        status,
        now,
        taskId
      );

    if (status === "completed" || status === "failed" || status === "cancelled") {
      this.revokeTaskLease(taskId);
    }

    return this.getTaskById(taskId);
  }

  completeTask({
    taskId,
    status = "completed",
    phase = null,
    result = null,
    error = null,
    sessionId = null,
    model = null,
  }) {
    if (model || sessionId) {
      this.verifyAndBindTask({
        taskId,
        actualModel: model,
        conversationId: sessionId,
        modelSource: "complete_task",
        strictModel: Boolean(model),
      });
    }

    const resolvedPhase =
      phase ||
      (status === "completed"
        ? "completed"
        : status === "cancelled"
          ? "cancelled"
          : "failed");
    const phaseLabel = PHASE_LABELS[resolvedPhase] || resolvedPhase;
    const now = new Date().toISOString();

    this.db
      .prepare(
        `UPDATE tasks
         SET status = ?,
             phase = ?,
             phase_label = ?,
             result = COALESCE(?, result),
             error = COALESCE(?, error),
             session_id = COALESCE(?, session_id),
             updated_at = ?,
             completed_at = ?
         WHERE id = ?`
      )
      .run(
        status,
        resolvedPhase,
        phaseLabel,
        result,
        error,
        sessionId,
        now,
        now,
        taskId
      );

    // Automatically revoke task-scoped temporary permissions on completion/failure/cancellation
    const revokedLease = this.revokeTaskLease(taskId);
    const updatedTask = this.getTaskById(taskId);
    return {
      ...updatedTask,
      revokedLease,
    };
  }

  async waitForTask({ taskId, timeoutMs = 60000, pollIntervalMs = 500 }) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const task = this.getTaskById(taskId);
      if (!task) return null;
      if (
        task.status === "completed" ||
        task.status === "failed" ||
        task.status === "cancelled"
      ) {
        return task;
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    return this.getTaskById(taskId);
  }

  _deserializeTask(row) {
    let metadata = {};
    let permissions = {};
    try {
      metadata = JSON.parse(row.metadata_json || "{}");
    } catch {
      metadata = {};
    }
    try {
      permissions = JSON.parse(row.permissions_json || "{}");
    } catch {
      permissions = {};
    }

    const phase = row.phase || (row.status === "completed" ? "completed" : "ready");
    const phaseLabel = row.phase_label || PHASE_LABELS[phase] || phase;

    return {
      id: row.id,
      from_agent: row.from_agent,
      assigned_to: row.assigned_to,
      title: row.title,
      prompt: row.prompt,
      cwd: row.cwd,
      priority: row.priority,
      status: row.status,
      phase,
      phase_label: phaseLabel,
      binding: {
        taskId: row.id,
        requiredModel: row.required_model || null,
        actualModel: row.actual_model || null,
        requestedModel: row.required_model || metadata.requestedModel || null,
        modelEvidence: metadata.modelEvidence || "unverified",
        modelSource: metadata.modelSource || null,
        modelMatched: row.required_model
          ? Boolean(
              row.actual_model &&
                verifyModelMatch(row.required_model, row.actual_model).ok
            )
          : true,
        requiredConversationId: row.required_conversation_id || null,
        boundConversationId:
          row.bound_conversation_id || row.session_id || null,
        deliveryVersion: Number(row.delivery_version || 0),
      },
      required_model: row.required_model,
      actual_model: row.actual_model,
      required_conversation_id: row.required_conversation_id,
      bound_conversation_id: row.bound_conversation_id,
      delivery_version: Number(row.delivery_version || 0),
      permissions,
      lease_status: row.lease_status || "none",
      result: row.result,
      error: row.error,
      session_id: row.session_id,
      metadata,
      created_at: row.created_at,
      updated_at: row.updated_at,
      completed_at: row.completed_at,
    };
  }

  // ===========================================================================
  // Task-Scoped Permission Leases API [P0]
  // ===========================================================================

  grantTaskLease({ taskId, agent, permissions = {}, preflight = {} }) {
    if (!preflight.ok) throw new Error("Cannot record a ready lease for failed preflight");
    const task = this.getTaskById(taskId);
    for (const key of ["readRoots", "writeRoots", "allowedCommands", "forbiddenOperations"]) {
      if (JSON.stringify(permissions[key] || []) !== JSON.stringify(task.permissions[key] || [])) throw new Error(`Preflight cannot amend task scope: ${key}`);
    }
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO task_leases (task_id, agent, permissions_json, preflight_json, status, granted_at, revoked_at)
         VALUES (?, ?, ?, ?, 'active', ?, NULL)
         ON CONFLICT(task_id) DO UPDATE SET
           agent = excluded.agent,
           permissions_json = excluded.permissions_json,
           preflight_json = excluded.preflight_json,
           status = 'active',
           granted_at = excluded.granted_at,
           revoked_at = NULL`
      )
      .run(
        taskId,
        agent,
        JSON.stringify(permissions),
        JSON.stringify(preflight),
        now
      );

    this.db
      .prepare(
        `UPDATE tasks SET permissions_json = ?, lease_status = 'active', updated_at = ? WHERE id = ?`
      )
      .run(JSON.stringify(permissions), now, taskId);

    return this.getTaskLease(taskId);
  }

  getTaskLease(taskId) {
    const row = this.db
      .prepare(`SELECT * FROM task_leases WHERE task_id = ?`)
      .get(taskId);
    if (!row) return null;
    return {
      taskId: row.task_id,
      agent: row.agent,
      permissions: JSON.parse(row.permissions_json || "{}"),
      preflight: JSON.parse(row.preflight_json || "{}"),
      status: row.status,
      grantedAt: row.granted_at,
      revokedAt: row.revoked_at,
    };
  }

  revokeTaskLease(taskId) {
    const existing = this.getTaskLease(taskId);
    if (!existing || existing.status === "revoked") {
      return existing;
    }
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE task_leases SET status = 'revoked', revoked_at = ? WHERE task_id = ?`
      )
      .run(now, taskId);
    this.db
      .prepare(
        `UPDATE tasks SET lease_status = 'revoked', updated_at = ? WHERE id = ?`
      )
      .run(now, taskId);
    return this.getTaskLease(taskId);
  }

  // ===========================================================================
  // Structured Patch Attachment API [P1]
  // ===========================================================================

  /**
   * Store a structured patch attachment while preserving exact byte-for-byte `rawContent`.
   * Automatically handles `supersedes` links, increments task `delivery_version`,
   * transitions task phase to `awaiting_validation`, and emits a cursor notification message.
   */
  submitPatch(args) {
    return this._atomicEvent(() => this._submitPatch(args));
  }

  _submitPatch({
    patchId,
    taskId,
    fromAgent,
    toAgent = null,
    conversationId = null,
    model = null,
    artifactKind = "unified_diff",
    rawContent,
    dependsOn = [],
    supersedes = null,
    targetFiles = [],
    validation = {},
    summary = "",
    notifyRecipient = true,
  }) {
    const task = this.getTaskById(taskId);
    if (!task) {
      const err = new Error(`Cannot submit patch: task '${taskId}' not found.`);
      err.code = "TASK_NOT_FOUND";
      throw err;
    }

    // Verify model and conversation binding against the task
    this.verifyAndBindTask({
      taskId,
      actualModel: model || task.actual_model,
      conversationId,
      modelSource: "submit_patch",
    });

    const resolvedToAgent = toAgent || task.from_agent || "codex";
    if (resolvedToAgent === fromAgent) {
      const err = new Error(
        `Patch routing error: fromAgent ('${fromAgent}') and toAgent ('${resolvedToAgent}') cannot be identical.`
      );
      err.code = "SELF_ROUTING_REJECTED";
      throw err;
    }

    const previous = this.getPatch(patchId);
    if (previous) throw new Error("Patch IDs are immutable; submit a new patchId with supersedes");
    const current = this.listPatches({ taskId }).patches;
    if (supersedes && !current.some((p) => p.patchId === supersedes && !p.supersededBy)) throw new Error("Replacement target is missing or already superseded");
    this._computePatchApplyOrder([
      ...current.filter((p) => !p.supersededBy && p.status !== "superseded" && p.patchId !== supersedes),
      { patchId, dependsOn },
    ]);

    const now = new Date().toISOString();
    const seq = this.nextSeq();
    const sha256 = sha256Hex(rawContent);

    if (supersedes) {
      this.db
        .prepare(
          `UPDATE patches SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE patch_id = ? AND task_id = ?`
        )
        .run(patchId, now, supersedes, taskId);
    }

    this.db
      .prepare(
        `INSERT INTO patches (
          patch_id, seq, task_id, from_agent, to_agent, conversation_id, model,
          artifact_kind, raw_content, sha256, depends_on_json, supersedes, superseded_by,
          target_files_json, validation_json, status, summary, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'submitted', ?, ?, ?)
        ON CONFLICT(patch_id) DO UPDATE SET
          seq = excluded.seq,
          from_agent = excluded.from_agent,
          to_agent = excluded.to_agent,
          conversation_id = COALESCE(excluded.conversation_id, patches.conversation_id),
          model = COALESCE(excluded.model, patches.model),
          artifact_kind = excluded.artifact_kind,
          raw_content = excluded.raw_content,
          sha256 = excluded.sha256,
          depends_on_json = excluded.depends_on_json,
          supersedes = excluded.supersedes,
          target_files_json = excluded.target_files_json,
          validation_json = excluded.validation_json,
          status = 'submitted',
          summary = excluded.summary,
          updated_at = excluded.updated_at`
      )
      .run(
        patchId,
        seq,
        taskId,
        fromAgent,
        resolvedToAgent,
        conversationId || task.bound_conversation_id || null,
        model || task.actual_model || null,
        artifactKind,
        rawContent,
        sha256,
        JSON.stringify(dependsOn || []),
        supersedes || null,
        JSON.stringify(targetFiles || []),
        JSON.stringify(validation || {}),
        summary || "",
        now,
        now
      );

    // Increment task delivery_version and transition phase to awaiting_validation
    this.db
      .prepare(
        `UPDATE tasks
         SET delivery_version = delivery_version + 1,
             phase = 'awaiting_validation',
             phase_label = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(PHASE_LABELS.awaiting_validation, now, taskId);

    let notificationMessage = null;
    if (notifyRecipient) {
      notificationMessage = this.sendMessage({
        fromAgent,
        toAgent: resolvedToAgent,
        taskId,
        threadId: `example-${taskId}`,
        subject: `Patch Delivered: ${patchId} (${artifactKind})${supersedes ? ` [supersedes ${supersedes}]` : ""}`,
        content:
          summary ||
          `Structured patch '${patchId}' (${artifactKind}, sha256=${sha256.slice(0, 12)}, files=${targetFiles.length}) submitted and ready for mechanical application via bridge_get_patch.`,
        metadata: {
          event: "patch_delivered",
          taskId,
          patchId,
          artifactKind,
          sha256,
          supersedes: supersedes || null,
          dependsOn: dependsOn || [],
          targetFiles,
          conversationId: conversationId || task.bound_conversation_id || null,
          model: model || task.actual_model || null,
        },
      });
    }

    return {
      patch: this.getPatch(patchId, { includeRawContent: false }),
      task: this.getTaskById(taskId),
      notificationReceipt: notificationMessage
        ? {
            messageId: notificationMessage.id,
            seq: notificationMessage.seq,
            actualFromAgent: notificationMessage.from_agent,
            actualToAgent: notificationMessage.to_agent,
          }
        : null,
    };
  }

  getPatch(patchId, { includeRawContent = true } = {}) {
    const row = this.db
      .prepare(`SELECT * FROM patches WHERE patch_id = ?`)
      .get(patchId);
    if (!row) return null;
    return this._deserializePatch(row, { includeRawContent });
  }

  listPatches({
    taskId = null,
    activeOnly = false,
    includeRawContent = false,
  } = {}) {
    const conditions = [];
    const params = [];
    if (taskId) {
      conditions.push(`task_id = ?`);
      params.push(taskId);
    }
    if (activeOnly) {
      conditions.push(`status != 'superseded' AND superseded_by IS NULL`);
    }
    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM patches ${whereClause} ORDER BY seq ASC`)
      .all(...params);

    const patches = rows.map((r) =>
      this._deserializePatch(r, { includeRawContent })
    );
    const activePatches = patches.filter(
      (p) => p.status !== "superseded" && !p.supersededBy
    );
    const activeApplyOrder = this._computePatchApplyOrder(activePatches);

    return {
      patches,
      activeApplyOrder,
    };
  }

  _computePatchApplyOrder(patches) {
    const byId = new Map(patches.map((p) => [p.patchId, p]));
    const visited = new Set();
    const visiting = new Set();
    const order = [];

    const visit = (p) => {
      if (visited.has(p.patchId)) return;
      if (visiting.has(p.patchId)) throw new Error(`Patch dependency cycle at ${p.patchId}`);
      visiting.add(p.patchId);
      for (const depId of p.dependsOn || []) {
        if (!byId.has(depId)) throw new Error(`Missing active patch prerequisite: ${depId}`);
        visit(byId.get(depId));
      }
      visiting.delete(p.patchId);
      visited.add(p.patchId);
      order.push(p.patchId);
    };

    for (const p of patches) {
      visit(p);
    }
    return order;
  }

  _deserializePatch(row, { includeRawContent = true } = {}) {
    const out = {
      patchId: row.patch_id,
      seq: Number(row.seq || 0),
      taskId: row.task_id,
      fromAgent: row.from_agent,
      toAgent: row.to_agent,
      conversationId: row.conversation_id,
      model: row.model,
      artifactKind: row.artifact_kind,
      sha256: row.sha256,
      byteLength: Buffer.byteLength(row.raw_content || "", "utf8"),
      dependsOn: JSON.parse(row.depends_on_json || "[]"),
      supersedes: row.supersedes,
      supersededBy: row.superseded_by,
      targetFiles: JSON.parse(row.target_files_json || "[]"),
      validation: JSON.parse(row.validation_json || "{}"),
      status: row.status,
      summary: row.summary,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      appliedAt: row.applied_at,
    };
    if (includeRawContent) {
      out.rawContent = row.raw_content;
    }
    return out;
  }

  // ===========================================================================
  // Validation Recording & Unified Task Overview [P1]
  // ===========================================================================

  /**
   * Record patch application and/or server test validation results bound to a task and patch set.
   * Automatically updates patch statuses, transitions the task phase (`awaiting_revision` vs `awaiting_review`),
   * and sends a consolidated cursor-tracked notification message to the assignee.
   */
  recordValidation(args) {
    return this._atomicEvent(() => this._recordValidation(args));
  }

  _recordValidation({
    taskId,
    validatorAgent,
    patchIds = [],
    applied = true,
    passed = null,
    summary,
    details = {},
    notifyAssignee = true,
  }) {
    const task = this.getTaskById(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    for (const patchId of patchIds) {
      const patch = this.getPatch(patchId, { includeRawContent: false });
      if (!patch || patch.taskId !== taskId || patch.supersededBy) throw new Error(`Validation references missing, foreign or superseded patch: ${patchId}`);
    }
    const now = new Date().toISOString();
    const seq = this.nextSeq();
    const id = crypto.randomUUID();

    this.db
      .prepare(
        `INSERT INTO task_validations (
          id, seq, task_id, validator_agent, patch_ids_json, applied, passed, summary, details_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        seq,
        taskId,
        validatorAgent,
        JSON.stringify(patchIds || []),
        applied ? 1 : 0,
        passed === null || passed === undefined ? null : passed ? 1 : 0,
        summary,
        JSON.stringify(details || {}),
        now
      );

    if (Array.isArray(patchIds) && patchIds.length > 0) {
      const nextPatchStatus =
        passed === false
          ? "validation_failed"
          : applied
            ? "applied"
            : "submitted";
      const updatePatchStmt = this.db.prepare(
        `UPDATE patches
         SET status = CASE WHEN status = 'superseded' THEN status ELSE ? END,
             applied_at = CASE WHEN ? = 1 THEN COALESCE(applied_at, ?) ELSE applied_at END,
             updated_at = ?
         WHERE patch_id = ? AND task_id = ?`
      );
      for (const pid of patchIds) {
        updatePatchStmt.run(
          nextPatchStatus,
          applied ? 1 : 0,
          now,
          now,
          pid,
          taskId
        );
      }
    }

    let nextPhase = task.phase;
    if (passed === false || !applied) {
      nextPhase = "awaiting_revision";
    } else if (passed === true) {
      nextPhase = "awaiting_review";
    } else if (applied) {
      nextPhase = "awaiting_validation";
    }

    const updatedTask = this.updateTaskPhase({
      taskId,
      phase: nextPhase,
    });
    this.db
      .prepare(
        `UPDATE messages SET processed_at = COALESCE(processed_at, ?) WHERE task_id = ? AND to_agent = ? AND status = 'read'`
      )
      .run(now, taskId, validatorAgent);

    let notification = null;
    if (notifyAssignee && task.assigned_to && task.assigned_to !== validatorAgent) {
      notification = this.sendMessage({
        fromAgent: validatorAgent,
        toAgent: task.assigned_to,
        taskId,
        threadId: `example-${taskId}`,
        subject:
          passed === false
            ? `Validation Failed (${PHASE_LABELS[nextPhase]}): [${patchIds.join(", ")}]`
            : passed === true
              ? `Validation Passed (${PHASE_LABELS[nextPhase]}): [${patchIds.join(", ")}]`
              : `Patches Applied: [${patchIds.join(", ")}]`,
        content: summary,
        metadata: {
          artifactKind: "validation_feedback",
          validationId: id,
          deliveryVersion: task.delivery_version,
          taskId,
          patchIds,
          applied,
          passed,
          phase: nextPhase,
          phaseLabel: PHASE_LABELS[nextPhase],
          ...details,
        },
      });
    }

    return {
      validationId: id,
      seq,
      task: updatedTask,
      notificationReceipt: notification
        ? {
            messageId: notification.id,
            seq: notification.seq,
            actualFromAgent: notification.from_agent,
            actualToAgent: notification.to_agent,
          }
        : null,
    };
  }

  /**
   * Build a single unified task overview combining task state, model/session binding,
   * permission lease, active patch stack, validations, and latest message cursor.
   */
  getTaskOverview(taskId) {
    const task = this.getTaskById(taskId);
    if (!task) return null;

    const lease = this.getTaskLease(taskId);
    const { patches, activeApplyOrder } = this.listPatches({
      taskId,
      includeRawContent: false,
    });
    const validations = this.db
      .prepare(
        `SELECT * FROM task_validations WHERE task_id = ? ORDER BY seq DESC LIMIT 10`
      )
      .all(taskId)
      .map((v) => ({
        id: v.id,
        seq: Number(v.seq),
        validatorAgent: v.validator_agent,
        patchIds: JSON.parse(v.patch_ids_json || "[]"),
        applied: Boolean(v.applied),
        passed: v.passed === null ? null : Boolean(v.passed),
        summary: v.summary,
        createdAt: v.created_at,
      }));

    const recentMessages = this.readMessages({
      toAgent: "*",
      taskId,
      markAsRead: false,
      limit: 10,
    });

    return {
      taskId: task.id,
      title: task.title,
      status: task.status,
      phase: task.phase,
      phaseLabel: task.phase_label,
      binding: task.binding,
      lease: lease || { status: task.lease_status || "none" },
      wakeupRoute: this.getWakeupRoute(taskId),
      patchSummary: {
        totalCount: patches.length,
        activeApplyOrder: activeApplyOrder.slice(-50),
        truncated: patches.length > 50,
        patches: patches.slice(-50).map((p) => ({ patchId: p.patchId, seq: p.seq, artifactKind: p.artifactKind, status: p.status, supersedes: p.supersedes, supersededBy: p.supersededBy, summary: p.summary.slice(0, 240), targetFiles: p.targetFiles.slice(0, 20) })),
      },
      latestValidation: validations[0] || null,
      validations,
      recentMessages: recentMessages.map(({ content, metadata, ...m }) => ({ ...m, contentPreview: content.slice(0, 240) })),
      currentCursor: this.getCurrentSeq(),
    };
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

  /**
   * Incremental cursor polling across messages, patches, and validations.
   * Supports `settleMs` (quiet-window coalescing) so multi-step deliveries
   * (e.g. patch message + validation receipt arriving 1-2s apart) are returned together.
   */
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
        limit: 100,
      });

      const patchConds = ["seq > ?"];
      const patchParams = [Number(afterSeq)];
      if (taskId) {
        patchConds.push("task_id = ?");
        patchParams.push(taskId);
      }
      if (toAgent && toAgent !== "*") {
        patchConds.push("(to_agent = ? OR from_agent = ?)");
        patchParams.push(toAgent, toAgent);
      }
      const patchRows = this.db
        .prepare(
          `SELECT * FROM patches WHERE ${patchConds.join(" AND ")} ORDER BY seq ASC LIMIT 100`
        )
        .all(...patchParams);
      const patches = patchRows.map((r) =>
        this._deserializePatch(r, { includeRawContent: false })
      );

      const valConds = ["seq > ?"];
      const valParams = [Number(afterSeq)];
      if (taskId) {
        valConds.push("task_id = ?");
        valParams.push(taskId);
      }
      const validations = this.db
        .prepare(
          `SELECT * FROM task_validations WHERE ${valConds.join(" AND ")} ORDER BY seq ASC LIMIT 50`
        )
        .all(...valParams)
        .map((v) => ({
          id: v.id,
          seq: Number(v.seq),
          taskId: v.task_id,
          validatorAgent: v.validator_agent,
          patchIds: JSON.parse(v.patch_ids_json || "[]"),
          applied: Boolean(v.applied),
          passed: v.passed === null ? null : Boolean(v.passed),
          summary: v.summary,
          createdAt: v.created_at,
        }));

      const pageEnd = Math.min(
        messages.length === 100 ? messages.at(-1).seq : Infinity,
        patches.length === 100 ? patches.at(-1).seq : Infinity,
        validations.length === 50 ? validations.at(-1).seq : Infinity,
      );
      const pageMessages = messages.filter((m) => m.seq <= pageEnd);
      const pagePatches = patches.filter((p) => p.seq <= pageEnd);
      const pageValidations = validations.filter((v) => v.seq <= pageEnd);
      if (shouldMarkRead) {
        const mark = this.db.prepare("UPDATE messages SET status = 'read', read_at = COALESCE(read_at, ?) WHERE id = ?");
        for (const m of pageMessages) mark.run(new Date().toISOString(), m.id);
      }
      let maxSeq = Number(afterSeq);
      for (const item of [...pageMessages, ...pagePatches, ...pageValidations]) maxSeq = Math.max(maxSeq, item.seq);

      return {
        hasUpdates:
          messages.length > 0 || patches.length > 0 || validations.length > 0,
        previousCursor: Number(afterSeq),
        nextCursor: maxSeq,
        messages: pageMessages,
        patches: pagePatches,
        validations: pageValidations,
        taskState: taskId ? (() => { const { prompt, result, metadata, ...t } = this.getTaskById(taskId); return t; })() : undefined,
      };
    };

    const effectiveSettleMs = Math.max(0, Number(settleMs || 0));

    // Wait for first update if not already present
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

    // Quiet-window coalescing: once updates exist, wait until `effectiveSettleMs` passes without newer seq
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

  /**
   * Coalesced blocking delivery wait designed specifically to wake up an active party (e.g. Codex Desktop)
   * when a passive party (e.g. Antigravity) finishes a task turn and submits patches + receipts.
   *
   * - If unread messages already exist after `afterSeq` (or if `afterSeq` is omitted, any unread messages for `taskId`),
   *   coalesces them across `settleMs` (default 2500ms) and returns immediately.
   * - Otherwise blocks up to `timeoutMs` (default 600000ms = 10 min) until the passive party delivers,
   *   then coalesces adjacent events. Silence alone does not establish a complete artifact set.
   * - Marks wakeup delivery status and returns a ready-to-inject `wakeupPrompt` and `hostForwardAction`
   *   for Codex Desktop's `send_message_to_thread` or synchronous turn continuation.
   */
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
    const route = taskId ? this.getWakeupRoute(taskId) : null;
    if (resolvedAfterSeq === null || resolvedAfterSeq === undefined) {
      // Determine baseline cursor: max of route.last_woken_seq and the last message/validation sent BY `toAgent`
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

      // Find earliest unread message for (toAgent, taskId) after baselineSeq (e.g. seq=49, 50 after seq=48)
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
      if (minUnreadRow && minUnreadRow.min_seq !== null && minUnreadRow.min_seq !== undefined) {
        resolvedAfterSeq = Math.max(baselineSeq, Number(minUnreadRow.min_seq) - 1);
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

      // Mark as 'dispatched' (NOT 'delivered') and do NOT advance last_woken_seq until a host acceptance receipt is confirmed
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
          `UPDATE wakeup_routes SET last_dispatched_at = ?, updated_at = ? WHERE task_id = ?`
        )
        .run(nowIso, nowIso, taskId);

      if (deliverToHost) {
        const execOutcome = await this.executeWakeupDelivery(taskId, {
          includeDispatched: true,
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

    const finalReceipt = [...inboundMessages].reverse().find((m) => m.metadata?.delivery?.final === true);
    const manifest = finalReceipt?.metadata?.delivery;
    const deliveryTask = taskId ? this.getTaskById(taskId) : null;
    const artifactDeliveryComplete = Boolean(deliveryTask && manifest &&
      finalReceipt.from_agent === deliveryTask.assigned_to &&
      manifest.revision === deliveryTask.delivery_version && Array.isArray(manifest.patchIds) &&
      manifest.patchIds.every((id) => { const p = this.getPatch(id, { includeRawContent: false }); return p && p.taskId === taskId && p.fromAgent === finalReceipt.from_agent && !p.supersededBy; }) &&
      this.listPatches({ taskId, activeOnly: true }).patches.every((p) => manifest.patchIds.includes(p.patchId)));

    const refreshedRoute = taskId ? this.getWakeupRoute(taskId) : route;
    const refreshedMessages = pollResult.messages.map(
      (m) => this.getMessageById(m.id) || m
    );

    const summaryLines = inboundMessages.map(
      (m) =>
        `- [seq=${m.seq}] (${m.from_agent} -> ${m.to_agent}) ${m.subject || "(no subject)"} [id=${m.id}]`
    );
    const patchSummaryLines = pollResult.patches.map(
      (p) =>
        `- [patch=${p.patchId}, seq=${p.seq}] (${p.artifactKind}) files=${(p.targetFiles || []).join(", ")}`
    );

    const wakeupPrompt = pollResult.hasUpdates
      ? [
          `[MCP Active Wakeup] Passive agent delivered ${inboundMessages.length} message(s) and ${pollResult.patches.length} patch(es) (cursor ${pollResult.previousCursor} -> ${pollResult.nextCursor})${taskId ? ` for taskId=${taskId}` : ""}.`,
          ...(summaryLines.length > 0 ? ["Messages:", ...summaryLines] : []),
          ...(patchSummaryLines.length > 0 ? ["Patches:", ...patchSummaryLines] : []),
          `Next step: Inspect messages/patches (already included in this wakeup payload or via bridge_read_messages / bridge_get_patch) and proceed with validation.`,
        ].join("\n")
      : null;

    return {
      ...pollResult,
      messages: refreshedMessages.map(({ content, metadata, ...m }) => ({ ...m, contentPreview: content.slice(0, 240) })),
      artifactDeliveryComplete,
      artifactDeliveryEvidence: artifactDeliveryComplete ? "sender_final_manifest_and_artifacts" : "partial_or_no_final_manifest",
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
  // Shared Context Store API
  // ===========================================================================

  setContext({
    key,
    value,
    updatedBy,
    contentType = "text/plain",
    description = "",
  }) {
    const now = new Date().toISOString();
    const serialized =
      typeof value === "string" ? value : JSON.stringify(value, null, 2);
    this.db
      .prepare(
        `INSERT INTO shared_context (key, value, content_type, updated_by, description, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           content_type = excluded.content_type,
           updated_by = excluded.updated_by,
           description = CASE WHEN excluded.description != '' THEN excluded.description ELSE shared_context.description END,
           updated_at = excluded.updated_at`
      )
      .run(key, serialized, contentType, updatedBy, description, now);
    return this.getContext(key);
  }

  getContext(key) {
    return (
      this.db.prepare(`SELECT * FROM shared_context WHERE key = ?`).get(key) ||
      null
    );
  }

  listContext() {
    return this.db
      .prepare(
        `SELECT key, content_type, updated_by, description, updated_at, LENGTH(value) AS byte_length
         FROM shared_context ORDER BY updated_at DESC`
      )
      .all();
  }

  // ===========================================================================
  // Session History & State Tracking
  // ===========================================================================

  recordSession({
    agent,
    externalSessionId,
    model = null,
    cwd = "",
    summary = "",
    lastPrompt = "",
    lastResponse = "",
  }) {
    const now = new Date().toISOString();
    const sessionKey = externalSessionId
      ? `${agent}:${externalSessionId}`
      : `${agent}:latest`;

    const upsert = (key) => {
      this.db
        .prepare(
          `INSERT INTO agent_sessions (session_key, agent, external_session_id, model, cwd, summary, last_prompt, last_response, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_key) DO UPDATE SET
             external_session_id = COALESCE(excluded.external_session_id, agent_sessions.external_session_id),
             model = COALESCE(excluded.model, agent_sessions.model),
             cwd = CASE WHEN excluded.cwd != '' THEN excluded.cwd ELSE agent_sessions.cwd END,
             summary = CASE WHEN excluded.summary != '' THEN excluded.summary ELSE agent_sessions.summary END,
             last_prompt = excluded.last_prompt,
             last_response = excluded.last_response,
             updated_at = excluded.updated_at`
        )
        .run(
          key,
          agent,
          externalSessionId || null,
          model || null,
          cwd,
          summary,
          lastPrompt,
          lastResponse,
          now
        );
    };

    upsert(sessionKey);
    if (sessionKey !== `${agent}:latest`) {
      upsert(`${agent}:latest`);
    }
  }

  getLatestSession(agent) {
    return (
      this.db
        .prepare(`SELECT * FROM agent_sessions WHERE session_key = ?`)
        .get(`${agent}:latest`) || null
    );
  }

  listSessions(agent = null, limit = 20) {
    if (agent) {
      return this.db
        .prepare(
          `SELECT * FROM agent_sessions WHERE agent = ? ORDER BY updated_at DESC LIMIT ?`
        )
        .all(agent, limit);
    }
    return this.db
      .prepare(
        `SELECT * FROM agent_sessions ORDER BY updated_at DESC LIMIT ?`
      )
      .all(limit);
  }

  getSummaryStats() {
    const unreadByAgent = this.db
      .prepare(
        `SELECT to_agent, COUNT(*) AS unread_count FROM messages WHERE status = 'unread' GROUP BY to_agent`
      )
      .all();
    const tasksByPhase = this.db
      .prepare(
        `SELECT assigned_to, status, phase, phase_label, COUNT(*) AS count FROM tasks GROUP BY assigned_to, status, phase`
      )
      .all();
    const patchCounts = this.db
      .prepare(
        `SELECT task_id, status, COUNT(*) AS count FROM patches GROUP BY task_id, status`
      )
      .all();
    const activeLeases = this.db
      .prepare(`SELECT task_id, agent, status, granted_at FROM task_leases WHERE status = 'active'`)
      .all();
    const contextKeys = this.listContext();
    const recentSessions = this.listSessions(null, 10);

    return {
      dbPath: this.dbPath,
      currentCursor: this.getCurrentSeq(),
      unreadMessages: unreadByAgent,
      tasks: tasksByPhase,
      patches: patchCounts,
      activeLeases,
      sharedContextCount: contextKeys.length,
      recentSessions: recentSessions.map(({ last_prompt, last_response, summary, ...s }) => ({ ...s, summary: (summary || "").slice(0, 240) })),
    };
  }
}
