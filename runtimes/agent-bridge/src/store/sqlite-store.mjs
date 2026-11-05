import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import {
  PHASE_LABELS,
  isBlindIsolated,
  sha256Hex,
  verifyModelMatch,
} from "../domain/model.mjs";
import { createMandate } from "../domain/policy.mjs";
import { defaultTaskThreadId } from "../domain/intake.mjs";

function parseJsonSafe(raw, fallback) {
  if (!raw || typeof raw !== "string") return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/**
 * SQLite WAL Transactional Store implementing the synchronous Repository contract
 * with `SAVEPOINT` nested transactions, `afterCommit` callback hooks, and
 * non-destructive `v1.0.0` schema migration.
 */
export class SqliteStore {
  /**
   * @param {string} dbPath
   */
  constructor(dbPath) {
    this.dbPath = path.resolve(dbPath);
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath, { timeout: 10000 });
    this._txDepth = 0;
    this._savepointCounter = 0;
    this._afterCommitQueue = [];
    this._initSchema();
  }

  _initSchema() {
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        this.db.exec(`PRAGMA busy_timeout = 10000;`);
        this.db.exec(`
          PRAGMA journal_mode = WAL;
          PRAGMA synchronous = NORMAL;

          CREATE TABLE IF NOT EXISTS bridge_control (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            paused INTEGER NOT NULL DEFAULT 0,
            changed_at TEXT DEFAULT NULL,
            reason TEXT DEFAULT NULL,
            router_mode TEXT NOT NULL DEFAULT 'observe',
            control_version TEXT NOT NULL DEFAULT '',
            controls_hash TEXT NOT NULL DEFAULT ''
          );
          INSERT OR IGNORE INTO bridge_control(id, paused) VALUES (1, 0);

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
            wakeup_status TEXT NOT NULL DEFAULT 'none',
            wakeup_target_session TEXT DEFAULT NULL,
            wakeup_dispatched_at TEXT DEFAULT NULL,
            wakeup_delivered_at TEXT DEFAULT NULL,
            wakeup_receipt_json TEXT DEFAULT NULL,
            processed_at TEXT DEFAULT NULL,
            consumed_at TEXT DEFAULT NULL,
            consumed_turn_id TEXT DEFAULT NULL,
            handback_reason TEXT DEFAULT NULL,
            delivery_attempts INTEGER NOT NULL DEFAULT 0,
            wakeup_error TEXT DEFAULT NULL,
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
            task_id TEXT NOT NULL,
            thread_id TEXT NOT NULL,
            to_agent TEXT NOT NULL,
            target_session_id TEXT NOT NULL,
            driver TEXT NOT NULL DEFAULT 'host_poll',
            wakeup_command TEXT DEFAULT NULL,
            app_server_url TEXT DEFAULT NULL,
            model TEXT DEFAULT NULL,
            effort TEXT DEFAULT NULL,
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
            consecutive_failures INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (task_id, to_agent)
          );

          -- v1.0.0 Durable Effects Queue
          CREATE TABLE IF NOT EXISTS bridge_effects (
            kind TEXT NOT NULL,
            effect_key TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            seq INTEGER NOT NULL,
            generation INTEGER NOT NULL DEFAULT 0,
            priority TEXT NOT NULL DEFAULT 'normal',
            attempts INTEGER NOT NULL DEFAULT 0,
            due_ms INTEGER NOT NULL,
            last_error TEXT NOT NULL DEFAULT '',
            since TEXT NOT NULL,
            PRIMARY KEY (kind, effect_key)
          );
          CREATE INDEX IF NOT EXISTS idx_bridge_effects_due
            ON bridge_effects(kind, due_ms, seq);

          CREATE TABLE IF NOT EXISTS bridge_task_events (
            event_id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            logical_key TEXT DEFAULT NULL,
            payload_hash TEXT NOT NULL,
            contract_version INTEGER DEFAULT NULL,
            attempt_id TEXT DEFAULT NULL,
            owner_epoch INTEGER DEFAULT NULL,
            payload_json TEXT NOT NULL,
            result_json TEXT DEFAULT NULL,
            created_at TEXT NOT NULL,
            seq INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_bridge_task_events_task
            ON bridge_task_events(task_id, seq);
          CREATE INDEX IF NOT EXISTS idx_bridge_task_events_logical
            ON bridge_task_events(task_id, kind, logical_key, seq);

          -- v1.0.0 Immutable Task Mandates
          CREATE TABLE IF NOT EXISTS bridge_mandates (
            task_id TEXT PRIMARY KEY,
            control_version TEXT NOT NULL,
            strength TEXT NOT NULL DEFAULT 'explicit',
            isolation_profile TEXT NOT NULL DEFAULT 'shared',
            scope_json TEXT NOT NULL DEFAULT '{}',
            matched_rules_json TEXT NOT NULL DEFAULT '[]',
            revoked_at TEXT DEFAULT NULL,
            revoke_reason TEXT DEFAULT NULL,
            created_at TEXT NOT NULL
          );

          -- v1.0.0 Thread Direct & Context Subscriptions
          CREATE TABLE IF NOT EXISTS bridge_subscriptions (
            thread_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            mode TEXT NOT NULL DEFAULT 'direct',
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            PRIMARY KEY (thread_id, task_id)
          );
          CREATE INDEX IF NOT EXISTS idx_bridge_subscriptions_task
            ON bridge_subscriptions(task_id);

          -- v1.0.0 Deterministic Router Decisions & Observe Proposals
          CREATE TABLE IF NOT EXISTS router_decisions (
            id TEXT PRIMARY KEY,
            seq INTEGER NOT NULL,
            thread_id TEXT NOT NULL,
            trigger_message_id TEXT DEFAULT NULL,
            mode TEXT NOT NULL,
            outcome TEXT NOT NULL,
            target_task_id TEXT DEFAULT NULL,
            target_agent TEXT DEFAULT NULL,
            reason_code TEXT NOT NULL,
            detail TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_router_decisions_seq
            ON router_decisions(seq DESC);

          -- v1.0.0 Single-Writer HealthBoard Persistence
          CREATE TABLE IF NOT EXISTS bridge_health (
            component TEXT PRIMARY KEY,
            owner_pid INTEGER NOT NULL,
            state TEXT NOT NULL,
            detail TEXT NOT NULL DEFAULT '',
            consecutive_failures INTEGER NOT NULL DEFAULT 0,
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

  _migrateRoutePrimaryKey() {
    this.atomic(() => {
      const columns = this.db.prepare("PRAGMA table_info(wakeup_routes)").all();
      const primary = columns.filter((col) => col.pk).sort((a, b) => a.pk - b.pk).map((col) => col.name);
      if (primary.join(",") === "task_id,to_agent") return;
      if (primary.join(",") !== "task_id") throw new Error("Unsupported wakeup_routes primary key");
      const original = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'wakeup_routes'").get().sql;
      // Retain the original column definitions and any installation-specific columns.
      let definition = original.replace(/(\btask_id\s+TEXT)\s+PRIMARY\s+KEY/i, "$1 NOT NULL");
      if (definition === original) throw new Error("Cannot migrate wakeup_routes primary key definition");
      definition = definition.replace(/CREATE TABLE(?: IF NOT EXISTS)?\s+["`\[]?wakeup_routes["`\]]?/i,
        "CREATE TABLE wakeup_routes_recipient_migration").replace(/\)(\s*(?:WITHOUT ROWID|STRICT)?\s*)$/i,
        ", PRIMARY KEY (task_id, to_agent))$1");
      const dependents = this.db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name = 'wakeup_routes' AND type IN ('index', 'trigger') AND sql IS NOT NULL").all();
      const names = columns.map((col) => '"' + col.name.replaceAll('"', '""') + '"').join(", ");
      this.db.exec(definition);
      this.db.exec(`INSERT INTO wakeup_routes_recipient_migration (${names}) SELECT ${names} FROM wakeup_routes`);
      this.db.exec("DROP TABLE wakeup_routes; ALTER TABLE wakeup_routes_recipient_migration RENAME TO wakeup_routes;");
      for (const { sql } of dependents) this.db.exec(sql);
    });
  }

  _migrateExistingTables() {
    const addColIfMissing = (table, colName, colDef) => {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all();
      if (!cols.some((c) => c.name === colName)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${colName} ${colDef}`);
      }
    };

    // v1.0.0 bridge_control columns
    addColIfMissing("bridge_control", "router_mode", "TEXT NOT NULL DEFAULT 'observe'");
    addColIfMissing("bridge_control", "control_version", "TEXT NOT NULL DEFAULT ''");
    addColIfMissing("bridge_control", "controls_hash", "TEXT NOT NULL DEFAULT ''");

    // v1.1 + v1.0.0 messages columns
    addColIfMissing("messages", "seq", "INTEGER NOT NULL DEFAULT 0");
    addColIfMissing("messages", "task_id", "TEXT DEFAULT NULL");
    addColIfMissing("messages", "wakeup_status", "TEXT NOT NULL DEFAULT 'none'");
    addColIfMissing("messages", "wakeup_target_session", "TEXT DEFAULT NULL");
    addColIfMissing("messages", "wakeup_dispatched_at", "TEXT DEFAULT NULL");
    addColIfMissing("messages", "wakeup_delivered_at", "TEXT DEFAULT NULL");
    addColIfMissing("messages", "wakeup_receipt_json", "TEXT DEFAULT NULL");
    addColIfMissing("messages", "processed_at", "TEXT DEFAULT NULL");
    addColIfMissing("messages", "wakeup_error", "TEXT DEFAULT NULL");
    addColIfMissing("messages", "consumed_at", "TEXT DEFAULT NULL");
    addColIfMissing("messages", "consumed_turn_id", "TEXT DEFAULT NULL");
    addColIfMissing("messages", "handback_reason", "TEXT DEFAULT NULL");
    addColIfMissing("messages", "delivery_attempts", "INTEGER NOT NULL DEFAULT 0");

    this._migrateRoutePrimaryKey();

    // wakeup_routes columns
    addColIfMissing("wakeup_routes", "worker_pid", "INTEGER DEFAULT NULL");
    addColIfMissing("wakeup_routes", "driver", "TEXT NOT NULL DEFAULT 'host_poll'");
    addColIfMissing("wakeup_routes", "wakeup_command", "TEXT DEFAULT NULL");
    addColIfMissing("wakeup_routes", "app_server_url", "TEXT DEFAULT NULL");
    addColIfMissing("wakeup_routes", "model", "TEXT DEFAULT NULL");
    addColIfMissing("wakeup_routes", "effort", "TEXT DEFAULT NULL");
    addColIfMissing("wakeup_routes", "last_receipt_json", "TEXT DEFAULT NULL");
    addColIfMissing("wakeup_routes", "last_turn_id", "TEXT DEFAULT NULL");
    addColIfMissing("wakeup_routes", "last_handled_by_client_id", "TEXT DEFAULT NULL");
    addColIfMissing("wakeup_routes", "consecutive_failures", "INTEGER NOT NULL DEFAULT 0");

    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_seq ON messages(seq)`);
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_messages_task ON messages(task_id, seq)`
    );

    // tasks columns
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
    const maxValSeq =
      this.db
        .prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM task_validations`)
        .get()?.m || 0;
    const initialMax = Math.max(maxMsgSeq, maxPatchSeq, maxValSeq);

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
        const meta = parseJsonSafe(m.metadata_json, {});
        updateMsgStmt.run(seq, meta.taskId || null, m.id);
      }
    }

    // Backfill task binding columns & mandates for pre-existing tasks
    const existingTasks = this.db
      .prepare(
        `SELECT * FROM tasks`
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

    const ctrl = this.getControl();
    for (const t of existingTasks) {
      const meta = parseJsonSafe(t.metadata_json, {});
      const reqModel =
        t.required_model || meta.requiredModel || meta.model || null;
      const reqConv =
        t.required_conversation_id ||
        meta.requiredConversationId ||
        meta.conversationId ||
        null;
      const perms = parseJsonSafe(t.permissions_json, {});
      if (Array.isArray(meta.writeRoots) && !perms.writeRoots) {
        perms.writeRoots = meta.writeRoots;
      }
      if (Array.isArray(meta.readRoots) && !perms.readRoots) {
        perms.readRoots = meta.readRoots;
      }

      let phase = t.phase || "ready";
      if (t.status === "completed") phase = "completed";
      else if (t.status === "failed") phase = "failed";
      else if (t.status === "in_progress" && phase === "ready") {
        phase = "in_progress";
      }

      updateTaskMetaStmt.run(
        reqModel,
        reqConv,
        reqConv,
        JSON.stringify(perms),
        phase,
        PHASE_LABELS[phase] || phase,
        t.id
      );

      // Non-destructively ensure pre-existing tasks have a baseline Mandate & Subscription
      if (!this.getMandate(t.id)) {
        const formatted = this.getTask(t.id);
        if (formatted) {
          const mandate = createMandate({
            task: formatted,
            controlVersion: ctrl.control_version || "",
            controlsHash: ctrl.controls_hash || "",
            nowIso: t.created_at || new Date().toISOString(),
          });
          this.putMandate(mandate);
          if (
            !isBlindIsolated(mandate) &&
            formatted.metadata?.autoSubscribeThread !== false
          ) {
            const route = this.getRoute(t.id);
            const threadId = route?.thread_id || defaultTaskThreadId(formatted);
            if (!this.getSubscription(threadId, t.id)) {
              this.putSubscription({
                thread_id: threadId,
                task_id: t.id,
                mode: "direct",
                active: 1,
                created_at: t.created_at || new Date().toISOString(),
              });
            }
          }
        }
      }
    }

    // Legacy v1.0 -> v1.1 patch backfill when upgrading ancient seq=0 databases
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
        const meta = parseJsonSafe(pm.metadata_json, null);
        if (!meta) continue;
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
        }
      }
    }
  }

  // ===========================================================================
  // Nested SAVEPOINT Transactions & afterCommit Hook
  // ===========================================================================

  atomic(fn) {
    if (this._txDepth === 0) {
      this.db.exec("BEGIN IMMEDIATE");
      this._txDepth = 1;
      let result;
      let callbacks = [];
      try {
        result = fn();
        this.db.exec("COMMIT");
        callbacks = this._afterCommitQueue.splice(
          0,
          this._afterCommitQueue.length
        );
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // ignore
        }
        this._afterCommitQueue.length = 0;
        throw err;
      } finally {
        this._txDepth = 0;
      }
      for (const cb of callbacks) {
        cb();
      }
      return result;
    }

    const spName = `sp_${++this._savepointCounter}`;
    const savedCallbacksLen = this._afterCommitQueue.length;
    this.db.exec(`SAVEPOINT ${spName}`);
    this._txDepth += 1;
    try {
      const res = fn();
      this.db.exec(`RELEASE SAVEPOINT ${spName}`);
      this._txDepth -= 1;
      return res;
    } catch (err) {
      try {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${spName}`);
        this.db.exec(`RELEASE SAVEPOINT ${spName}`);
      } catch {
        // ignore
      }
      this._afterCommitQueue.length = savedCallbacksLen;
      this._txDepth -= 1;
      throw err;
    }
  }

  afterCommit(cb) {
    if (typeof cb !== "function") return;
    if (this._txDepth > 0) {
      this._afterCommitQueue.push(cb);
    } else {
      cb();
    }
  }

  nextNamedSeq(counterName) {
    const row = this.db
      .prepare(
        `INSERT INTO bridge_counters (name, value) VALUES (?, 1)
         ON CONFLICT(name) DO UPDATE SET value = bridge_counters.value + 1 RETURNING value`
      )
      .get(counterName);
    return Number(row.value);
  }

  nextSeq() {
    return this.nextNamedSeq("event_seq");
  }

  getCurrentSeq() {
    const row = this.db
      .prepare(`SELECT value FROM bridge_counters WHERE name = 'event_seq'`)
      .get();
    return Number(row?.value || 0);
  }

  // ===========================================================================
  // Control
  // ===========================================================================

  getControl() {
    const row =
      this.db.prepare(`SELECT * FROM bridge_control WHERE id = 1`).get() || {};
    return {
      paused: Boolean(row.paused),
      changed_at: row.changed_at || null,
      reason: row.reason || null,
      router_mode: row.router_mode || "observe",
      control_version: row.control_version || "",
      controls_hash: row.controls_hash || "",
    };
  }

  setControl(patch = {}) {
    const current = this.getControl();
    const next = {
      paused:
        patch.paused !== undefined ? Boolean(patch.paused) : current.paused,
      changed_at:
        patch.changed_at !== undefined ? patch.changed_at : current.changed_at,
      reason: patch.reason !== undefined ? patch.reason : current.reason,
      router_mode:
        patch.router_mode !== undefined
          ? patch.router_mode
          : current.router_mode,
      control_version:
        patch.control_version !== undefined
          ? patch.control_version
          : current.control_version,
      controls_hash:
        patch.controls_hash !== undefined
          ? patch.controls_hash
          : current.controls_hash,
    };
    this.db
      .prepare(
        `UPDATE bridge_control
         SET paused = ?, changed_at = ?, reason = ?, router_mode = ?, control_version = ?, controls_hash = ?
         WHERE id = 1`
      )
      .run(
        Number(next.paused),
        next.changed_at,
        next.reason,
        next.router_mode,
        next.control_version,
        next.controls_hash
      );
    return this.getControl();
  }

  // ===========================================================================
  // Tasks, Leases & Mandates
  // ===========================================================================

  getTask(id) {
    if (!id) return null;
    const row = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id);
    return row ? this._deserializeTask(row) : null;
  }

  putTask(task) {
    this.db
      .prepare(
        `INSERT INTO tasks (
          id, from_agent, assigned_to, title, prompt, cwd, priority,
          status, phase, phase_label,
          required_model, actual_model, required_conversation_id, bound_conversation_id,
          delivery_version, permissions_json, lease_status,
          result, error, session_id, metadata_json, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          from_agent = excluded.from_agent,
          assigned_to = excluded.assigned_to,
          title = excluded.title,
          prompt = excluded.prompt,
          cwd = excluded.cwd,
          priority = excluded.priority,
          status = excluded.status,
          phase = excluded.phase,
          phase_label = excluded.phase_label,
          required_model = excluded.required_model,
          actual_model = excluded.actual_model,
          required_conversation_id = excluded.required_conversation_id,
          bound_conversation_id = excluded.bound_conversation_id,
          delivery_version = excluded.delivery_version,
          permissions_json = excluded.permissions_json,
          lease_status = excluded.lease_status,
          result = excluded.result,
          error = excluded.error,
          session_id = excluded.session_id,
          metadata_json = excluded.metadata_json,
          updated_at = excluded.updated_at,
          completed_at = excluded.completed_at`
      )
      .run(
        task.id,
        task.from_agent,
        task.assigned_to,
        task.title,
        task.prompt,
        task.cwd || "",
        task.priority || "normal",
        task.status,
        task.phase,
        task.phase_label || PHASE_LABELS[task.phase] || task.phase,
        task.required_model || null,
        task.actual_model || null,
        task.required_conversation_id || null,
        task.bound_conversation_id || null,
        Number(task.delivery_version || 0),
        JSON.stringify(task.permissions || {}),
        task.lease_status || "none",
        task.result ?? null,
        task.error ?? null,
        task.session_id ?? null,
        JSON.stringify(task.metadata || {}),
        task.created_at,
        task.updated_at,
        task.completed_at ?? null
      );
    return this.getTask(task.id);
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

  findNextClaimableTask(agent) {
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
    return next?.id || null;
  }

  _deserializeTask(row) {
    const metadata = parseJsonSafe(row.metadata_json, {});
    const permissions = parseJsonSafe(row.permissions_json, {});
    const phase =
      row.phase || (row.status === "completed" ? "completed" : "ready");
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

  getLease(taskId) {
    const row = this.db
      .prepare(`SELECT * FROM task_leases WHERE task_id = ?`)
      .get(taskId);
    if (!row) return null;
    return {
      taskId: row.task_id,
      agent: row.agent,
      permissions: parseJsonSafe(row.permissions_json, {}),
      preflight: parseJsonSafe(row.preflight_json, {}),
      status: row.status,
      grantedAt: row.granted_at,
      revokedAt: row.revoked_at,
    };
  }

  putLease(lease) {
    this.db
      .prepare(
        `INSERT INTO task_leases (task_id, agent, permissions_json, preflight_json, status, granted_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           agent = excluded.agent,
           permissions_json = excluded.permissions_json,
           preflight_json = excluded.preflight_json,
           status = excluded.status,
           granted_at = excluded.granted_at,
           revoked_at = excluded.revoked_at`
      )
      .run(
        lease.taskId,
        lease.agent,
        JSON.stringify(lease.permissions || {}),
        JSON.stringify(lease.preflight || {}),
        lease.status,
        lease.grantedAt,
        lease.revokedAt || null
      );
    return this.getLease(lease.taskId);
  }

  listActiveLeases() {
    return this.db
      .prepare(
        `SELECT task_id, agent, status, granted_at FROM task_leases WHERE status = 'active'`
      )
      .all();
  }

  getMandate(taskId) {
    if (!taskId) return null;
    const row = this.db
      .prepare(`SELECT * FROM bridge_mandates WHERE task_id = ?`)
      .get(taskId);
    return row ? this._deserializeMandate(row) : null;
  }

  putMandate(mandate) {
    this.db
      .prepare(
        `INSERT INTO bridge_mandates (
          task_id, control_version, strength, isolation_profile, scope_json, matched_rules_json, revoked_at, revoke_reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          control_version = excluded.control_version,
          strength = excluded.strength,
          isolation_profile = excluded.isolation_profile,
          scope_json = excluded.scope_json,
          matched_rules_json = excluded.matched_rules_json,
          revoked_at = excluded.revoked_at,
          revoke_reason = excluded.revoke_reason`
      )
      .run(
        mandate.task_id,
        mandate.control_version || "",
        mandate.strength || "explicit",
        mandate.isolation_profile || "shared",
        JSON.stringify(mandate.scope || {}),
        JSON.stringify(mandate.matched_rules || []),
        mandate.revoked_at || null,
        mandate.revoke_reason || null,
        mandate.created_at
      );
    return this.getMandate(mandate.task_id);
  }

  listMandates() {
    return this.db
      .prepare(`SELECT * FROM bridge_mandates`)
      .all()
      .map((r) => this._deserializeMandate(r));
  }

  _deserializeMandate(row) {
    return {
      task_id: row.task_id,
      control_version: row.control_version,
      strength: row.strength,
      isolation_profile: row.isolation_profile,
      scope: parseJsonSafe(row.scope_json, {}),
      matched_rules: parseJsonSafe(row.matched_rules_json, []),
      revoked_at: row.revoked_at,
      revoke_reason: row.revoke_reason,
      created_at: row.created_at,
    };
  }

  // ===========================================================================
  // Subscriptions & Router Decisions
  // ===========================================================================

  getSubscription(threadId, taskId) {
    return (
      this.db
        .prepare(
          `SELECT * FROM bridge_subscriptions WHERE thread_id = ? AND task_id = ?`
        )
        .get(threadId, taskId) || null
    );
  }

  putSubscription(sub) {
    this.db
      .prepare(
        `INSERT INTO bridge_subscriptions (thread_id, task_id, mode, active, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(thread_id, task_id) DO UPDATE SET
           mode = excluded.mode,
           active = excluded.active`
      )
      .run(
        sub.thread_id,
        sub.task_id,
        sub.mode || "direct",
        sub.active === undefined ? 1 : sub.active ? 1 : 0,
        sub.created_at || new Date().toISOString()
      );
    return this.getSubscription(sub.thread_id, sub.task_id);
  }

  listSubscriptions({
    threadId = null,
    taskId = null,
    activeOnly = false,
  } = {}) {
    const conds = [];
    const params = [];
    if (threadId) {
      conds.push(`thread_id = ?`);
      params.push(threadId);
    }
    if (taskId) {
      conds.push(`task_id = ?`);
      params.push(taskId);
    }
    if (activeOnly) {
      conds.push(`active = 1`);
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
    return this.db
      .prepare(
        `SELECT * FROM bridge_subscriptions ${where} ORDER BY created_at ASC`
      )
      .all(...params);
  }

  getDecision(id) {
    if (!id) return null;
    const row = this.db
      .prepare(`SELECT * FROM router_decisions WHERE id = ?`)
      .get(id);
    return row ? { ...row, seq: Number(row.seq) } : null;
  }

  putDecision(decision) {
    const seq = Number(decision.seq || this.nextNamedSeq("decision_seq"));
    this.db
      .prepare(
        `INSERT INTO router_decisions (
          id, seq, thread_id, trigger_message_id, mode, outcome, target_task_id, target_agent, reason_code, detail, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          outcome = excluded.outcome,
          detail = excluded.detail`
      )
      .run(
        decision.id,
        seq,
        decision.thread_id,
        decision.trigger_message_id || null,
        decision.mode,
        decision.outcome,
        decision.target_task_id || null,
        decision.target_agent || null,
        decision.reason_code,
        decision.detail || "",
        decision.created_at
      );
    return this.getDecision(decision.id);
  }

  listDecisions({
    threadId = null,
    taskId = null,
    outcome = null,
    limit = 50,
  } = {}) {
    const conds = [];
    const params = [];
    if (threadId) {
      conds.push(`thread_id = ?`);
      params.push(threadId);
    }
    if (taskId) {
      conds.push(`target_task_id = ?`);
      params.push(taskId);
    }
    if (outcome) {
      conds.push(`outcome = ?`);
      params.push(outcome);
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
    return this.db
      .prepare(
        `SELECT * FROM router_decisions ${where} ORDER BY seq DESC LIMIT ?`
      )
      .all(...params, limit)
      .map((r) => ({ ...r, seq: Number(r.seq) }));
  }

  // ===========================================================================
  // Messages & Wakeup Routes
  // ===========================================================================

  getMessage(id) {
    if (!id) return null;
    const row = this.db
      .prepare(`SELECT * FROM messages WHERE id = ?`)
      .get(id);
    return row ? this._deserializeMessage(row) : null;
  }

  putMessage(msg) {
    const receiptJson = msg.wakeup_receipt
      ? JSON.stringify(msg.wakeup_receipt)
      : null;
    this.db
      .prepare(
        `INSERT INTO messages (
          id, seq, thread_id, task_id, from_agent, to_agent, subject, content, reply_to, metadata_json, status,
          wakeup_status, wakeup_target_session, wakeup_dispatched_at, wakeup_delivered_at, wakeup_receipt_json,
          processed_at, consumed_at, consumed_turn_id, handback_reason, delivery_attempts, wakeup_error,
          created_at, read_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          metadata_json = excluded.metadata_json,
          status = excluded.status,
          wakeup_status = excluded.wakeup_status,
          wakeup_target_session = excluded.wakeup_target_session,
          wakeup_dispatched_at = excluded.wakeup_dispatched_at,
          wakeup_delivered_at = excluded.wakeup_delivered_at,
          wakeup_receipt_json = COALESCE(excluded.wakeup_receipt_json, messages.wakeup_receipt_json),
          processed_at = excluded.processed_at,
          consumed_at = excluded.consumed_at,
          consumed_turn_id = excluded.consumed_turn_id,
          handback_reason = excluded.handback_reason,
          delivery_attempts = excluded.delivery_attempts,
          wakeup_error = excluded.wakeup_error,
          read_at = excluded.read_at`
      )
      .run(
        msg.id,
        Number(msg.seq || 0),
        msg.thread_id,
        msg.task_id || null,
        msg.from_agent,
        msg.to_agent,
        msg.subject || "",
        msg.content,
        msg.reply_to || null,
        JSON.stringify(msg.metadata || {}),
        msg.status || "unread",
        msg.wakeup_status || "none",
        msg.wakeup_target_session || null,
        msg.wakeup_dispatched_at || null,
        msg.wakeup_delivered_at || null,
        receiptJson,
        msg.processed_at || null,
        msg.consumed_at || null,
        msg.consumed_turn_id || null,
        msg.handback_reason || null,
        Number(msg.delivery_attempts || 0),
        msg.wakeup_error || null,
        msg.created_at,
        msg.read_at || null
      );
    return this.getMessage(msg.id);
  }

  queryMessages({
    toAgent = null,
    fromAgent = null,
    threadId = null,
    taskId = null,
    afterSeq = null,
    unreadOnly = false,
    limit = 50,
  } = {}) {
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
    return rows.map((r) => this._deserializeMessage(r));
  }

  findFirstReply(messageId) {
    const row = this.db
      .prepare(
        `SELECT * FROM messages WHERE reply_to = ? ORDER BY seq ASC LIMIT 1`
      )
      .get(messageId);
    return row ? this._deserializeMessage(row) : null;
  }

  markPriorTaskMessagesProcessed({ taskId, toAgent, nowIso }) {
    this.db
      .prepare(
        `UPDATE messages SET processed_at = COALESCE(processed_at, ?) WHERE task_id = ? AND to_agent = ? AND status = 'read'`
      )
      .run(nowIso, taskId, toAgent);
  }

  _deserializeMessage(row) {
    const metadata = parseJsonSafe(row.metadata_json, {});
    const wakeupReceipt = row.wakeup_receipt_json
      ? parseJsonSafe(row.wakeup_receipt_json, null)
      : null;
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
      consumed_at: row.consumed_at || null,
      consumed_turn_id: row.consumed_turn_id || null,
      handback_reason: row.handback_reason || null,
      delivery_attempts: Number(row.delivery_attempts || 0),
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

  getRoute(taskId, toAgent = null) {
    if (!taskId) return null;
    const row = toAgent
      ? this.db.prepare(`SELECT * FROM wakeup_routes WHERE task_id = ? AND to_agent = ?`).get(taskId, toAgent)
      : this.db.prepare(`SELECT r.* FROM wakeup_routes r WHERE r.task_id = ?
          ORDER BY CASE WHEN r.to_agent = (SELECT assigned_to FROM tasks WHERE id = r.task_id) THEN 0 ELSE 1 END,
            r.updated_at DESC, r.to_agent LIMIT 1`).get(taskId);
    return row ? this._deserializeRoute(row) : null;
  }

  listTaskRoutes(taskId) {
    if (!taskId) return [];
    return this.db.prepare(`SELECT * FROM wakeup_routes WHERE task_id = ? ORDER BY to_agent`)
      .all(taskId).map((row) => this._deserializeRoute(row));
  }

  putRoute(route) {
    const receiptJson = route.last_receipt
      ? JSON.stringify(route.last_receipt)
      : route.last_receipt_json || null;
    this.db
      .prepare(
        `INSERT INTO wakeup_routes (
          task_id, thread_id, to_agent, target_session_id, driver, wakeup_command, app_server_url, model, effort, cwd,
          enabled, in_flight, worker_pid, last_woken_seq, last_dispatched_at, last_delivered_at,
          last_receipt_json, last_turn_id, last_handled_by_client_id, last_error, consecutive_failures, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id, to_agent) DO UPDATE SET
          thread_id = excluded.thread_id,
          to_agent = excluded.to_agent,
          target_session_id = CASE WHEN excluded.target_session_id != '' THEN excluded.target_session_id ELSE wakeup_routes.target_session_id END,
          driver = excluded.driver,
          wakeup_command = COALESCE(excluded.wakeup_command, wakeup_routes.wakeup_command),
          app_server_url = COALESCE(excluded.app_server_url, wakeup_routes.app_server_url),
          model = COALESCE(excluded.model, wakeup_routes.model),
          effort = COALESCE(excluded.effort, wakeup_routes.effort),
          cwd = CASE WHEN excluded.cwd != '' THEN excluded.cwd ELSE wakeup_routes.cwd END,
          enabled = excluded.enabled,
          in_flight = excluded.in_flight,
          worker_pid = excluded.worker_pid,
          last_woken_seq = excluded.last_woken_seq,
          last_dispatched_at = excluded.last_dispatched_at,
          last_delivered_at = excluded.last_delivered_at,
          last_receipt_json = excluded.last_receipt_json,
          last_turn_id = excluded.last_turn_id,
          last_handled_by_client_id = excluded.last_handled_by_client_id,
          last_error = excluded.last_error,
          consecutive_failures = excluded.consecutive_failures,
          updated_at = excluded.updated_at`
      )
      .run(
        route.task_id,
        route.thread_id,
        route.to_agent,
        route.target_session_id || "",
        route.driver || "host_poll",
        route.wakeup_command || null,
        route.app_server_url || null,
        route.model || null,
        route.effort || null,
        route.cwd || "",
        route.enabled ? 1 : 0,
        route.in_flight ? 1 : 0,
        route.worker_pid ?? null,
        Number(route.last_woken_seq || 0),
        route.last_dispatched_at || null,
        route.last_delivered_at || null,
        receiptJson,
        route.last_turn_id || null,
        route.last_handled_by_client_id || null,
        route.last_error || null,
        Number(route.consecutive_failures || 0),
        route.updated_at
      );
    return this.getRoute(route.task_id, route.to_agent);
  }

  listRoutes({ enabledOnly = false } = {}) {
    const sql = enabledOnly
      ? `SELECT * FROM wakeup_routes WHERE enabled = 1`
      : `SELECT * FROM wakeup_routes`;
    return this.db
      .prepare(sql)
      .all()
      .map((r) => this._deserializeRoute(r));
  }

  _deserializeRoute(row) {
    return {
      ...row,
      consecutive_failures: Number(row.consecutive_failures || 0),
      last_receipt: row.last_receipt_json
        ? parseJsonSafe(row.last_receipt_json, null)
        : null,
    };
  }

  // ===========================================================================
  // Patches & Validations
  // ===========================================================================

  getPatch(patchId, { includeRawContent = true } = {}) {
    if (!patchId) return null;
    const row = this.db
      .prepare(`SELECT * FROM patches WHERE patch_id = ?`)
      .get(patchId);
    return row ? this._deserializePatch(row, { includeRawContent }) : null;
  }

  putPatch(patch) {
    this.db
      .prepare(
        `INSERT INTO patches (
          patch_id, seq, task_id, from_agent, to_agent, conversation_id, model,
          artifact_kind, raw_content, sha256, depends_on_json, supersedes, superseded_by,
          target_files_json, validation_json, status, summary, created_at, updated_at, applied_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          superseded_by = excluded.superseded_by,
          target_files_json = excluded.target_files_json,
          validation_json = excluded.validation_json,
          status = excluded.status,
          summary = excluded.summary,
          updated_at = excluded.updated_at,
          applied_at = excluded.applied_at`
      )
      .run(
        patch.patchId,
        Number(patch.seq || 0),
        patch.taskId,
        patch.fromAgent,
        patch.toAgent,
        patch.conversationId || null,
        patch.model || null,
        patch.artifactKind || "unified_diff",
        patch.rawContent,
        patch.sha256,
        JSON.stringify(patch.dependsOn || []),
        patch.supersedes || null,
        patch.supersededBy || null,
        JSON.stringify(patch.targetFiles || []),
        JSON.stringify(patch.validation || {}),
        patch.status || "submitted",
        patch.summary || "",
        patch.createdAt,
        patch.updatedAt,
        patch.appliedAt || null
      );
    return this.getPatch(patch.patchId, { includeRawContent: false });
  }

  listPatches({
    taskId = null,
    toAgent = null,
    afterSeq = null,
    activeOnly = false,
    includeRawContent = false,
    limit = null,
  } = {}) {
    const conds = [];
    const params = [];
    if (taskId) {
      conds.push(`task_id = ?`);
      params.push(taskId);
    }
    if (toAgent && toAgent !== "*") {
      conds.push(`(to_agent = ? OR from_agent = ?)`);
      params.push(toAgent, toAgent);
    }
    if (afterSeq !== null && afterSeq !== undefined) {
      conds.push(`seq > ?`);
      params.push(Number(afterSeq));
    }
    if (activeOnly) {
      conds.push(`status != 'superseded' AND superseded_by IS NULL`);
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
    const limitSql = limit ? `LIMIT ${Number(limit)}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM patches ${where} ORDER BY seq ASC ${limitSql}`)
      .all(...params);
    return rows.map((r) => this._deserializePatch(r, { includeRawContent }));
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
      dependsOn: parseJsonSafe(row.depends_on_json, []),
      supersedes: row.supersedes,
      supersededBy: row.superseded_by,
      targetFiles: parseJsonSafe(row.target_files_json, []),
      validation: parseJsonSafe(row.validation_json, {}),
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

  getValidation(id) {
    if (!id) return null;
    const row = this.db
      .prepare(`SELECT * FROM task_validations WHERE id = ?`)
      .get(id);
    return row ? this._deserializeValidation(row) : null;
  }

  putValidation(val) {
    this.db
      .prepare(
        `INSERT INTO task_validations (
          id, seq, task_id, validator_agent, patch_ids_json, applied, passed, summary, details_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        val.id,
        Number(val.seq || 0),
        val.taskId,
        val.validatorAgent,
        JSON.stringify(val.patchIds || []),
        val.applied ? 1 : 0,
        val.passed === null || val.passed === undefined
          ? null
          : val.passed
            ? 1
            : 0,
        val.summary || "",
        JSON.stringify(val.details || {}),
        val.createdAt
      );
    return this.getValidation(val.id);
  }

  listValidations({
    taskId = null,
    afterSeq = null,
    limit = 50,
    orderDesc = false,
  } = {}) {
    const conds = [];
    const params = [];
    if (taskId) {
      conds.push(`task_id = ?`);
      params.push(taskId);
    }
    if (afterSeq !== null && afterSeq !== undefined) {
      conds.push(`seq > ?`);
      params.push(Number(afterSeq));
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
    const dir = orderDesc ? "DESC" : "ASC";
    return this.db
      .prepare(
        `SELECT * FROM task_validations ${where} ORDER BY seq ${dir} LIMIT ?`
      )
      .all(...params, limit)
      .map((r) => this._deserializeValidation(r));
  }

  _deserializeValidation(v) {
    return {
      id: v.id,
      seq: Number(v.seq),
      taskId: v.task_id,
      validatorAgent: v.validator_agent,
      patchIds: parseJsonSafe(v.patch_ids_json, []),
      applied: Boolean(v.applied),
      passed: v.passed === null ? null : Boolean(v.passed),
      summary: v.summary,
      details: parseJsonSafe(v.details_json, {}),
      createdAt: v.created_at,
    };
  }

  // ===========================================================================
  // Shared Context & Agent Sessions
  // ===========================================================================

  getContext(key) {
    return (
      this.db.prepare(`SELECT * FROM shared_context WHERE key = ?`).get(key) ||
      null
    );
  }

  putContext(entry) {
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
      .run(
        entry.key,
        entry.value,
        entry.content_type || "text/plain",
        entry.updated_by,
        entry.description || "",
        entry.updated_at
      );
    return this.getContext(entry.key);
  }

  listContext() {
    return this.db
      .prepare(
        `SELECT key, content_type, updated_by, description, updated_at, LENGTH(value) AS byte_length
         FROM shared_context ORDER BY updated_at DESC`
      )
      .all();
  }

  getSession(sessionKey) {
    return (
      this.db
        .prepare(`SELECT * FROM agent_sessions WHERE session_key = ?`)
        .get(sessionKey) || null
    );
  }

  putSession(entry) {
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
        entry.session_key,
        entry.agent,
        entry.external_session_id || null,
        entry.model || null,
        entry.cwd || "",
        entry.summary || "",
        entry.last_prompt ?? "",
        entry.last_response ?? "",
        entry.updated_at
      );
    return this.getSession(entry.session_key);
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

  // ===========================================================================
  // Durable Effects Queue & HealthBoard
  // ===========================================================================

  enqueueEffect({
    kind,
    effectKey,
    payload = {},
    priority = "normal",
    dueMs = Date.now(),
    nowIso = new Date().toISOString(),
  }) {
    const seq = this.nextNamedSeq("effect_seq");
    this.db
      .prepare(
        `INSERT INTO bridge_effects (
          kind, effect_key, payload_json, seq, generation, priority, attempts, due_ms, last_error, since
        ) VALUES (?, ?, ?, ?, 0, ?, 0, ?, '', ?)
        ON CONFLICT(kind, effect_key) DO UPDATE SET
          payload_json = excluded.payload_json,
          seq = excluded.seq,
          generation = bridge_effects.generation + 1,
          priority = CASE WHEN excluded.priority = 'human_priority' OR bridge_effects.priority = 'human_priority' THEN 'human_priority' ELSE 'normal' END,
          attempts = 0,
          due_ms = excluded.due_ms`
      )
      .run(
        kind,
        effectKey,
        JSON.stringify(payload || {}),
        seq,
        priority === "human_priority" ? "human_priority" : "normal",
        Math.floor(Number(dueMs)),
        nowIso
      );
    const row = this.db
      .prepare(`SELECT * FROM bridge_effects WHERE kind = ? AND effect_key = ?`)
      .get(kind, effectKey);
    return this._deserializeEffect(row);
  }

  listEffects({ kind = null, dueBeforeMs = null, limit = 100 } = {}) {
    const conds = [];
    const params = [];
    if (kind) {
      conds.push(`kind = ?`);
      params.push(kind);
    }
    if (dueBeforeMs !== null && dueBeforeMs !== undefined) {
      conds.push(`due_ms <= ?`);
      params.push(Math.floor(Number(dueBeforeMs)));
    }
    const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT * FROM bridge_effects ${where}
         ORDER BY CASE priority WHEN 'human_priority' THEN 0 ELSE 1 END ASC, due_ms ASC, seq ASC
         LIMIT ?`
      )
      .all(...params, limit);
    return rows.map((r) => this._deserializeEffect(r));
  }

  completeEffect({ kind, effectKey, seq, generation }) {
    const res = this.db
      .prepare(
        `DELETE FROM bridge_effects WHERE kind = ? AND effect_key = ? AND seq = ? AND generation = ?`
      )
      .run(kind, effectKey, Number(seq), Number(generation));
    return Boolean(res && res.changes > 0);
  }

  deferEffect({
    kind,
    effectKey,
    seq,
    generation,
    dueMs,
    incrementAttempts = false,
    lastError = "",
  }) {
    const res = this.db
      .prepare(
        `UPDATE bridge_effects
         SET due_ms = ?,
             attempts = CASE WHEN ? = 1 THEN attempts + 1 ELSE attempts END,
             last_error = ?
         WHERE kind = ? AND effect_key = ? AND seq = ? AND generation = ?`
      )
      .run(
        Math.floor(Number(dueMs)),
        incrementAttempts ? 1 : 0,
        String(lastError || ""),
        kind,
        effectKey,
        Number(seq),
        Number(generation)
      );
    if (!res || res.changes === 0) return null;
    const row = this.db
      .prepare(`SELECT * FROM bridge_effects WHERE kind = ? AND effect_key = ?`)
      .get(kind, effectKey);
    return row ? this._deserializeEffect(row) : null;
  }

  _deserializeEffect(row) {
    return {
      kind: row.kind,
      effect_key: row.effect_key,
      payload: parseJsonSafe(row.payload_json, {}),
      seq: Number(row.seq),
      generation: Number(row.generation),
      priority: row.priority || "normal",
      attempts: Number(row.attempts || 0),
      due_ms: Number(row.due_ms),
      last_error: row.last_error || "",
      since: row.since,
    };
  }

  getTaskEvent(eventId) {
    const row = this.db.prepare(`SELECT * FROM bridge_task_events WHERE event_id = ?`).get(eventId);
    return row ? this._deserializeTaskEvent(row) : null;
  }

  putTaskEvent(event) {
    for (const field of ["eventId", "taskId", "kind", "payloadHash"]) {
      if (typeof event?.[field] !== "string" || !event[field].trim()) {
        throw new Error(`Task event requires ${field}`);
      }
    }
    return this.atomic(() => {
      const existing = this.getTaskEvent(event.eventId);
      if (existing) {
        if (existing.payloadHash !== event.payloadHash) {
          throw new Error(`TASK_EVENT_CONFLICT: ${event.eventId}`);
        }
        return existing;
      }
      this.db.prepare(`INSERT INTO bridge_task_events (
        event_id, task_id, kind, logical_key, payload_hash, contract_version,
        attempt_id, owner_epoch, payload_json, result_json, created_at, seq
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        event.eventId, event.taskId, event.kind, event.logicalKey ?? null,
        event.payloadHash, event.contractVersion ?? null, event.attemptId ?? null,
        event.ownerEpoch ?? null, JSON.stringify(event.payload ?? {}),
        event.result === undefined || event.result === null ? null : JSON.stringify(event.result),
        event.createdAt ?? new Date().toISOString(), event.seq ?? this.nextSeq()
      );
      return this.getTaskEvent(event.eventId);
    });
  }

  updateTaskEventResult(eventId, result) {
    return this.atomic(() => {
      const event = this.getTaskEvent(eventId);
      if (!event) throw new Error(`TASK_EVENT_NOT_FOUND: ${eventId}`);
      const encoded = JSON.stringify(result);
      if (encoded === undefined) throw new Error("Task event result must be JSON serializable");
      if (event.result !== null && JSON.stringify(event.result) !== encoded) {
        throw new Error(`TASK_EVENT_RESULT_CONFLICT: ${eventId}`);
      }
      this.db.prepare(`UPDATE bridge_task_events SET result_json = ? WHERE event_id = ?`).run(encoded, eventId);
      return this.getTaskEvent(eventId);
    });
  }

  listTaskEvents({ taskId = null, kind = null, logicalKey = null, limit = 50, orderDesc = true } = {}) {
    const conditions = [];
    const parameters = [];
    for (const [column, value] of [["task_id", taskId], ["kind", kind], ["logical_key", logicalKey]]) {
      if (value !== null) {
        conditions.push(`${column} = ?`);
        parameters.push(value);
      }
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const order = orderDesc ? "DESC" : "ASC";
    return this.db.prepare(`SELECT * FROM bridge_task_events ${where}
      ORDER BY seq ${order}, created_at ${order}, event_id ${order} LIMIT ?`)
      .all(...parameters, Math.max(0, Math.floor(Number(limit) || 0)))
      .map((row) => this._deserializeTaskEvent(row));
  }

  _deserializeTaskEvent(row) {
    return {
      eventId: row.event_id,
      taskId: row.task_id,
      kind: row.kind,
      logicalKey: row.logical_key,
      payloadHash: row.payload_hash,
      contractVersion: row.contract_version,
      attemptId: row.attempt_id,
      ownerEpoch: row.owner_epoch,
      payload: parseJsonSafe(row.payload_json, {}),
      result: parseJsonSafe(row.result_json, null),
      createdAt: row.created_at,
      seq: Number(row.seq),
    };
  }

  getHealth(component) {
    return (
      this.db
        .prepare(`SELECT * FROM bridge_health WHERE component = ?`)
        .get(component) || null
    );
  }

  putHealth(entry) {
    this.db
      .prepare(
        `INSERT INTO bridge_health (component, owner_pid, state, detail, consecutive_failures, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(component) DO UPDATE SET
           owner_pid = excluded.owner_pid,
           state = excluded.state,
           detail = excluded.detail,
           consecutive_failures = excluded.consecutive_failures,
           updated_at = excluded.updated_at`
      )
      .run(
        entry.component,
        Number(entry.owner_pid || 0),
        entry.state,
        entry.detail || "",
        Number(entry.consecutive_failures || 0),
        entry.updated_at
      );
    return this.getHealth(entry.component);
  }

  listHealth() {
    return this.db
      .prepare(`SELECT * FROM bridge_health ORDER BY component ASC`)
      .all();
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
    const activeLeases = this.listActiveLeases();
    const contextKeys = this.listContext();
    const recentSessions = this.listSessions(null, 10);
    const pendingEffects = this.db
      .prepare(
        `SELECT kind, COUNT(*) AS count FROM bridge_effects GROUP BY kind`
      )
      .all();

    return {
      dbPath: this.dbPath,
      currentCursor: this.getCurrentSeq(),
      control: this.getControl(),
      unreadMessages: unreadByAgent,
      tasks: tasksByPhase,
      patches: patchCounts,
      activeLeases,
      pendingEffects,
      health: this.listHealth(),
      sharedContextCount: contextKeys.length,
      recentSessions: recentSessions.map(
        ({ last_prompt, last_response, summary, ...s }) => ({
          ...s,
          summary: (summary || "").slice(0, 240),
        })
      ),
    };
  }
}
