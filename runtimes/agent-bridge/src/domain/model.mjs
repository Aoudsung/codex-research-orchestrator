import crypto from "node:crypto";

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

export const ROUTER_MODES = ["off", "observe", "auto"];
export const ISOLATION_PROFILES = ["shared", "blind_analysis", "blind_review"];
export const SUBSCRIPTION_MODES = ["direct", "context"];
export const EFFECT_KINDS = [
  "wakeup",
  "launch",
  "fanout",
  "control_notice",
  "channel_check",
];

export const HANDOFF_REASON_CODES = [
  "scientific_ambiguity",
  "mechanism_change_needed",
  "permission_delta",
  "budget_exceeded",
  "constraint_conflict",
  "out_of_mandate",
  "external_dependency",
];

export const LEAD_ESCALATION_REASONS = new Set([
  "scientific_ambiguity",
  "mechanism_change_needed",
  "out_of_mandate",
]);

export const HUMAN_ATTENTION_REASONS = new Set([
  "permission_delta",
  "budget_exceeded",
  "constraint_conflict",
  "external_dependency",
]);

export const REASONS = Object.freeze({
  BRIDGE_PAUSED: "BRIDGE_PAUSED",
  MISSING_RECIPIENT: "MISSING_RECIPIENT",
  SELF_ROUTING_REJECTED: "SELF_ROUTING_REJECTED",
  REPLY_TARGET_NOT_FOUND: "REPLY_TARGET_NOT_FOUND",
  TASK_NOT_FOUND: "TASK_NOT_FOUND",
  TASK_SCOPE_CONFLICT: "TASK_SCOPE_CONFLICT",
  MODEL_UNVERIFIED: "MODEL_UNVERIFIED",
  MODEL_MISMATCH: "MODEL_MISMATCH",
  CONVERSATION_MISMATCH: "CONVERSATION_MISMATCH",
  BLIND_ISOLATION_VIOLATION: "BLIND_ISOLATION_VIOLATION",
  PARAPHRASE_GUARD_VIOLATION: "PARAPHRASE_GUARD_VIOLATION",
  MANDATE_REVOKED: "MANDATE_REVOKED",
  MANDATE_MODE_DOWNGRADED: "MANDATE_MODE_DOWNGRADED",
  CONTROL_VERSION_CHANGED: "CONTROL_VERSION_CHANGED",
  PEER_DISALLOWED: "PEER_DISALLOWED",
  INVALID_ROUTER_MODE: "INVALID_ROUTER_MODE",
  INVALID_SUBSCRIPTION_MODE: "INVALID_SUBSCRIPTION_MODE",
  INVALID_HANDBACK_REASON: "INVALID_HANDBACK_REASON",
  INVALID_CARD_URI: "INVALID_CARD_URI",
  CARD_NOT_FOUND: "CARD_NOT_FOUND",
  DECISION_NOT_FOUND: "DECISION_NOT_FOUND",
  DELIVERY_CIRCUIT_OPEN: "DELIVERY_CIRCUIT_OPEN",
});

export class BridgeUserError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [values]
   */
  constructor(code, message, values = {}) {
    super(message);
    this.name = "BridgeUserError";
    this.code = code;
    this.values = values;
  }
}

/**
 * Compute SHA-256 hex digest of UTF-8 string or Buffer.
 * Pure deterministic helper with zero filesystem/network I/O.
 * @param {string | Buffer} content
 */
export function sha256Hex(content) {
  return crypto.createHash("sha256").update(content ?? "", "utf8").digest("hex");
}

/**
 * Canonicalize model IDs so aliases like "Synthetic Model (High)" and "synthetic-model-high"
 * can be compared deterministically while preserving exact model strings.
 * @param {string | null | undefined} model
 */
export function normalizeModelId(model) {
  if (!model || typeof model !== "string") return "";
  return model
    .trim()
    .toLowerCase()
    .replace(/[()[\]]/g, " ")
    .replace(/[^a-z0-9.+-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Verify whether `actualModel` satisfies `requiredModel`.
 * Never silently falls back when `requiredModel` is specified.
 */
export function verifyModelMatch(
  requiredModel,
  actualModel,
  source = "runtime_init_metadata"
) {
  if (!requiredModel) {
    return {
      ok: true,
      requiredModel: null,
      actualModel: actualModel || null,
      verifiedBy: source,
      normalizedRequired: null,
      normalizedActual: normalizeModelId(actualModel),
    };
  }

  if (!actualModel) {
    return {
      ok: false,
      code: REASONS.MODEL_UNVERIFIED,
      requiredModel,
      actualModel: null,
      verifiedBy: source,
      error: `Task strictly requires model '${requiredModel}', but actual runtime model metadata was not present (source: ${source}). Silent fallback to default CLI model is forbidden.`,
    };
  }

  const normReq = normalizeModelId(requiredModel);
  const normAct = normalizeModelId(actualModel);

  if (normReq !== normAct) {
    return {
      ok: false,
      code: REASONS.MODEL_MISMATCH,
      requiredModel,
      actualModel,
      verifiedBy: source,
      normalizedRequired: normReq,
      normalizedActual: normAct,
      error: `Model mismatch: task strictly requires '${requiredModel}' (normalized: '${normReq}'), but runtime metadata reported '${actualModel}' (normalized: '${normAct}'). Silent fallback is forbidden.`,
    };
  }

  return {
    ok: true,
    requiredModel,
    actualModel,
    verifiedBy: source,
    normalizedRequired: normReq,
    normalizedActual: normAct,
  };
}

/**
 * Resolve isolation profile from mandate or task metadata.
 * @param {object | null | undefined} target
 * @returns {'shared' | 'blind_analysis' | 'blind_review'}
 */
export function resolveIsolationProfile(target) {
  if (!target || typeof target !== "object") return "shared";
  const explicit =
    target.isolation_profile ||
    target.isolationProfile ||
    target.metadata?.isolationProfile ||
    target.metadata?.isolation_profile ||
    null;
  if (explicit === "blind_analysis" || explicit === "blind_review") {
    return explicit;
  }
  const role = String(
    target.role || target.metadata?.role || target.metadata?.researchRole || ""
  )
    .trim()
    .toLowerCase();
  if (
    role === "blind_review" ||
    role === "blind-reviewer" ||
    role === "reviewer_blind" ||
    target.metadata?.blindReview === true
  ) {
    return "blind_review";
  }
  if (
    role === "blind_analysis" ||
    role === "blind-analyst" ||
    target.metadata?.blindAnalysis === true ||
    target.metadata?.blindIsolated === true
  ) {
    return "blind_analysis";
  }
  return "shared";
}

/**
 * Returns true when a mandate or task operates under blind analysis or blind review isolation.
 * Router must strictly block cross-thread fan-out and ambient history inheritance for isolated tasks.
 * @param {object | null | undefined} mandateOrTask
 */
export function isBlindIsolated(mandateOrTask) {
  const profile = resolveIsolationProfile(mandateOrTask);
  return profile === "blind_analysis" || profile === "blind_review";
}

/**
 * Filter messages that reached phase 1 (`wakeup_status === 'delivered'`)
 * but have NOT reached phase 2 (`consumed_at` / `read_at` / `processed_at`) within `graceMs`.
 *
 * @param {Array<object>} messages
 * @param {{ nowMs?: number, graceMs?: number }} [options]
 */
export function unconsumedMessages(
  messages = [],
  { nowMs = Date.now(), graceMs = 15000 } = {}
) {
  if (!Array.isArray(messages)) return [];
  const results = [];
  for (const m of messages) {
    if (!m) continue;
    const wakeupStatus = m.wakeup_status || m.wakeupStatus || "none";
    if (wakeupStatus !== "delivered") continue;
    const consumedAt = m.consumed_at || m.consumedAt || null;
    const processedAt = m.processed_at || m.processedAt || null;
    const status = m.status || "unread";
    if (consumedAt || processedAt || status !== "unread") continue;

    const deliveredIso =
      m.wakeup_delivered_at ||
      m.wakeupDeliveredAt ||
      m.created_at ||
      m.createdAt ||
      null;
    const deliveredMs = deliveredIso ? Date.parse(deliveredIso) : 0;
    if (!Number.isFinite(deliveredMs) || nowMs - deliveredMs >= graceMs) {
      results.push(m);
    }
  }
  return results;
}

/**
 * Deterministically classify a task/system item into a single canonical attention stage.
 * Priority order:
 * 1. person/delivery_failed
 * 2. person/permission_delta
 * 3. person/answer
 * 4. person/stall_detected
 * 5. person/review
 * 6. observe/would_dispatch
 * 7. working/queued
 * 8. working
 * 9. idle
 */
export function attentionStage(
  task,
  route = null,
  health = null,
  { pendingDecisions = [], queuedEffects = [], stallAlert = null } = {}
) {
  const consecutiveFailures = Number(
    route?.consecutive_failures ?? route?.consecutiveFailures ?? 0
  );
  const circuitOpen =
    consecutiveFailures >= 3 ||
    task?.metadata?.deliveryCircuitOpen === true ||
    health?.state === "error";
  if (circuitOpen) {
    return "person/delivery_failed";
  }

  const handback = task?.metadata?.handback || null;
  const unresolvedHandback = handback && !handback.resolvedAt ? handback : null;
  const attentionMeta =
    task?.metadata?.attention && !task.metadata.attention.resolvedAt
      ? task.metadata.attention
      : null;

  if (
    attentionMeta?.kind === "permission_delta" ||
    (unresolvedHandback &&
      HUMAN_ATTENTION_REASONS.has(unresolvedHandback.reasonCode))
  ) {
    return "person/permission_delta";
  }

  const humanAction =
    (task?.metadata?.humanAction && !task.metadata.humanAction.resolvedAt
      ? task.metadata.humanAction
      : null) ||
    (unresolvedHandback?.humanAction ? unresolvedHandback.humanAction : null);
  if (humanAction && humanAction.question) {
    return "person/answer";
  }

  if (stallAlert || (task?.metadata?.stallAlert && !task.metadata.stallAlert.resolvedAt)) {
    return "person/stall_detected";
  }

  if (
    task?.phase === "awaiting_review" ||
    (unresolvedHandback &&
      LEAD_ESCALATION_REASONS.has(unresolvedHandback.reasonCode))
  ) {
    return "person/review";
  }

  const hasObserveProposal = Array.isArray(pendingDecisions) &&
    pendingDecisions.some(
      (d) =>
        d &&
        d.outcome === "would_dispatch" &&
        (!task?.id || !d.target_task_id || d.target_task_id === task.id)
    );
  if (hasObserveProposal) {
    return "observe/would_dispatch";
  }

  const taskId = task?.id || null;
  const isQueued =
    taskId &&
    Array.isArray(queuedEffects) &&
    queuedEffects.some((e) => e && e.effect_key === taskId);
  if (isQueued) {
    return "working/queued";
  }

  if (
    task &&
    !["completed", "failed", "cancelled"].includes(task.status) &&
    [
      "in_progress",
      "awaiting_validation",
      "awaiting_revision",
      "patch_delivered",
      "cli_turn_ended",
    ].includes(task.phase)
  ) {
    return "working";
  }

  return "idle";
}

/**
 * Pure topological sort over active patches for a task.
 * Throws deterministic errors on missing prerequisites or dependency cycles.
 * @param {Array<{ patchId: string, dependsOn?: string[] }>} patches
 * @returns {string[]}
 */
export function computePatchApplyOrder(patches = []) {
  const byId = new Map(patches.map((p) => [p.patchId, p]));
  const visited = new Set();
  const visiting = new Set();
  const order = [];

  const visit = (p) => {
    if (visited.has(p.patchId)) return;
    if (visiting.has(p.patchId)) {
      throw new Error(`Patch dependency cycle at ${p.patchId}`);
    }
    visiting.add(p.patchId);
    for (const depId of p.dependsOn || []) {
      if (!byId.has(depId)) {
        throw new Error(`Missing active patch prerequisite: ${depId}`);
      }
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
