import { PHASE_LABELS, verifyModelMatch } from "./model.mjs";

function deepClone(val) {
  return val === undefined ? undefined : structuredClone(val);
}

/**
 * Pure zero-I/O in-memory implementation of the Bridge Repository contract.
 * Supports nested `atomic()` transactions with full snapshot rollback and `afterCommit()` hooks,
 * enabling deterministic millisecond unit tests of `BridgeEngine`, Router, and Watchdog rules.
 */
export class MemoryRepositories {
  constructor() {
    this._state = {
      seq: 0,
      decisionSeq: 0,
      effectSeq: 0,
      control: {
        paused: false,
        changed_at: null,
        reason: null,
        router_mode: "observe",
        control_version: "",
        controls_hash: "",
      },
      tasks: new Map(),
      taskEvents: new Map(),
      leases: new Map(),
      mandates: new Map(),
      subscriptions: new Map(), // `${threadId}::${taskId}` -> sub
      decisions: new Map(),
      messages: new Map(),
      routes: new Map(),
      patches: new Map(),
      validations: new Map(),
      contexts: new Map(),
      sessions: new Map(),
      effects: new Map(), // `${kind}::${effectKey}` -> effect
      health: new Map(),
    };
    this._txDepth = 0;
    this._afterCommitQueue = [];
  }

  atomic(fn) {
    const snapshot = deepClone(this._state);
    const savedCallbacksLen = this._afterCommitQueue.length;
    this._txDepth += 1;
    let result;
    try {
      result = fn();
    } catch (err) {
      this._state = snapshot;
      this._afterCommitQueue.length = savedCallbacksLen;
      this._txDepth -= 1;
      throw err;
    }
    this._txDepth -= 1;
    if (this._txDepth === 0) {
      const callbacks = this._afterCommitQueue.splice(0, this._afterCommitQueue.length);
      for (const cb of callbacks) {
        cb();
      }
    }
    return result;
  }

  afterCommit(cb) {
    if (typeof cb !== "function") return;
    if (this._txDepth > 0) {
      this._afterCommitQueue.push(cb);
    } else {
      cb();
    }
  }

  nextSeq() {
    this._state.seq += 1;
    return this._state.seq;
  }

  getCurrentSeq() {
    return this._state.seq;
  }

  // Control
  getControl() {
    return deepClone(this._state.control);
  }

  setControl(patch = {}) {
    this._state.control = {
      ...this._state.control,
      ...patch,
    };
    return this.getControl();
  }

  // Tasks
  getTask(id) {
    const row = this._state.tasks.get(id);
    if (!row) return null;
    return this._formatTask(row);
  }

  putTask(task) {
    this._state.tasks.set(task.id, deepClone(task));
    return this.getTask(task.id);
  }

  listTasks({
    assignedTo = null,
    fromAgent = null,
    status = null,
    phase = null,
    limit = 50,
  } = {}) {
    let items = [...this._state.tasks.values()];
    if (assignedTo && assignedTo !== "*") {
      items = items.filter((t) => t.assigned_to === assignedTo);
    }
    if (fromAgent) {
      items = items.filter((t) => t.from_agent === fromAgent);
    }
    if (status) {
      items = items.filter((t) => t.status === status);
    }
    if (phase) {
      items = items.filter((t) => t.phase === phase);
    }
    items.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return items.slice(0, limit).map((t) => this._formatTask(t));
  }

  findNextClaimableTask(agent) {
    const rankPriority = (p) =>
      p === "urgent" ? 1 : p === "high" ? 2 : p === "normal" ? 3 : 4;
    const candidates = [...this._state.tasks.values()].filter(
      (t) =>
        t.assigned_to === agent &&
        (t.status === "pending" || t.status === "in_progress")
    );
    candidates.sort((a, b) => {
      const sa = a.status === "pending" ? 0 : 1;
      const sb = b.status === "pending" ? 0 : 1;
      if (sa !== sb) return sa - sb;
      const pa = rankPriority(a.priority);
      const pb = rankPriority(b.priority);
      if (pa !== pb) return pa - pb;
      return String(a.created_at).localeCompare(String(b.created_at));
    });
    return candidates[0]?.id || null;
  }

  _formatTask(row) {
    const metadata = deepClone(row.metadata || {});
    const permissions = deepClone(row.permissions || {});
    const phase = row.phase || (row.status === "completed" ? "completed" : "ready");
    const phaseLabel = row.phase_label || PHASE_LABELS[phase] || phase;
    return {
      id: row.id,
      from_agent: row.from_agent,
      assigned_to: row.assigned_to,
      title: row.title,
      prompt: row.prompt,
      cwd: row.cwd || "",
      priority: row.priority || "normal",
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
      required_model: row.required_model || null,
      actual_model: row.actual_model || null,
      required_conversation_id: row.required_conversation_id || null,
      bound_conversation_id: row.bound_conversation_id || null,
      delivery_version: Number(row.delivery_version || 0),
      permissions,
      lease_status: row.lease_status || "none",
      result: row.result ?? null,
      error: row.error ?? null,
      session_id: row.session_id ?? null,
      metadata,
      created_at: row.created_at,
      updated_at: row.updated_at,
      completed_at: row.completed_at ?? null,
    };
  }

  // Leases
  getLease(taskId) {
    return deepClone(this._state.leases.get(taskId) || null);
  }

  putLease(lease) {
    this._state.leases.set(lease.taskId, deepClone(lease));
    return this.getLease(lease.taskId);
  }

  listActiveLeases() {
    return [...this._state.leases.values()]
      .filter((l) => l.status === "active")
      .map((l) => ({
        task_id: l.taskId,
        agent: l.agent,
        status: l.status,
        granted_at: l.grantedAt,
      }));
  }

  // Mandates
  getMandate(taskId) {
    return deepClone(this._state.mandates.get(taskId) || null);
  }

  putMandate(mandate) {
    this._state.mandates.set(mandate.task_id, deepClone(mandate));
    return this.getMandate(mandate.task_id);
  }

  listMandates() {
    return [...this._state.mandates.values()].map(deepClone);
  }

  // Subscriptions
  getSubscription(threadId, taskId) {
    return deepClone(
      this._state.subscriptions.get(`${threadId}::${taskId}`) || null
    );
  }

  putSubscription(sub) {
    const key = `${sub.thread_id}::${sub.task_id}`;
    this._state.subscriptions.set(key, {
      thread_id: sub.thread_id,
      task_id: sub.task_id,
      mode: sub.mode || "direct",
      active: sub.active === undefined ? 1 : sub.active ? 1 : 0,
      created_at: sub.created_at || new Date().toISOString(),
    });
    return this.getSubscription(sub.thread_id, sub.task_id);
  }

  listSubscriptions({ threadId = null, taskId = null, activeOnly = false } = {}) {
    let items = [...this._state.subscriptions.values()];
    if (threadId) items = items.filter((s) => s.thread_id === threadId);
    if (taskId) items = items.filter((s) => s.task_id === taskId);
    if (activeOnly) items = items.filter((s) => Boolean(s.active));
    return items.map(deepClone);
  }

  // Router Decisions
  getDecision(id) {
    return deepClone(this._state.decisions.get(id) || null);
  }

  putDecision(decision) {
    if (!decision.seq) {
      this._state.decisionSeq += 1;
    }
    const record = {
      ...deepClone(decision),
      seq: Number(decision.seq || this._state.decisionSeq),
    };
    this._state.decisions.set(record.id, record);
    return deepClone(record);
  }

  listDecisions({
    threadId = null,
    taskId = null,
    outcome = null,
    limit = 50,
  } = {}) {
    let items = [...this._state.decisions.values()];
    if (threadId) items = items.filter((d) => d.thread_id === threadId);
    if (taskId) items = items.filter((d) => d.target_task_id === taskId);
    if (outcome) items = items.filter((d) => d.outcome === outcome);
    items.sort((a, b) => Number(b.seq) - Number(a.seq));
    return items.slice(0, limit).map(deepClone);
  }

  // Messages
  getMessage(id) {
    const row = this._state.messages.get(id);
    return row ? this._formatMessage(row) : null;
  }

  putMessage(msg) {
    this._state.messages.set(msg.id, deepClone(msg));
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
    let items = [...this._state.messages.values()];
    if (toAgent && toAgent !== "*") {
      items = items.filter(
        (m) => m.to_agent === toAgent || m.to_agent === "all"
      );
    }
    if (fromAgent) {
      items = items.filter((m) => m.from_agent === fromAgent);
    }
    if (threadId) {
      items = items.filter((m) => m.thread_id === threadId);
    }
    if (taskId) {
      items = items.filter((m) => m.task_id === taskId);
    }
    if (afterSeq !== null && afterSeq !== undefined) {
      items = items.filter((m) => Number(m.seq) > Number(afterSeq));
    }
    if (unreadOnly) {
      items = items.filter((m) => m.status === "unread");
    }

    if (afterSeq !== null && afterSeq !== undefined) {
      items.sort((a, b) => Number(a.seq) - Number(b.seq));
      return items.slice(0, limit).map((m) => this._formatMessage(m));
    }
    items.sort((a, b) => Number(b.seq) - Number(a.seq));
    return items
      .slice(0, limit)
      .reverse()
      .map((m) => this._formatMessage(m));
  }

  findFirstReply(messageId) {
    const replies = [...this._state.messages.values()]
      .filter((m) => m.reply_to === messageId)
      .sort((a, b) => Number(a.seq) - Number(b.seq));
    return replies[0] ? this._formatMessage(replies[0]) : null;
  }

  markPriorTaskMessagesProcessed({ taskId, toAgent, nowIso }) {
    for (const m of this._state.messages.values()) {
      if (m.task_id === taskId && m.to_agent === toAgent && m.status === "read") {
        if (!m.processed_at) m.processed_at = nowIso;
      }
    }
  }

  _formatMessage(row) {
    const metadata = deepClone(row.metadata || {});
    return {
      id: row.id,
      seq: Number(row.seq || 0),
      thread_id: row.thread_id,
      task_id: row.task_id || metadata.taskId || null,
      from_agent: row.from_agent,
      to_agent: row.to_agent,
      subject: row.subject || "",
      content: row.content,
      reply_to: row.reply_to || null,
      metadata,
      status: row.status || "unread",
      wakeup_status: row.wakeup_status || "none",
      wakeup_target_session: row.wakeup_target_session || null,
      wakeup_dispatched_at: row.wakeup_dispatched_at || null,
      wakeup_delivered_at: row.wakeup_delivered_at || null,
      wakeup_receipt: deepClone(row.wakeup_receipt || null),
      processed_at: row.processed_at || null,
      consumed_at: row.consumed_at || null,
      consumed_turn_id: row.consumed_turn_id || null,
      handback_reason: row.handback_reason || null,
      delivery_attempts: Number(row.delivery_attempts || 0),
      wakeup_error: row.wakeup_error || null,
      created_at: row.created_at,
      read_at: row.read_at || null,
      replyHint: {
        tool: "bridge_reply_message",
        arguments: {
          replyTo: row.id,
          content: "<your reply>",
        },
      },
    };
  }

  // Wakeup Routes
  getRoute(taskId, toAgent = null) {
    if (!taskId) return null;
    if (toAgent) return deepClone(this._state.routes.get(JSON.stringify([taskId, toAgent])) || null);
    const assigned = this._state.tasks.get(taskId)?.assigned_to;
    const items = this.listTaskRoutes(taskId).sort((a, b) =>
      Number(b.to_agent === assigned) - Number(a.to_agent === assigned) ||
      String(b.updated_at || "").localeCompare(String(a.updated_at || "")) ||
      String(a.to_agent).localeCompare(String(b.to_agent)));
    return items[0] || null;
  }

  listTaskRoutes(taskId) {
    return [...this._state.routes.values()].filter((row) => row.task_id === taskId)
      .sort((a, b) => String(a.to_agent).localeCompare(String(b.to_agent))).map(deepClone);
  }

  putRoute(route) {
    const existing = this.getRoute(route.task_id, route.to_agent);
    const saved = { ...existing, ...route };
    if (existing) {
      for (const key of ["model", "effort", "wakeup_command", "app_server_url"]) {
        saved[key] = route[key] || existing[key] || null;
      }
      for (const key of ["cwd", "target_session_id"]) saved[key] = route[key] || existing[key] || "";
    }
    this._state.routes.set(JSON.stringify([route.task_id, route.to_agent]), deepClone(saved));
    return this.getRoute(route.task_id, route.to_agent);
  }

  listRoutes({ enabledOnly = false } = {}) {
    let items = [...this._state.routes.values()];
    if (enabledOnly) items = items.filter((r) => Boolean(r.enabled));
    return items.map(deepClone);
  }

  // Patches
  getPatch(patchId, { includeRawContent = true } = {}) {
    const row = this._state.patches.get(patchId);
    if (!row) return null;
    return this._formatPatch(row, { includeRawContent });
  }

  putPatch(patch) {
    this._state.patches.set(patch.patchId, deepClone(patch));
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
    let items = [...this._state.patches.values()];
    if (taskId) items = items.filter((p) => p.taskId === taskId);
    if (toAgent && toAgent !== "*") {
      items = items.filter(
        (p) => p.toAgent === toAgent || p.fromAgent === toAgent
      );
    }
    if (afterSeq !== null && afterSeq !== undefined) {
      items = items.filter((p) => Number(p.seq) > Number(afterSeq));
    }
    if (activeOnly) {
      items = items.filter(
        (p) => p.status !== "superseded" && !p.supersededBy
      );
    }
    items.sort((a, b) => Number(a.seq) - Number(b.seq));
    if (limit) items = items.slice(0, limit);
    return items.map((p) => this._formatPatch(p, { includeRawContent }));
  }

  _formatPatch(row, { includeRawContent = true } = {}) {
    const out = {
      patchId: row.patchId,
      seq: Number(row.seq || 0),
      taskId: row.taskId,
      fromAgent: row.fromAgent,
      toAgent: row.toAgent,
      conversationId: row.conversationId || null,
      model: row.model || null,
      artifactKind: row.artifactKind || "unified_diff",
      sha256: row.sha256,
      byteLength: Buffer.byteLength(row.rawContent || "", "utf8"),
      dependsOn: deepClone(row.dependsOn || []),
      supersedes: row.supersedes || null,
      supersededBy: row.supersededBy || null,
      targetFiles: deepClone(row.targetFiles || []),
      validation: deepClone(row.validation || {}),
      status: row.status || "submitted",
      summary: row.summary || "",
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      appliedAt: row.appliedAt || null,
    };
    if (includeRawContent) {
      out.rawContent = row.rawContent;
    }
    return out;
  }

  // Validations
  getValidation(id) {
    return deepClone(this._state.validations.get(id) || null);
  }

  putValidation(val) {
    this._state.validations.set(val.id, deepClone(val));
    return this.getValidation(val.id);
  }

  listValidations({
    taskId = null,
    afterSeq = null,
    limit = 50,
    orderDesc = false,
  } = {}) {
    let items = [...this._state.validations.values()];
    if (taskId) items = items.filter((v) => v.taskId === taskId);
    if (afterSeq !== null && afterSeq !== undefined) {
      items = items.filter((v) => Number(v.seq) > Number(afterSeq));
    }
    items.sort((a, b) =>
      orderDesc
        ? Number(b.seq) - Number(a.seq)
        : Number(a.seq) - Number(b.seq)
    );
    return items.slice(0, limit).map(deepClone);
  }

  // Shared Context
  getContext(key) {
    return deepClone(this._state.contexts.get(key) || null);
  }

  putContext(entry) {
    const existing = this._state.contexts.get(entry.key);
    const merged = {
      key: entry.key,
      value: entry.value,
      content_type: entry.content_type || "text/plain",
      updated_by: entry.updated_by,
      description:
        entry.description !== ""
          ? entry.description
          : existing?.description || "",
      updated_at: entry.updated_at,
    };
    this._state.contexts.set(entry.key, merged);
    return this.getContext(entry.key);
  }

  listContext() {
    return [...this._state.contexts.values()]
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
      .map((c) => ({
        key: c.key,
        content_type: c.content_type,
        updated_by: c.updated_by,
        description: c.description,
        updated_at: c.updated_at,
        byte_length: Buffer.byteLength(c.value || "", "utf8"),
      }));
  }

  // Sessions
  getSession(key) {
    return deepClone(this._state.sessions.get(key) || null);
  }

  putSession(entry) {
    const existing = this._state.sessions.get(entry.session_key);
    const merged = {
      session_key: entry.session_key,
      agent: entry.agent,
      external_session_id:
        entry.external_session_id || existing?.external_session_id || null,
      model: entry.model || existing?.model || null,
      cwd: entry.cwd !== "" ? entry.cwd : existing?.cwd || "",
      summary: entry.summary !== "" ? entry.summary : existing?.summary || "",
      last_prompt: entry.last_prompt ?? "",
      last_response: entry.last_response ?? "",
      updated_at: entry.updated_at,
    };
    this._state.sessions.set(entry.session_key, merged);
    return this.getSession(entry.session_key);
  }

  listSessions(agent = null, limit = 20) {
    let items = [...this._state.sessions.values()];
    if (agent) items = items.filter((s) => s.agent === agent);
    items.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    return items.slice(0, limit).map(deepClone);
  }

  // Durable Effects
  enqueueEffect({
    kind,
    effectKey,
    payload = {},
    priority = "normal",
    dueMs = Date.now(),
    nowIso = new Date().toISOString(),
  }) {
    const mapKey = `${kind}::${effectKey}`;
    const existing = this._state.effects.get(mapKey);
    this._state.effectSeq += 1;
    const seq = this._state.effectSeq;
    const record = {
      kind,
      effect_key: effectKey,
      payload: deepClone(payload),
      seq,
      generation: existing ? Number(existing.generation || 0) + 1 : 0,
      priority:
        priority === "human_priority" || existing?.priority === "human_priority"
          ? "human_priority"
          : "normal",
      attempts: 0,
      due_ms: Number(dueMs),
      last_error: "",
      since: existing?.since || nowIso,
    };
    this._state.effects.set(mapKey, record);
    return deepClone(record);
  }

  listEffects({ kind = null, dueBeforeMs = null, limit = 100 } = {}) {
    let items = [...this._state.effects.values()];
    if (kind) items = items.filter((e) => e.kind === kind);
    if (dueBeforeMs !== null && dueBeforeMs !== undefined) {
      items = items.filter((e) => Number(e.due_ms) <= Number(dueBeforeMs));
    }
    items.sort((a, b) => {
      const pa = a.priority === "human_priority" ? 0 : 1;
      const pb = b.priority === "human_priority" ? 0 : 1;
      if (pa !== pb) return pa - pb;
      if (a.due_ms !== b.due_ms) return a.due_ms - b.due_ms;
      return a.seq - b.seq;
    });
    return items.slice(0, limit).map(deepClone);
  }

  completeEffect({ kind, effectKey, seq, generation }) {
    const mapKey = `${kind}::${effectKey}`;
    const existing = this._state.effects.get(mapKey);
    if (
      existing &&
      existing.seq === Number(seq) &&
      existing.generation === Number(generation)
    ) {
      this._state.effects.delete(mapKey);
      return true;
    }
    return false;
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
    const mapKey = `${kind}::${effectKey}`;
    const existing = this._state.effects.get(mapKey);
    if (
      !existing ||
      existing.seq !== Number(seq) ||
      existing.generation !== Number(generation)
    ) {
      return null;
    }
    existing.due_ms = Number(dueMs);
    if (incrementAttempts) {
      existing.attempts = Number(existing.attempts || 0) + 1;
    }
    if (lastError !== undefined) {
      existing.last_error = String(lastError || "");
    }
    return deepClone(existing);
  }

  // Immutable task events; mutations participate in the surrounding atomic snapshot.
  getTaskEvent(eventId) {
    return deepClone(this._state.taskEvents.get(eventId) || null);
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
      const saved = {
        eventId: event.eventId,
        taskId: event.taskId,
        kind: event.kind,
        logicalKey: event.logicalKey ?? null,
        payloadHash: event.payloadHash,
        contractVersion: event.contractVersion ?? null,
        attemptId: event.attemptId ?? null,
        ownerEpoch: event.ownerEpoch ?? null,
        payload: event.payload ?? {},
        result: event.result ?? null,
        createdAt: event.createdAt ?? new Date().toISOString(),
        seq: event.seq ?? this.nextSeq(),
      };
      // Keep both repository implementations on the same JSON persistence boundary.
      this._state.taskEvents.set(event.eventId, JSON.parse(JSON.stringify(saved)));
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
      event.result = JSON.parse(encoded);
      this._state.taskEvents.set(eventId, event);
      return this.getTaskEvent(eventId);
    });
  }

  listTaskEvents({ taskId = null, kind = null, logicalKey = null, limit = 50, orderDesc = true } = {}) {
    return [...this._state.taskEvents.values()]
      .filter((event) => (taskId === null || event.taskId === taskId) &&
        (kind === null || event.kind === kind) &&
        (logicalKey === null || event.logicalKey === logicalKey))
      .sort((a, b) => (orderDesc ? -1 : 1) *
        (a.seq - b.seq || a.createdAt.localeCompare(b.createdAt) || a.eventId.localeCompare(b.eventId)))
      .slice(0, Math.max(0, Math.floor(Number(limit) || 0)))
      .map(deepClone);
  }

  // HealthBoard
  getHealth(component) {
    return deepClone(this._state.health.get(component) || null);
  }

  putHealth(entry) {
    this._state.health.set(entry.component, deepClone(entry));
    return this.getHealth(entry.component);
  }

  listHealth() {
    return [...this._state.health.values()].map(deepClone);
  }
}
