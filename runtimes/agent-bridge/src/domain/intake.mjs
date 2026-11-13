import {
  BridgeUserError,
  REASONS,
  SUBSCRIPTION_MODES,
  isBlindIsolated,
  resolveCognitiveProfile,
} from "./model.mjs";

export const MAX_ROUTING_NOTE_WORDS = 60;
export const MAX_ROUTING_NOTE_CHARS = 180;
export const MAX_PRO_MACRO_WORDS = 850;
export const MAX_PRO_MACRO_CHARS = 6000;

/**
 * Zero-Clutter Macro-Inquiry Lint Guard for ChatGPT Pro (`pro_macro`):
 * Rejects technical clutter (fenced code blocks, unified diffs, itemized ledger dumps,
 * rigid deliverable status checklists, or oversized framing) when dispatching a `pro_macro` task.
 */
export function validateProMacroPrompt(
  prompt,
  { cognitiveProfile = null, requiredModel = null, metadata = {} } = {}
) {
  const resolved =
    cognitiveProfile ||
    resolveCognitiveProfile({ requiredModel, metadata }) ||
    null;
  if (resolved?.adapter !== "pro_macro" || metadata?.allowTechnicalPrompt === true) {
    return { ok: true, enforced: false };
  }

  const text = String(prompt ?? "").trim();
  const chars = text.length;
  const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
  const violations = [];

  if (chars > MAX_PRO_MACRO_CHARS || words > MAX_PRO_MACRO_WORDS) {
    violations.push(
      `prompt exceeds macro-inquiry budget (${words} words / ${chars} chars; limit <= ${MAX_PRO_MACRO_WORDS} words and <= ${MAX_PRO_MACRO_CHARS} chars)`
    );
  }
  if (text.includes("```")) {
    violations.push("contains fenced code block ('```')");
  }
  if (/^(---\s+a\/|\+\+\+\s+b\/|@@\s+-\d+)/m.test(text)) {
    violations.push("contains unified diff hunk");
  }
  const ledgerLines =
    text.match(/^\s*[-*]?\s*(?:[DC]\d+|W\d{4})\s*[:：]/gm) || [];
  if (ledgerLines.length >= 2) {
    violations.push(
      `contains itemized internal ledger dump (${ledgerLines.length} D/C/W entries)`
    );
  }
  if (/complete,\s*partial,\s*or\s*blocked/i.test(text)) {
    violations.push(
      "contains rigid status-header output checklist ('complete, partial, or blocked')"
    );
  }

  if (violations.length > 0) {
    throw new BridgeUserError(
      REASONS.PRO_MACRO_PROMPT_CLUTTER,
      `pro_macro prompt guard rejected technical clutter that restricts deep macro-reasoning: ${violations.join("; ")}. Distill into <= 3 conceptual prose paragraphs (Object & Invariants, Core Structural Paradox, One Open High-Horizon Question).`,
      { violations, words, chars }
    );
  }

  return { ok: true, enforced: true, words, chars };
}

/**
 * Anti-Paraphrase Guard:
 * Ensures any router/dispatcher note stays <= 60 words and <= 180 characters,
 * and never substitutes for primary record pointers (`sourceRecordIds`, `originMessageId`, or `replyTo`).
 *
 * @param {object} [metadata]
 * @param {{ replyTo?: string | null, taskId?: string | null }} [context]
 */
export function validateRoutingNote(metadata = {}, context = {}) {
  if (!metadata || typeof metadata !== "object") {
    return { ok: true };
  }
  const note = metadata.routingNote;
  if (note === undefined || note === null || note === "") {
    return { ok: true };
  }
  const text = String(note).trim();
  const charCount = text.length;
  const wordCount = text ? text.split(/\s+/).filter(Boolean).length : 0;

  if (charCount > MAX_ROUTING_NOTE_CHARS || wordCount > MAX_ROUTING_NOTE_WORDS) {
    throw new BridgeUserError(
      REASONS.PARAPHRASE_GUARD_VIOLATION,
      `Anti-paraphrase guard rejected routingNote (${wordCount} words, ${charCount} chars): routing notes must be <= ${MAX_ROUTING_NOTE_WORDS} words and <= ${MAX_ROUTING_NOTE_CHARS} chars so scientific hypotheses are never lossily paraphrased.`,
      { wordCount, charCount }
    );
  }

  const hasSourceRecords =
    Array.isArray(metadata.sourceRecordIds) &&
    metadata.sourceRecordIds.length > 0;
  const hasOriginPointer = Boolean(
    metadata.originMessageId || context.replyTo || metadata.patchId || metadata.validationId
  );

  if (!hasSourceRecords && !hasOriginPointer) {
    throw new BridgeUserError(
      REASONS.PARAPHRASE_GUARD_VIOLATION,
      "Anti-paraphrase guard rejected routingNote without primary pointers: provide 'sourceRecordIds' or 'originMessageId' (or 'replyTo') alongside routingNote.",
      { routingNote: text }
    );
  }

  return { ok: true, wordCount, charCount };
}

/**
 * Validate whether a task is permitted to subscribe to a thread.
 * Hard-blocks `blind_analysis` and `blind_review` tasks from subscribing to cross-thread fan-out.
 */
export function validateThreadSubscription({
  threadId,
  task,
  mandate = null,
  mode = "direct",
}) {
  if (!threadId || typeof threadId !== "string") {
    throw new Error("threadId is required for thread subscription.");
  }
  if (!task || !task.id) {
    throw new BridgeUserError(
      REASONS.TASK_NOT_FOUND,
      `Cannot subscribe unknown task to thread '${threadId}'.`
    );
  }
  if (!SUBSCRIPTION_MODES.includes(mode)) {
    throw new BridgeUserError(
      REASONS.INVALID_SUBSCRIPTION_MODE,
      `Invalid subscription mode '${mode}': expected 'direct' or 'context'.`,
      { mode }
    );
  }

  if (isBlindIsolated(mandate || task)) {
    const profile =
      mandate?.isolation_profile ||
      task?.metadata?.isolationProfile ||
      "blind_review";
    throw new BridgeUserError(
      REASONS.BLIND_ISOLATION_VIOLATION,
      `Blind isolation guard blocked thread subscription for task '${task.id}' (profile='${profile}'): blind analysis/review tasks cannot subscribe to live thread fan-out.`,
      { taskId: task.id, threadId, isolationProfile: profile }
    );
  }

  return {
    thread_id: threadId,
    task_id: task.id,
    mode,
  };
}

/**
 * Determine default thread ID for a task at creation time.
 */
export function defaultTaskThreadId(task) {
  return (
    task?.metadata?.threadId ||
    task?.metadata?.thread_id ||
    `example-${task.id}`
  );
}
