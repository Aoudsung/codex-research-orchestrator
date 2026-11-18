import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { BridgeUserError, REASONS } from "./model.mjs";

const UNAVAILABLE = "Directed message unavailable to this session";

function requiredText(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value;
}

function memberBinding(engine, task, run, member) {
  const taskIds = new Set([member.taskId, ...run.steps
    .filter((step) => step.memberId === member.memberId)
    .map((step) => step.taskId)].filter(Boolean));
  const tasks = [...taskIds].map((id) => engine.repos.getTask(id)).filter((candidate) => {
    if (candidate?.assigned_to !== member.agent) return false;
    if (candidate.id === task.id) return true;
    const binding = candidate.metadata?.workRunBinding;
    return binding?.runId === run.runId && binding.taskId === task.id && binding.memberId === member.memberId;
  });
  if (!tasks.length || tasks.length !== taskIds.size) return null;
  const sessions = new Set(tasks.map((candidate) =>
    candidate.bound_conversation_id || candidate.metadata?.workflow?.owner?.conversationId ||
    candidate.session_id || candidate.required_conversation_id
  ).filter(Boolean));
  const conversationId = member.conversationId || (sessions.size === 1 ? [...sessions][0] : null);
  if (!conversationId || [...sessions].some((id) => id !== conversationId)) return null;
  return { ...member, conversationId, tasks };
}

function routeFor(engine, recipient, taskId, rejectMismatch) {
  for (const task of recipient.tasks) {
    if (taskId && task.id !== taskId) continue;
    const route = engine.repos.getRoute(task.id, recipient.agent);
    if (!route?.enabled || !route.target_session_id) continue;
    if (route.target_session_id !== recipient.conversationId) {
      if (rejectMismatch) throw new Error("Wakeup route does not match the run member's bound session");
      continue;
    }
    return route;
  }
  return null;
}

function exposeMessage(message, directed) {
  return {
    ...message,
    ...directed.body,
    task_id: directed.root_task_id,
    recipientTaskId: message.task_id,
    runId: directed.run_id,
    eventId: directed.event_id,
    fromMemberId: directed.from_member_id,
    toMemberId: directed.to_member_id,
  };
}

export function recipientMessage(engine, message, { actorAgent = null, actorSessionId = null } = {}) {
  if (!message) return null;
  if (!message.metadata?.memberEnvelope) return message;
  const directed = engine.repos.getMemberMessage(message.id);
  if (!directed) return message;
  return actorAgent === message.to_agent && actorSessionId === directed.to_session_id
    ? exposeMessage(message, directed)
    : null;
}

export function getMemberMessageReceipt(engine, { messageId, actorAgent, actorSessionId } = {}) {
  const directed = messageId && engine.repos.getMemberMessage(messageId);
  const message = directed && engine.repos.getMessage(messageId);
  if (!message || !actorAgent || !actorSessionId ||
      actorAgent !== message.from_agent || actorSessionId !== directed.from_session_id) {
    throw new BridgeUserError(REASONS.CARD_NOT_FOUND, UNAVAILABLE);
  }
  return {
    messageId,
    seq: message.seq,
    taskId: directed.root_task_id,
    runId: directed.run_id,
    eventId: directed.event_id,
    fromMemberId: directed.from_member_id,
    toMemberId: directed.to_member_id,
    status: message.status,
    createdAt: message.created_at,
    readAt: message.read_at,
    consumedAt: message.consumed_at,
    consumedTurnId: message.consumed_turn_id,
    wakeupStatus: message.wakeup_status,
    wakeupDeliveredAt: message.wakeup_delivered_at,
  };
}

function writeMemberMessage(engine, { task, run, sender, recipient, eventId, body, replyTo = null, recipientTaskId = null }) {
  const prior = engine.repos.findMemberEvent(run.runId, sender.memberId, eventId);
  if (prior) {
    const message = engine.repos.getMessage(prior.message_id);
    if (prior.to_member_id !== recipient.memberId || prior.from_session_id !== sender.conversationId ||
        prior.to_session_id !== recipient.conversationId || message.reply_to !== replyTo ||
        !isDeepStrictEqual(prior.body, body)) {
      throw new Error("eventId already identifies a different directed message");
    }
    return { ...exposeMessage(message, prior), duplicate: true };
  }

  if (sender.memberId !== "@coordinator" && run.evidenceUnlocked === false &&
      run.steps.some((step) => step.kind === "independent" &&
        (step.memberId === sender.memberId || step.memberId === recipient.memberId))) {
    throw new Error("Directed exchange with independent members requires the work run evidence to be unlocked");
  }
  const route = routeFor(engine, recipient, recipientTaskId, sender.memberId !== "@coordinator");
  const messageId = crypto.randomUUID();
  const now = engine._nowIso();
  const deliveryTaskId = route?.task_id || recipientTaskId || recipient.tasks[0]?.id || task.id;
  const wakeupStatus = route && route.driver !== "manual"
    ? (engine.isWakeupGuarded() ? "skipped_wakeup_guard" : "pending")
    : "none";
  const directed = {
    message_id: messageId,
    root_task_id: task.id,
    run_id: run.runId,
    event_id: eventId,
    from_member_id: sender.memberId,
    to_member_id: recipient.memberId,
    from_session_id: sender.conversationId,
    to_session_id: recipient.conversationId,
    body,
  };
  // The ordinary inbox, observers, and host wakeup carry only an envelope.
  const envelope = engine.repos.putMessage({
    id: messageId,
    seq: engine.repos.nextSeq(),
    thread_id: route?.thread_id || `task-${deliveryTaskId}`,
    task_id: deliveryTaskId,
    from_agent: sender.agent,
    to_agent: recipient.agent,
    subject: "Directed run message",
    content: "Read the message from the bound session.",
    reply_to: replyTo,
    metadata: { memberEnvelope: true, workRunId: run.runId },
    status: "unread",
    wakeup_status: wakeupStatus,
    wakeup_target_session: recipient.conversationId,
    created_at: now,
  });
  engine.repos.putMemberMessage(directed);
  if (wakeupStatus === "pending") {
    engine._enqueueEffect({
      kind: "wakeup",
      effectKey: deliveryTaskId,
      payload: { taskId: deliveryTaskId, triggerMessageId: messageId },
    });
  }
  engine.repos.afterCommit(() => {
    try { engine.onMessageCommitted?.(envelope); } catch {}
  });
  return exposeMessage(envelope, directed);
}

export function sendMemberMessage(engine, {
  taskId = null, runId = null, toMemberId = null, eventId,
  actorAgent, actorSessionId, fromAgent = null, toAgent = null,
  replyTo = null, subject = "", content, metadata = {},
} = {}, parent = null) {
  requiredText(actorAgent, "Trusted agent");
  requiredText(actorSessionId, "Trusted host session");
  requiredText(eventId, "eventId");
  requiredText(content, "content");
  if (fromAgent && fromAgent !== actorAgent) throw new Error("fromAgent does not match the trusted agent");
  if (parent) {
    const envelope = engine.repos.getMessage(parent.message_id);
    if (!recipientMessage(engine, envelope, { actorAgent, actorSessionId })) {
      throw new BridgeUserError(REASONS.REPLY_TARGET_NOT_FOUND, UNAVAILABLE);
    }
    if ((taskId && taskId !== parent.root_task_id) || (runId && runId !== parent.run_id) ||
        (toMemberId && toMemberId !== parent.from_member_id)) {
      throw new Error("Reply must keep the original work run and member binding");
    }
    taskId = parent.root_task_id;
    runId = parent.run_id;
    toMemberId = parent.from_member_id;
  } else if (replyTo) {
    throw new Error("Directed replies require a directed parent message");
  }
  requiredText(toMemberId, "toMemberId");
  const task = engine.repos.getTask(requiredText(taskId, "taskId"));
  const run = task?.metadata?.workRun;
  if (!run || run.runId !== requiredText(runId, "runId")) throw new Error("Work run not found");
  const members = run.members.map((member) => memberBinding(engine, task, run, member)).filter(Boolean);
  const senders = members.filter((member) => member.agent === actorAgent && member.conversationId === actorSessionId);
  if (senders.length !== 1) throw new Error("Trusted host session does not identify one member of this work run");
  const [sender] = senders;
  const recipient = members.find((member) => member.memberId === toMemberId);
  if (!recipient || (toAgent && recipient.agent !== toAgent)) {
    throw new Error("Target member has no matching bound session in this work run");
  }
  if (recipient.agent === sender.agent && recipient.conversationId === sender.conversationId) {
    throw new Error("Directed exchange requires a distinct target session");
  }
  if (parent && (sender.memberId !== parent.to_member_id || recipient.conversationId !== parent.from_session_id)) {
    throw new Error("Reply must keep the original sender and recipient sessions");
  }
  const message = writeMemberMessage(engine, {
    task, run, sender, recipient, eventId, replyTo,
    body: { subject, content, metadata: JSON.parse(JSON.stringify(metadata || {})) },
  });
  if (parent && !message.duplicate) {
    const envelope = engine.repos.getMessage(parent.message_id);
    const now = engine._nowIso();
    engine.repos.putMessage({
      ...envelope,
      status: "replied",
      read_at: envelope.read_at || now,
      consumed_at: envelope.consumed_at || now,
      processed_at: envelope.processed_at || now,
      wakeup_status: envelope.wakeup_status === "pending" ? "skipped_already_read" : envelope.wakeup_status,
    });
  }
  return { ...message, inheritedFromReplyTo: Boolean(parent) };
}

function coordinator(task, run) {
  return {
    memberId: "@coordinator",
    agent: task.from_agent,
    conversationId: run.leadSessionId || "",
  };
}

export function notifyWorkRunStep(engine, { task, run, step, member }) {
  const recipient = memberBinding(engine, task, run, member);
  if (!recipient) return null;
  return writeMemberMessage(engine, {
    task, run, sender: coordinator(task, run), recipient,
    recipientTaskId: step.taskId,
    eventId: JSON.stringify(["ready", step.stepId, step.version]),
    body: {
      subject: "Work run step ready",
      content: `Step ${step.stepId} is ready. Read its current contract before proceeding.`,
      metadata: { stepId: step.stepId, stepVersion: step.version },
    },
  });
}

export function notifyWorkRunAcceptance(engine, { task, run }) {
  let recipient;
  if (run.acceptor === task.from_agent && run.leadSessionId) {
    recipient = { ...coordinator(task, run), tasks: [task] };
  } else {
    const candidates = run.members.filter((member) => member.agent === run.acceptor);
    if (candidates.length !== 1) return null;
    recipient = memberBinding(engine, task, run, candidates[0]);
  }
  if (!recipient) return null;
  return writeMemberMessage(engine, {
    task, run, sender: coordinator(task, run), recipient,
    eventId: JSON.stringify(["acceptance", run.version]),
    body: {
      subject: "Work run ready for acceptance",
      content: "All work run steps have delivered. Review the current requirements and receipts before accepting.",
      metadata: { runVersion: run.version },
    },
  });
}
