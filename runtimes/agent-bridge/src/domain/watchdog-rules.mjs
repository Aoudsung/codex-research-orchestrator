import { sha256Hex, unconsumedMessages } from "./model.mjs";
import { foldPreview } from "./cards.mjs";

export const DEFAULT_ORPHAN_ROUTE_TIMEOUT_MS = 120_000;
export const DEFAULT_UNCONSUMED_GRACE_MS = 15_000;
export const DEFAULT_HANDBACK_STALE_MS = 600_000;
export const DELIVERY_FAILURE_BREAKER_THRESHOLD = 3;
export const REPEATED_VALIDATION_SPIN_THRESHOLD = 3;
export const DEFAULT_EXTERNAL_CHANNEL_CHECK_MS = 8 * 60 * 1000; // 8 minutes

/**
 * L1 Watchdog Rule 1:
 * Identify `wakeup_routes` stuck with `in_flight = 1` where the worker PID is dead
 * or `last_dispatched_at` exceeded `timeoutMs`.
 *
 * @param {Array<object>} routes
 * @param {{ isPidAlive?: (pid: number) => boolean, nowMs?: number, timeoutMs?: number }} [options]
 */
export function findOrphanedInFlightRoutes(
  routes = [],
  {
    isPidAlive = () => true,
    nowMs = Date.now(),
    timeoutMs = DEFAULT_ORPHAN_ROUTE_TIMEOUT_MS,
  } = {}
) {
  const orphaned = [];
  for (const r of routes) {
    if (!r || Number(r.in_flight) !== 1) continue;
    const pid = Number(r.worker_pid || 0);
    const pidDead = pid <= 0 || !isPidAlive(pid);
    const dispatchedMs = r.last_dispatched_at
      ? Date.parse(r.last_dispatched_at)
      : 0;
    const timedOut =
      Number.isFinite(dispatchedMs) &&
      dispatchedMs > 0 &&
      nowMs - dispatchedMs >= timeoutMs;

    if (pidDead || timedOut) {
      orphaned.push({
        taskId: r.task_id,
        workerPid: pid || null,
        reason: pidDead ? "worker_pid_dead" : "in_flight_timeout",
      });
    }
  }
  return orphaned;
}

/**
 * L1 Watchdog Rule 2:
 * Identify messages marked `wakeup_status = 'delivered'` whose recipient turn crashed or exited
 * before calling `bridge_read_messages` (`consumed_at IS NULL`), and generate an idempotent `RecoveryNote`.
 */
export function findUnconsumedDeliveredMessages(
  messages = [],
  patchesByTask = new Map(),
  { nowMs = Date.now(), graceMs = DEFAULT_UNCONSUMED_GRACE_MS, maxAttempts = DELIVERY_FAILURE_BREAKER_THRESHOLD } = {}
) {
  const candidates = unconsumedMessages(messages, { nowMs, graceMs });
  const getLatestPatch = (taskId) => {
    const list =
      patchesByTask instanceof Map
        ? patchesByTask.get(taskId)
        : patchesByTask?.[taskId] || [];
    return Array.isArray(list) && list.length > 0 ? list[list.length - 1] : null;
  };

  return candidates
    .filter((m) => Number(m.delivery_attempts || 0) < maxAttempts)
    .map((m) => {
      const latestPatch = m.task_id ? getLatestPatch(m.task_id) : null;
      const patchHint = latestPatch
        ? `Latest submitted patch on task '${m.task_id}' is '${latestPatch.patchId}' (sha256=${String(latestPatch.sha256 || "").slice(0, 12)}, status=${latestPatch.status}).`
        : `No submitted patches recorded yet for task '${m.task_id || "unassigned"}'.`;

      const recoveryNote = `Previous wakeup delivery (attempt #${Number(m.delivery_attempts || 0) + 1}) was accepted by host transport without being consumed via bridge_read_messages. ${patchHint} Inspect current workspace git status and patch sha256 before re-running mutating commands to avoid duplicate side effects.`;

      return {
        messageId: m.id,
        taskId: m.task_id,
        toAgent: m.to_agent,
        seq: Number(m.seq || 0),
        attempts: Number(m.delivery_attempts || 0),
        recoveryNote,
      };
    });
}

/**
 * L1 Watchdog Rule 3:
 * Determine whether a task's wakeup route has hit the 3-strike consecutive failure circuit breaker.
 */
export function shouldTripDeliveryCircuitBreaker(
  route,
  threshold = DELIVERY_FAILURE_BREAKER_THRESHOLD
) {
  if (!route) return false;
  return Number(route.consecutive_failures || 0) >= threshold;
}

/**
 * L1 Watchdog Rule 4:
 * Determine whether a silent external-channel timer check should be scheduled.
 * Active ONLY when `!paused` AND at least one live task is marked `awaiting_external_channel`.
 */
export function shouldScheduleExternalChannelCheck({
  tasks = [],
  paused = false,
  lastCheckMs = 0,
  nowMs = Date.now(),
  intervalMs = DEFAULT_EXTERNAL_CHANNEL_CHECK_MS,
} = {}) {
  if (paused) {
    return { shouldCheck: false, activeTaskIds: [] };
  }
  const activeWaiting = tasks.filter(
    (t) =>
      t &&
      !["completed", "failed", "cancelled"].includes(t.status) &&
      (t.phase === "awaiting_external_channel" ||
        t.metadata?.awaitingExternalChannel === true)
  );
  if (activeWaiting.length === 0) {
    return { shouldCheck: false, activeTaskIds: [] };
  }
  const due = nowMs - Number(lastCheckMs || 0) >= intervalMs;
  return {
    shouldCheck: due,
    nextDueMs: due ? nowMs : Number(lastCheckMs) + intervalMs,
    activeTaskIds: activeWaiting.map((t) => t.id),
  };
}

/**
 * Classify validation failure signature so repeated identical-category failures are caught accurately.
 */
export function classifyValidationFailure(validation) {
  const details =
    typeof validation.details === "object" && validation.details
      ? validation.details
      : (() => {
          try {
            return JSON.parse(validation.details_json || "{}");
          } catch {
            return {};
          }
        })();

  if (details.errorCategory || details.category || details.code) {
    return String(details.errorCategory || details.category || details.code)
      .trim()
      .toLowerCase();
  }
  const summary = String(validation.summary || "")
    .trim()
    .toLowerCase();
  if (!summary) return "unspecified_failure";
  if (!validation.applied || summary.includes("git apply") || summary.includes("patch failed")) {
    return "patch_apply_conflict";
  }
  if (summary.includes("syntaxerror") || summary.includes("compile")) {
    return "syntax_or_compile_error";
  }
  if (summary.includes("timeout") || summary.includes("timed out")) {
    return "execution_timeout";
  }
  // Normalize first 48 chars stripping digits/line numbers for stable grouping
  return summary.replace(/\d+/g, "#").slice(0, 48);
}

/**
 * L2 Anti-Spin Probe 1:
 * Detect `>= 3` consecutive failed validations on the same `taskId` sharing the same error category.
 * Returns deduplicated objective event objects ready for `.optimizer/watchdog-events.jsonl`.
 */
export function detectRepeatedValidationSpin(
  validationsByTask = new Map(),
  { threshold = REPEATED_VALIDATION_SPIN_THRESHOLD, nowIso = new Date().toISOString() } = {}
) {
  const entries =
    validationsByTask instanceof Map
      ? validationsByTask.entries()
      : Object.entries(validationsByTask || {});

  const alerts = [];
  for (const [taskId, list] of entries) {
    if (!Array.isArray(list) || list.length < threshold) continue;
    // Sort ascending by seq
    const sorted = [...list].sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0));
    // Examine trailing consecutive failures
    const trailingFailures = [];
    for (let i = sorted.length - 1; i >= 0; i--) {
      const v = sorted[i];
      const failed = v.passed === false || v.passed === 0 || v.applied === false || v.applied === 0;
      if (!failed) break;
      trailingFailures.unshift(v);
    }
    if (trailingFailures.length < threshold) continue;

    const latestCategory = classifyValidationFailure(
      trailingFailures[trailingFailures.length - 1]
    );
    let sameCategoryStreak = 0;
    const streakIds = [];
    for (let i = trailingFailures.length - 1; i >= 0; i--) {
      if (classifyValidationFailure(trailingFailures[i]) === latestCategory) {
        sameCategoryStreak += 1;
        streakIds.unshift(trailingFailures[i].id);
      } else {
        break;
      }
    }

    if (sameCategoryStreak >= threshold) {
      const latestVal = trailingFailures[trailingFailures.length - 1];
      const dedupeKey = sha256Hex(
        `validation_spin:${taskId}:${latestCategory}:${streakIds.join(",")}`
      ).slice(0, 20);
      alerts.push({
        eventId: `wd_${dedupeKey}`,
        dedupeKey,
        kind: "repeated_validation_spin",
        taskId,
        errorCategory: latestCategory,
        consecutiveCount: sameCategoryStreak,
        validationIds: streakIds,
        latestSeq: Number(latestVal.seq || 0),
        summary: `Task '${taskId}' failed validation ${sameCategoryStreak} consecutive times with category '${latestCategory}': ${foldPreview(latestVal.summary, 140)}`,
        createdAt: nowIso,
      });
    }
  }
  return alerts;
}

/**
 * L2 Anti-Spin Probe 2:
 * Detect unresolved `bridge_handback` items older than `staleMs`.
 */
export function detectStaleHandbacks(
  tasks = [],
  { nowMs = Date.now(), staleMs = DEFAULT_HANDBACK_STALE_MS, nowIso = new Date().toISOString() } = {}
) {
  const alerts = [];
  for (const task of tasks) {
    if (!task || ["completed", "failed", "cancelled"].includes(task.status)) continue;
    const hb = task.metadata?.handback;
    if (!hb || hb.resolvedAt) continue;
    const createdMs = hb.createdAt ? Date.parse(hb.createdAt) : 0;
    if (!Number.isFinite(createdMs) || nowMs - createdMs < staleMs) continue;

    const dedupeKey = sha256Hex(
      `stale_handback:${task.id}:${hb.messageId || ""}:${hb.createdAt || ""}`
    ).slice(0, 20);
    alerts.push({
      eventId: `wd_${dedupeKey}`,
      dedupeKey,
      kind: "stale_handback",
      taskId: task.id,
      reasonCode: hb.reasonCode,
      ageMs: nowMs - createdMs,
      summary: `Unresolved handback (${hb.reasonCode}) on task '${task.id}' has been waiting for ${Math.round((nowMs - createdMs) / 60000)}m: ${foldPreview(hb.summary, 140)}`,
      createdAt: nowIso,
    });
  }
  return alerts;
}

/**
 * L2 Anti-Spin Probe 3:
 * Detect active tasks citing `.research-memory` records that have transitioned to `needs_review`.
 *
 * @param {Array<object>} tasks
 * @param {Set<string> | Array<string>} needsReviewIds - Record IDs currently marked `needs_review`
 */
export function detectNeedsReviewEvidenceUsage(
  tasks = [],
  needsReviewIds = new Set(),
  { nowIso = new Date().toISOString() } = {}
) {
  const flaggedSet =
    needsReviewIds instanceof Set ? needsReviewIds : new Set(needsReviewIds || []);
  if (flaggedSet.size === 0) return [];

  const alerts = [];
  for (const task of tasks) {
    if (!task || ["completed", "failed", "cancelled"].includes(task.status)) continue;
    const cited = [
      ...(Array.isArray(task.metadata?.sourceRecordIds)
        ? task.metadata.sourceRecordIds
        : []),
      ...(Array.isArray(task.metadata?.evidenceIds)
        ? task.metadata.evidenceIds
        : []),
    ];
    // Also extract explicit record tokens (e.g. E-001, C-002, D-003, H-001, Idea-001) mentioned in task prompt
    const promptMatches =
      String(task.prompt || "").match(/\b(?:E|C|D|H|A|M|F|X|L|Idea)-\d{2,4}\b/g) || [];
    const allRefs = [...new Set([...cited, ...promptMatches])];
    const staleRefs = allRefs.filter((id) => flaggedSet.has(id));
    if (staleRefs.length === 0) continue;

    staleRefs.sort();
    const dedupeKey = sha256Hex(
      `needs_review_evidence:${task.id}:${staleRefs.join(",")}`
    ).slice(0, 20);
    alerts.push({
      eventId: `wd_${dedupeKey}`,
      dedupeKey,
      kind: "stale_upstream_evidence",
      taskId: task.id,
      staleRecordIds: staleRefs,
      summary: `Active task '${task.id}' depends on research-memory record(s) marked 'needs_review': [${staleRefs.join(", ")}].`,
      createdAt: nowIso,
    });
  }
  return alerts;
}
