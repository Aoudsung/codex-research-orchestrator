import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { BridgeUserError, REASONS } from "./model.mjs";

const UNAVAILABLE = "Directed message unavailable to this session";

function requiredText(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value;
}

export function memberBinding(engine, task, run, member) {
  if (member.retiredAt) return null;
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

export function collaborationWakeupDisabled(engine, taskId, agent, sessionId) {
  return Boolean(engine.repos.getTaskEvent(JSON.stringify(["collaboration", taskId, "wakeup_disabled", agent, sessionId])));
}

function routeFor(engine, recipient, taskId, rejectMismatch) {
  if (!taskId && recipient.tasks[0] && collaborationWakeupDisabled(engine, recipient.tasks[0].id,
    recipient.agent, recipient.conversationId)) return null;
  for (const task of recipient.tasks) {
    if (taskId && task.id !== taskId) continue;
    if (collaborationWakeupDisabled(engine, task.id, recipient.agent, recipient.conversationId)) continue;
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

function writeMemberMessage(engine, {
  task, run, sender, recipient, eventId, body, replyTo = null, recipientTaskId = null, system = false,
}) {
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

  if (!system && run.evidenceUnlocked === false &&
      run.steps.some((step) => step.kind === "independent" &&
        [sender, recipient].some(peer => step.memberId === (peer.boundMemberId ?? peer.memberId)))) {
    throw new Error("Directed exchange with independent members requires the work run evidence to be unlocked");
  }
  const route = routeFor(engine, recipient, recipientTaskId, !system && !run.collaboration);
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
    metadata: { memberEnvelope: true, workRunId: run.runId, ...(system && { workRunNotice: true }) },
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
  const lead = coordinatorBinding(engine, task, run);
  const matches = (member) => member?.agent === actorAgent && member.conversationId === actorSessionId;
  const sender = parent?.to_member_id === "@coordinator" && matches(lead) ? lead :
    members.find(matches) ?? (matches(lead) ? lead : null);
  if (!sender) throw new Error("Trusted host session does not identify a member of this work run");
  const recipient = toMemberId === "@coordinator" ? lead : members.find((member) => member.memberId === toMemberId);
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

export function coordinator(task, run) {
  return {
    memberId: "@coordinator",
    agent: run.leadAgent ?? task.from_agent,
    conversationId: run.leadSessionId || "",
  };
}

export function coordinatorBinding(engine, task, run) {
  const lead = coordinator(task, run);
  if (!lead.conversationId) return null;
  const named = run.members.find(item => item.memberId === run.leadMemberId ||
    (item.agent === lead.agent && item.conversationId === lead.conversationId));
  if (!run.leadMemberId) return { ...lead, tasks: [task], boundMemberId: named?.memberId };
  const bound = named && memberBinding(engine, task, run, named);
  return bound?.agent === lead.agent && bound.conversationId === lead.conversationId
    ? { ...bound, ...lead, boundMemberId: named.memberId }
    : null;
}

export function notifyWorkRunStep(engine, { task, run, step, member }) {
  const recipient = memberBinding(engine, task, run, member);
  if (!recipient) return null;
  return writeMemberMessage(engine, {
    task, run, sender: coordinator(task, run), recipient, system: true,
    recipientTaskId: step.taskId,
    eventId: JSON.stringify(["ready", step.stepId, step.version, run.version]),
    body: {
      subject: "Work run step ready",
      content: run.collaboration && step.kind !== "independent"
        ? `Step ${step.stepId} revision ${step.version} is ready. Read bridge_collaborate with action brief, taskId ${run.runId} and this stepId. Submit a work-step receipt against this revision.`
        : `Step ${step.stepId} is ready. Read its current contract before proceeding.`,
      metadata: { stepId: step.stepId, stepVersion: step.version,
        ...(step.kind !== "independent" && step.description && { description: step.description }),
        ...(step.kind !== "independent" && step.brief && { brief: step.brief }),
      },
    },
  });
}

export function workRunStepWakeup(engine, task, run, step) {
  const member = run.members.find(item => item.memberId === step.memberId);
  const target = member && memberBinding(engine, task, run, member);
  if (!target || !step.taskId) return null;
  const { agent, conversationId } = target;
  const optedOut = collaborationWakeupDisabled(engine, step.taskId, agent, conversationId);
  const configured = engine.repos.getRoute(step.taskId, agent);
  const exact = configured?.target_session_id === conversationId ? configured : null;
  const route = !optedOut && exact?.enabled && exact.driver !== "manual" ? exact : null;
  const message = engine.repos.queryMessages({ taskId: step.taskId, runId: run.runId, actorAgent: agent,
    actorSessionId: conversationId, limit: Number.MAX_SAFE_INTEGER }).findLast(message => {
    if (!message.metadata?.workRunNotice) return false;
    const meta = engine.repos.getMemberMessage(message.id)?.body?.metadata;
    return meta?.stepId === step.stepId && meta?.stepVersion === step.version;
  });
  const accepted = engine.validHostReceipt(message?.wakeup_receipt, exact);
  let state = "needs_host_resume";
  let reason = optedOut ? "wakeup_disabled" : configured && !exact ? "route_session_mismatch" :
    exact && !exact.enabled ? "route_disabled" : exact?.driver === "manual" ? "manual_route" : "no_route";
  if (step.progress) { state = "working"; reason = "step_progress_receipt"; }
  else if (message?.consumed_at) { state = "consumed"; reason = "bound_session_consumed_notice"; }
  else if (accepted) { state = "host_accepted"; reason = "transport_accepted_notice"; }
  else if (engine.getControlState().paused) { state = "paused"; reason = "bridge_paused"; }
  else if (message?.wakeup_status === "skipped_wakeup_guard") reason = "wakeup_guard";
  else if (route && Number(route.consecutive_failures || 0) >= 3) reason = "transport_failed";
  else if (route && message?.wakeup_status === "dispatched") { state = "dispatching"; reason = "transport_dispatching"; }
  else if (route && message?.wakeup_status === "pending") { state = "queued"; reason = "transport_pending"; }
  else if (route && message?.wakeup_status === "failed") {
    const retrying = Number(message.delivery_attempts || 0) < 3 && Number(route.consecutive_failures || 0) < 3;
    state = retrying ? "queued" : "needs_host_resume";
    reason = retrying ? "transport_retry_pending" : "transport_failed";
  } else if (route) reason = "no_pending_transport";
  return {
    state, reason, runId: run.runId, memberId: step.memberId, taskId: step.taskId, agent, sessionId: conversationId,
    stepId: step.stepId, stepVersion: step.version, driver: exact?.driver ?? null,
    messageId: message?.id ?? null, transportState: message?.wakeup_status ?? null,
    consumedAt: message?.consumed_at ?? null, acceptedAt: accepted ? message.wakeup_delivered_at : null,
    hostTurnId: accepted ? message.wakeup_receipt?.turnId ?? null : null,
  };
}

export function acceptanceRecipient(engine, task, run) {
  if ((run.acceptorFollowsLead ?? run.acceptor === task.from_agent) && run.leadSessionId) {
    return coordinatorBinding(engine, task, run);
  }
  const candidates = run.members.filter((member) => member.agent === run.acceptor && !member.retiredAt);
  return candidates.length === 1 ? memberBinding(engine, task, run, candidates[0]) : null;
}

export function notifyWorkRunAcceptance(engine, { task, run }) {
  const recipient = acceptanceRecipient(engine, task, run);
  if (!recipient) return null;
  return writeMemberMessage(engine, {
    task, run, sender: coordinator(task, run), recipient, system: true,
    eventId: JSON.stringify(["acceptance", run.version]),
    body: {
      subject: "Work run ready for acceptance",
      content: "All work run steps have delivered. Review the current requirements and receipts before accepting.",
      metadata: { runVersion: run.version },
    },
  });
}

export function notifyWorkRunLeadTransfer(engine, { task, run, previous, recipient }) {
  return writeMemberMessage(engine, {
    task, run, sender: previous, recipient, system: true,
    eventId: JSON.stringify(["lead-transfer", run.version]),
    body: {
      subject: "Work run lead responsibility transferred",
      content: "You are the current lead. Read the work run status before continuing.",
      metadata: { runVersion: run.version },
    },
  });
}

export function notifyWorkBoardPost(engine, { task, run, sender, recipient, seq, metadata = {} }) {
  return writeMemberMessage(engine, {
    task, run, sender: { ...sender, memberId: `@board:${sender.memberId}` }, recipient, system: true,
    eventId: JSON.stringify(["board", seq, recipient.memberId, recipient.conversationId]),
    body: {
      subject: "Work board handoff",
      content: `You were named in work board entry #${seq}. Read the board using your last observed sequence.`,
      metadata: { ...metadata, boardSeq: seq },
    },
  });
}

export function obsoleteRunNotices(engine, { run, recipient, match, reason, onObsolete = null }) {
  if (!recipient?.conversationId) return;
  const messages = engine.repos.queryMessages({ actorAgent: recipient.agent, actorSessionId: recipient.conversationId,
    runId: run.runId, unreadOnly: true, limit: Number.MAX_SAFE_INTEGER });
  for (const message of messages) {
    const directed = engine.repos.getMemberMessage(message.id);
    const system = message.metadata?.workRunNotice ||
      (directed?.from_member_id === "@coordinator" && ["Work run step ready", "Work run ready for acceptance"].includes(directed.body.subject));
    if (!system || directed?.to_member_id !== recipient.memberId || !match(directed)) continue;
    if (message.wakeup_status?.startsWith("skipped_work_run_")) continue;
    engine.repos.putMessage({ ...message, wakeup_status: reason, status: "read", read_at: engine._nowIso() });
    onObsolete?.(directed);
  }
}
