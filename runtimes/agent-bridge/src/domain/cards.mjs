import { BridgeUserError, REASONS, sha256Hex } from "./model.mjs";

export const DEFAULT_PREVIEW_CHARS = 200;
export const DEFAULT_PAGE_LIMIT = 4000;
export const MAX_PAGE_LIMIT = 65536;

/**
 * Collapse multi-line text into a single-line compact preview <= `maxChars` UTF-16 code units,
 * without splitting surrogate pairs.
 * @param {string | null | undefined} text
 * @param {number} [maxChars]
 */
export function foldPreview(text, maxChars = DEFAULT_PREVIEW_CHARS) {
  const collapsed = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const cps = Array.from(collapsed);
  if (cps.length <= maxChars) {
    return collapsed;
  }
  const cut = Math.max(1, maxChars - 1);
  return `${cps.slice(0, cut).join("")}…`;
}

/**
 * Parse a `bridge://<kind>/<id>[?field=<field>]` Spill URI.
 * @param {string} uri
 */
export function parseCardUri(uri) {
  if (typeof uri !== "string" || !uri.startsWith("bridge://")) {
    throw new BridgeUserError(
      REASONS.INVALID_CARD_URI,
      `Invalid card URI '${uri}': expected 'bridge://<kind>/<id>'.`,
      { uri }
    );
  }
  const withoutScheme = uri.slice("bridge://".length);
  const [pathPart, queryPart = ""] = withoutScheme.split("?", 2);
  const slashIdx = pathPart.indexOf("/");
  if (slashIdx <= 0 || slashIdx === pathPart.length - 1) {
    throw new BridgeUserError(
      REASONS.INVALID_CARD_URI,
      `Invalid card URI '${uri}': expected non-empty '<kind>/<id>'.`,
      { uri }
    );
  }
  const kind = decodeURIComponent(pathPart.slice(0, slashIdx));
  const id = decodeURIComponent(pathPart.slice(slashIdx + 1));
  const params = new URLSearchParams(queryPart);
  const field = params.get("field") || null;

  return { uri, kind, id, field };
}

/**
 * Build a compact Inline Card for a task.
 */
export function taskCard(task, mandate = null, stage = "idle") {
  const body = String(task?.result || task?.error || task?.prompt || "");
  return {
    kind: "task",
    id: task.id,
    title: task.title || "",
    fromAgent: task.from_agent,
    assignedTo: task.assigned_to,
    status: task.status,
    phase: task.phase,
    phaseLabel: task.phase_label,
    attentionStage: stage,
    isolationProfile: mandate?.isolation_profile || "shared",
    controlVersion: mandate?.control_version || "",
    deliveryVersion: Number(task.delivery_version || 0),
    chars: body.length,
    sha256: sha256Hex(body),
    preview: foldPreview(body),
    read: `bridge://task/${encodeURIComponent(task.id)}`,
  };
}

/**
 * Build a compact Inline Card for a message, optionally attaching a Watchdog `RecoveryNote`.
 */
export function messageCard(msg, { recoveryNote = null } = {}) {
  const content = String(msg?.content || "");
  const card = {
    kind: "message",
    id: msg.id,
    seq: Number(msg.seq || 0),
    threadId: msg.thread_id,
    taskId: msg.task_id || null,
    fromAgent: msg.from_agent,
    toAgent: msg.to_agent,
    subject: msg.subject || "",
    status: msg.status || "unread",
    wakeupStatus: msg.wakeup_status || "none",
    consumedAt: msg.consumed_at || null,
    handbackReason: msg.handback_reason || null,
    chars: content.length,
    sha256: sha256Hex(content),
    preview: foldPreview(content),
    createdAt: msg.created_at,
    read: `bridge://message/${encodeURIComponent(msg.id)}`,
  };
  if (recoveryNote) {
    card.recoveryNote = recoveryNote;
  }
  return card;
}

/**
 * Build a compact Inline Card for a patch artifact.
 */
export function patchCard(patch) {
  const raw = typeof patch.rawContent === "string" ? patch.rawContent : null;
  const byteLength =
    patch.byteLength ??
    (raw !== null ? Buffer.byteLength(raw, "utf8") : 0);
  const summaryText = patch.summary || (raw ? foldPreview(raw) : "");
  return {
    kind: "patch",
    id: patch.patchId,
    seq: Number(patch.seq || 0),
    taskId: patch.taskId,
    fromAgent: patch.fromAgent,
    toAgent: patch.toAgent,
    artifactKind: patch.artifactKind,
    status: patch.status,
    supersedes: patch.supersedes || null,
    supersededBy: patch.supersededBy || null,
    targetFiles: Array.isArray(patch.targetFiles)
      ? patch.targetFiles.slice(0, 12)
      : [],
    byteLength,
    sha256: patch.sha256,
    preview: foldPreview(summaryText),
    createdAt: patch.createdAt,
    read: `bridge://patch/${encodeURIComponent(patch.patchId)}`,
  };
}

/**
 * Build a compact Inline Card for a validation record.
 */
export function validationCard(val) {
  const summary = String(val?.summary || "");
  return {
    kind: "validation",
    id: val.id,
    seq: Number(val.seq || 0),
    taskId: val.taskId || val.task_id,
    validatorAgent: val.validatorAgent || val.validator_agent,
    patchIds: Array.isArray(val.patchIds)
      ? val.patchIds
      : JSON.parse(val.patch_ids_json || "[]"),
    applied: Boolean(val.applied),
    passed:
      val.passed === null || val.passed === undefined
        ? null
        : Boolean(val.passed),
    chars: summary.length,
    sha256: sha256Hex(summary),
    preview: foldPreview(summary),
    createdAt: val.createdAt || val.created_at,
    read: `bridge://validation/${encodeURIComponent(val.id)}`,
  };
}

/**
 * Build an actionable Attention Card for Workbench and Lead Researcher escalation.
 */
export function attentionCard({
  id,
  stage,
  severity = "warning",
  taskId = null,
  threadId = null,
  decisionId = null,
  title = "",
  reasonCode = "",
  detail = "",
  humanAction = null,
  actions = [],
  createdAt = null,
  read = null,
}) {
  const body = String(detail || humanAction?.question || title || "");
  return {
    kind: "attention",
    id,
    stage,
    severity,
    taskId,
    threadId,
    decisionId,
    title,
    reasonCode,
    preview: foldPreview(body),
    chars: body.length,
    humanAction: humanAction || null,
    actions,
    createdAt,
    read:
      read ||
      (taskId
        ? `bridge://task/${encodeURIComponent(taskId)}`
        : decisionId
          ? `bridge://decision/${encodeURIComponent(decisionId)}`
          : null),
  };
}

/**
 * Paginate an arbitrarily large text resource by Unicode code points without losing bytes
 * or splitting surrogate pairs (matching Workbench `reader.mjs` code-point pagination).
 * Concatenating `chunk` from `offset = 0` using `next_offset` until `next_offset === null`
 * reproduces `text` identically (`sha256Hex(concatenated) === page.sha256`).
 */
export function textPage({
  uri,
  text,
  offset = 0,
  limit = DEFAULT_PAGE_LIMIT,
}) {
  const str = String(text ?? "");
  const codePoints = Array.from(str);
  const totalChars = codePoints.length;
  const safeOffset = Math.max(
    0,
    Math.min(totalChars, Math.floor(Number(offset) || 0))
  );
  const safeLimit = Math.max(
    1,
    Math.min(MAX_PAGE_LIMIT, Math.floor(Number(limit) || DEFAULT_PAGE_LIMIT))
  );

  const end = Math.min(totalChars, safeOffset + safeLimit);
  const chunkCps = codePoints.slice(safeOffset, end);
  const chunk = chunkCps.join("");
  const hasMore = end < totalChars;
  const nextOffset = hasMore ? end : null;

  return {
    uri,
    chunk,
    offset: safeOffset,
    limit: safeLimit,
    chars: chunkCps.length,
    total_chars: totalChars,
    totalChars,
    has_more: hasMore,
    hasMore,
    next_offset: nextOffset,
    nextOffset,
    sha256: sha256Hex(str),
  };
}

/**
 * Format a compact Wakeup Trigger Prompt using Inline Cards & Spill Pointers.
 */
export function formatCompactWakeupPrompt({
  route,
  messages = [],
  maxSeq = 0,
  recoveryNote = null,
}) {
  const cards = messages.map((m) => messageCard(m, { recoveryNote }));
  const lines = [
    `[MCP Inbox Wakeup] ${cards.length} unread message(s) [${cards.map((c) => c.id).join(", ")}] (up to seq=${maxSeq}) arrived for taskId=${route.task_id}, threadId=${route.thread_id}.`,
  ];
  if (recoveryNote) {
    lines.push(`[Watchdog RecoveryNote] ${recoveryNote}`);
  }
  if (cards.length > 0) {
    lines.push("Inline Message Cards:");
    for (const c of cards) {
      lines.push(
        `- [seq=${c.seq}] (${c.fromAgent} -> ${c.toAgent}) ${c.subject || "(no subject)"} | preview="${c.preview}" (${c.chars} chars, read=${c.read})`
      );
    }
  }
  lines.push(
    `Call bridge_read_messages(toAgent="${route.to_agent}", taskId="${route.task_id}", unreadOnly=true) to inspect & mark consumed, or bridge_read_card(uri="bridge://message/<id>") for paginated spill reading.`
  );
  return lines.join("\n");
}
