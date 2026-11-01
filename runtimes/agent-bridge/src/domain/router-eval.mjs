import crypto from "node:crypto";
import {
  BridgeUserError,
  HANDOFF_REASON_CODES,
  HUMAN_ATTENTION_REASONS,
  LEAD_ESCALATION_REASONS,
  REASONS,
  isBlindIsolated,
} from "./model.mjs";
import { revalidateMandate } from "./policy.mjs";
import { foldPreview } from "./cards.mjs";

/**
 * Evaluate inbound message/event against Research Router deterministic rules:
 * 1. Direct Subscription Fan-out (zero-LLM, zero-paraphrase)
 * 2. Blind-isolation hard block
 * 3. Mandate & controlVersion revalidation before auto-resume
 * 4. Shadow observe mode (`would_dispatch`) for inferred triggers & invalidation cascades
 *
 * Pure zero-I/O function returning declarative mutations (`decisions`, `fanoutMessages`, `effects`, `taskResumes`).
 */
export function evaluateInboundEvent({
  message,
  subscriptions = [],
  tasksById = new Map(),
  mandatesByTask = new Map(),
  policy = { routerMode: "observe", acceptMode: "observe", controlVersion: "" },
  nowIso = new Date().toISOString(),
}) {
  const routerMode = policy.routerMode || policy.acceptMode || "observe";
  const decisions = [];
  const fanoutMessages = [];
  const effects = [];
  const taskResumes = [];

  if (!message || message.metadata?.isRouterFanout || message.metadata?.isRouterEscalation) {
    return { decisions, fanoutMessages, effects, taskResumes };
  }

  const getTask = (id) =>
    tasksById instanceof Map ? tasksById.get(id) : tasksById?.[id] || null;
  const getMandate = (id) =>
    mandatesByTask instanceof Map
      ? mandatesByTask.get(id)
      : mandatesByTask?.[id] || null;

  const priority = message.metadata?.userInitiated ? "human_priority" : "normal";

  // 0. If routerMode === 'off', skip all automatic subscription fan-out and shadow proposals
  if (routerMode === "off") {
    if (message.metadata?.proposeDispatch || message.metadata?.needsReviewTrigger) {
      decisions.push({
        id: crypto.randomUUID(),
        thread_id: message.thread_id,
        trigger_message_id: message.id,
        mode: routerMode,
        outcome: "ignored",
        target_task_id: message.task_id || message.metadata?.proposedTaskId || null,
        target_agent: message.metadata?.proposedAgent || message.to_agent || null,
        reason_code: "ROUTER_OFF",
        detail: "Router mode is 'off'; automatic fan-out and dispatch proposals are disabled.",
        created_at: nowIso,
      });
    }
    return { decisions, fanoutMessages, effects, taskResumes };
  }

  // 1. Handle explicit inferred / needs_review invalidation dispatch triggers
  if (message.metadata?.proposeDispatch || message.metadata?.needsReviewTrigger) {
    const proposedTaskId =
      message.metadata?.proposedTaskId || message.task_id || null;
    const proposedAgent =
      message.metadata?.proposedAgent ||
      (message.to_agent && message.to_agent !== "all" ? message.to_agent : "codex");
    const proposalSummary =
      message.metadata?.proposalSummary ||
      foldPreview(message.subject || message.content, 180);

    if (routerMode === "observe") {
      decisions.push({
        id: crypto.randomUUID(),
        thread_id: message.thread_id,
        trigger_message_id: message.id,
        mode: routerMode,
        outcome: "would_dispatch",
        target_task_id: proposedTaskId,
        target_agent: proposedAgent,
        reason_code: message.metadata?.needsReviewTrigger
          ? "NEEDS_REVIEW_INVALIDATION"
          : "OBSERVE_SHADOW_PROPOSAL",
        detail: proposalSummary,
        created_at: nowIso,
      });
      return { decisions, fanoutMessages, effects, taskResumes };
    }

    // routerMode === 'auto'
    decisions.push({
      id: crypto.randomUUID(),
      thread_id: message.thread_id,
      trigger_message_id: message.id,
      mode: routerMode,
      outcome: "dispatched",
      target_task_id: proposedTaskId,
      target_agent: proposedAgent,
      reason_code: message.metadata?.needsReviewTrigger
        ? "NEEDS_REVIEW_AUTO_DISPATCH"
        : "AUTO_DISPATCHED",
      detail: proposalSummary,
      created_at: nowIso,
    });
    if (proposedTaskId) {
      effects.push({
        kind: "wakeup",
        effectKey: proposedTaskId,
        priority,
        payload: {
          taskId: proposedTaskId,
          triggerMessageId: message.id,
          userInitiated: Boolean(message.metadata?.userInitiated),
          reason: "router_auto_dispatch",
        },
      });
    }
    return { decisions, fanoutMessages, effects, taskResumes };
  }

  // 2. Evaluate active thread subscriptions
  const activeSubs = (subscriptions || []).filter(
    (s) => s && s.active && s.thread_id === message.thread_id
  );

  for (const sub of activeSubs) {
    const task = getTask(sub.task_id);
    if (!task) continue;
    const mandate = getMandate(task.id);

    // Context-only subscriptions never wake up the task
    if (sub.mode === "context") {
      continue;
    }

    // Do not echo a message back to its own sender
    if (task.assigned_to === message.from_agent) {
      continue;
    }

    // Respect explicit point-to-point addressing to a different peer unless thread fan-out ('all' / metadata.fanout) is requested
    const recipientMatchesSubscriber =
      message.to_agent === "all" ||
      message.to_agent === task.assigned_to ||
      Boolean(message.metadata?.fanout || message.metadata?.threadBroadcast);
    if (!recipientMatchesSubscriber) {
      continue;
    }

    // Do not route back to a task that just handed back this thread/message
    if (
      message.metadata?.handedBackFromTaskId === task.id ||
      (task.metadata?.handback &&
        !task.metadata.handback.resolvedAt &&
        !message.metadata?.resolveHandback)
    ) {
      decisions.push({
        id: crypto.randomUUID(),
        thread_id: message.thread_id,
        trigger_message_id: message.id,
        mode: routerMode,
        outcome: "escalated_to_lead",
        target_task_id: task.id,
        target_agent: task.from_agent || "codex",
        reason_code: "TASK_HANDED_BACK",
        detail: `Task '${task.id}' handed back ownership (${task.metadata?.handback?.reasonCode || "handback"}); awaiting Lead/Human resolution.`,
        created_at: nowIso,
      });
      continue;
    }

    // Hard block blind-isolated tasks from cross-thread fan-out
    if (isBlindIsolated(mandate || task)) {
      decisions.push({
        id: crypto.randomUUID(),
        thread_id: message.thread_id,
        trigger_message_id: message.id,
        mode: routerMode,
        outcome: "escalated_to_lead",
        target_task_id: task.id,
        target_agent: task.from_agent || "codex",
        reason_code: REASONS.BLIND_ISOLATION_VIOLATION,
        detail: `Blocked thread fan-out to blind-isolated task '${task.id}'.`,
        created_at: nowIso,
      });
      continue;
    }

    // Stopped/cancelled/failed tasks never auto-resume via fan-out
    if (task.status === "cancelled" || task.status === "failed") {
      decisions.push({
        id: crypto.randomUUID(),
        thread_id: message.thread_id,
        trigger_message_id: message.id,
        mode: routerMode,
        outcome: "escalated_to_lead",
        target_task_id: task.id,
        target_agent: task.from_agent || "codex",
        reason_code: "TASK_STOPPED_OR_FAILED",
        detail: `Task '${task.id}' is '${task.status}' and will not auto-resume.`,
        created_at: nowIso,
      });
      continue;
    }

    const isResumeFromIdle =
      task.status === "completed" || task.phase === "cli_turn_ended";

    const reval = revalidateMandate(mandate, policy, { isResumeFromIdle });
    if (!reval.ok) {
      const outcome =
        reval.reasonCode === REASONS.MANDATE_MODE_DOWNGRADED &&
        routerMode === "observe"
          ? "would_dispatch"
          : "escalated_to_lead";
      const leadAgent = task.from_agent || "codex";
      decisions.push({
        id: crypto.randomUUID(),
        thread_id: message.thread_id,
        trigger_message_id: message.id,
        mode: routerMode,
        outcome,
        target_task_id: task.id,
        target_agent: outcome === "would_dispatch" ? task.assigned_to : leadAgent,
        reason_code: reval.reasonCode,
        detail: reval.detail,
        created_at: nowIso,
      });
      if (
        outcome === "escalated_to_lead" &&
        message.to_agent !== leadAgent &&
        message.from_agent !== leadAgent
      ) {
        fanoutMessages.push({
          fromAgent: message.from_agent,
          toAgent: leadAgent,
          threadId: message.thread_id,
          taskId: task.id,
          subject: `[Router Escalation: ${reval.reasonCode}] ${message.subject || task.title}`,
          content: message.content,
          replyTo: message.id,
          metadata: {
            isRouterEscalation: true,
            originMessageId: message.id,
            escalationReason: reval.reasonCode,
            escalationDetail: reval.detail,
            taskId: task.id,
          },
        });
      }
      continue;
    }

    // Mandate is valid!
    if (isResumeFromIdle) {
      taskResumes.push({
        taskId: task.id,
        nextStatus: "in_progress",
        nextPhase: "in_progress",
      });
    }

    const alreadyAddressedDirectly =
      message.task_id === task.id && message.to_agent === task.assigned_to;

    decisions.push({
      id: crypto.randomUUID(),
      thread_id: message.thread_id,
      trigger_message_id: message.id,
      mode: routerMode,
      outcome: "fanout_direct",
      target_task_id: task.id,
      target_agent: task.assigned_to,
      reason_code: isResumeFromIdle
        ? "DIRECT_RESUME_VALIDATED"
        : "DIRECT_SUBSCRIPTION_MATCH",
      detail: alreadyAddressedDirectly
        ? `Direct message validated under mandate (${reval.controlVersion}).`
        : `Zero-paraphrase thread fan-out to '${task.assigned_to}' on task '${task.id}'.`,
      created_at: nowIso,
    });

    if (!alreadyAddressedDirectly) {
      // Zero-paraphrase direct fan-out copy preserving exact original content and pointer
      fanoutMessages.push({
        fromAgent: message.from_agent,
        toAgent: task.assigned_to,
        threadId: message.thread_id,
        taskId: task.id,
        subject: message.subject || `[Thread Fan-out] ${task.title}`,
        content: message.content,
        replyTo: message.id,
        metadata: {
          ...message.metadata,
          isRouterFanout: true,
          originMessageId: message.id,
          taskId: task.id,
          userInitiated: Boolean(message.metadata?.userInitiated),
        },
      });
    }

    effects.push({
      kind: "wakeup",
      effectKey: task.id,
      priority,
      payload: {
        taskId: task.id,
        triggerMessageId: message.id,
        userInitiated: Boolean(message.metadata?.userInitiated),
        reason: "direct_subscription_fanout",
      },
    });
  }

  return { decisions, fanoutMessages, effects, taskResumes };
}

/**
 * Evaluate `bridge_handback` when an assignee encounters an out-of-mandate request,
 * scientific ambiguity, or human permission/budget boundary.
 *
 * Pure zero-I/O function returning task metadata updates, escalation message descriptors, and router decision.
 */
export function evaluateHandback({
  task,
  message = null,
  fromAgent,
  reasonCode,
  summary,
  humanAction = null,
  routerMode = "observe",
  nowIso = new Date().toISOString(),
}) {
  if (!task || !task.id) {
    throw new BridgeUserError(
      REASONS.TASK_NOT_FOUND,
      "Cannot execute bridge_handback: task not found."
    );
  }
  if (!HANDOFF_REASON_CODES.includes(reasonCode)) {
    throw new BridgeUserError(
      REASONS.INVALID_HANDBACK_REASON,
      `Invalid handback reasonCode '${reasonCode}'. Expected one of: ${HANDOFF_REASON_CODES.join(", ")}.`,
      { reasonCode }
    );
  }
  const cleanSummary = String(summary || "").trim();
  if (!cleanSummary) {
    throw new Error("bridge_handback requires a non-empty summary.");
  }

  const normalizedHumanAction =
    humanAction && typeof humanAction === "object" && humanAction.question
      ? {
          question: String(humanAction.question).trim(),
          options: Array.isArray(humanAction.options)
            ? humanAction.options.map((o) => String(o))
            : [],
          blockingScope: String(humanAction.blockingScope || "task"),
          createdAt: nowIso,
          resolvedAt: null,
        }
      : null;

  const isHumanBoundary =
    HUMAN_ATTENTION_REASONS.has(reasonCode) || Boolean(normalizedHumanAction);
  const leadAgent = task.from_agent || "codex";
  const threadId =
    message?.thread_id ||
    task.metadata?.threadId ||
    `example-${task.id}`;

  const handbackRecord = {
    taskId: task.id,
    messageId: message?.id || null,
    fromAgent: fromAgent || task.assigned_to,
    reasonCode,
    summary: cleanSummary,
    target: isHumanBoundary ? "human_attention" : leadAgent,
    humanAction: normalizedHumanAction,
    createdAt: nowIso,
    resolvedAt: null,
  };

  const nextTaskMetadata = {
    ...(task.metadata || {}),
    handback: handbackRecord,
    ...(normalizedHumanAction ? { humanAction: normalizedHumanAction } : {}),
    ...(HUMAN_ATTENTION_REASONS.has(reasonCode)
      ? {
          attention: {
            kind: "permission_delta",
            reasonCode,
            summary: cleanSummary,
            createdAt: nowIso,
            resolvedAt: null,
          },
        }
      : {}),
  };

  const nextPhase = LEAD_ESCALATION_REASONS.has(reasonCode)
    ? "awaiting_review"
    : task.phase;

  let escalationMessage = null;
  if (leadAgent && leadAgent !== (fromAgent || task.assigned_to)) {
    const questionBlock = normalizedHumanAction
      ? `\nHuman Decision Needed: ${normalizedHumanAction.question}${
          normalizedHumanAction.options.length > 0
            ? ` (Options: ${normalizedHumanAction.options.join(" | ")})`
            : ""
        }`
      : "";
    escalationMessage = {
      fromAgent: fromAgent || task.assigned_to,
      toAgent: leadAgent,
      threadId,
      taskId: task.id,
      replyTo: message?.id || null,
      subject: `[Handback: ${reasonCode}] ${task.title}`,
      content: `${cleanSummary}${questionBlock}`,
      metadata: {
        isRouterEscalation: true,
        handedBackFromTaskId: task.id,
        originMessageId: message?.id || null,
        handbackReason: reasonCode,
        humanAction: normalizedHumanAction,
        taskId: task.id,
      },
    };
  }

  const decision = {
    id: crypto.randomUUID(),
    thread_id: threadId,
    trigger_message_id: message?.id || null,
    mode: routerMode,
    outcome: "escalated_to_lead",
    target_task_id: task.id,
    target_agent: isHumanBoundary ? "human_attention" : leadAgent,
    reason_code: reasonCode,
    detail: foldPreview(cleanSummary, 180),
    created_at: nowIso,
  };

  return {
    handbackRecord,
    nextTaskMetadata,
    nextPhase,
    isHumanBoundary,
    escalationMessage,
    decision,
  };
}
