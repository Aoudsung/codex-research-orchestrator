import {
  BridgeUserError,
  REASONS,
  SUBSCRIPTION_MODES,
  isBlindIsolated,
} from "./model.mjs";

export const MAX_ROUTING_NOTE_WORDS = 60;
export const MAX_ROUTING_NOTE_CHARS = 180;

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
