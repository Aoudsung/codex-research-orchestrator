import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { collaborationSessionAttested, isCollaborationCommand, parseCollaborationIntent, prepareCollaboration } from "../domain/collaboration-playbook.mjs";
import { changeWorkRun, isWorkRunLead, recordWorkBoardEntry, startWorkRun, validateCollaborationMemberScope, workRunOverview } from "../domain/work-run.mjs";
import { collaborationWakeupDisabled, coordinatorBinding, notifyWorkBoardPost, workRunStepWakeup } from "../domain/member-transport.mjs";
import { ALLOWED_WAKEUP_DRIVERS_BY_AGENT } from "../domain/model.mjs";
import { resolveCodexIpcSocketPath } from "./codex-host-driver.mjs";

const terminal = new Set(["completed", "cancelled", "failed"]);
const actionNames = ["open", "claim_lead", "plan", "approve", "start", "bind", "resume", "status", "brief"];
const mutationKinds = new Set(["plan", "approve", "start"]);
const coordinatorMember = "lead";

function required(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be nonempty text`);
  return value.trim();
}

function stringList(value, name, min = 0) {
  if (!Array.isArray(value) || value.length < min) throw new Error(`${name} requires at least ${min} entries`);
  return [...new Set(value.map(item => required(item, name)))];
}

function session(task) {
  return task.bound_conversation_id || task.metadata?.workflow?.owner?.conversationId || task.session_id || null;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function hash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function collaborationEventId(taskId, kind, logicalKey) {
  return JSON.stringify(["collaboration", taskId, kind, logicalKey]);
}

function record(engine, task, kind, logicalKey, payload, result) {
  engine.repos.putTaskEvent({
    eventId: collaborationEventId(task.id, kind, logicalKey), taskId: task.id, logicalKey, kind,
    payloadHash: hash(payload), payload, result, seq: engine.repos.nextSeq(), createdAt: engine._nowIso(),
    contractVersion: task.metadata.workflow.contract.version,
  });
}

function latest(engine, task, kind) {
  return engine.repos.listTaskEvents({ taskId: task.id, kind, orderDesc: true, limit: 1 })[0]?.result ?? null;
}

export function collaborationWakeupRoute(engine, task, { actorAgent, actorSessionId }) {
  if (collaborationWakeupDisabled(engine, task.id, actorAgent, actorSessionId)) return null;
  const route = engine.repos.getRoute(task.id, actorAgent);
  return route?.target_session_id === actorSessionId ? route : null;
}

export function configureCollaborationWakeup(engine, task, target, { autoWakeup, wakeupDriver } = {}) {
  const { actorAgent: agent, actorSessionId: sessionId } = target;
  if (wakeupDriver && autoWakeup !== true) throw new Error("wakeupDriver requires autoWakeup:true");
  if (autoWakeup === undefined) return collaborationWakeupRoute(engine, task, target);
  const allowed = ALLOWED_WAKEUP_DRIVERS_BY_AGENT[agent];
  if (!sessionId || !allowed || (wakeupDriver && !allowed.includes(wakeupDriver))) {
    throw new Error("Wakeup requires an eligible transport for the exact trusted host session");
  }
  return engine.repos.atomic(() => {
    const prior = engine.repos.getRoute(task.id, agent);
    const disabled = collaborationWakeupDisabled(engine, task.id, agent, sessionId);
    if (autoWakeup === false) {
      if (disabled) return null;
      const eventId = JSON.stringify(["collaboration", task.id, "wakeup_disabled", agent, sessionId]);
      engine.repos.putTaskEvent({ eventId, taskId: task.id, kind: "collaboration_wakeup_disabled", payloadHash: hash(eventId),
        payload: { agent, sessionId }, seq: engine.repos.nextSeq(), createdAt: engine._nowIso() });
      for (const message of engine.repos.queryMessages({ taskId: task.id, actorAgent: agent, actorSessionId: sessionId,
        unreadOnly: true, limit: Number.MAX_SAFE_INTEGER })) {
        if (message.metadata?.memberEnvelope && message.task_id === task.id &&
            ["pending", "dispatched", "failed"].includes(message.wakeup_status)) {
          engine.repos.putMessage({ ...message, wakeup_status: "skipped_wakeup_disabled" });
        }
      }
      return null;
    }
    if (disabled) return null;
    if (prior) return prior.target_session_id === sessionId ? prior : null;
    const hostDriver = allowed.includes(process.env.BRIDGE_WAKEUP_DRIVER) ? process.env.BRIDGE_WAKEUP_DRIVER : null;
    const driver = wakeupDriver || hostDriver || (agent === "codex"
      ? (process.env.BRIDGE_CODEX_APP_SERVER_URL ? "app_server_ws" : fs.existsSync(resolveCodexIpcSocketPath()) ? "codex_ipc" : null)
      : agent === "antigravity" ? "agy_cli" : "claude_cli");
    if (!driver) return null;
    return engine.configureWakeupRoute({ taskId: task.id, toAgent: agent, targetSessionId: sessionId,
      driver, cwd: task.cwd, enabled: true,
      ...(agent === "codex" && process.env.BRIDGE_CODEX_APP_SERVER_URL &&
        { appServerUrl: process.env.BRIDGE_CODEX_APP_SERVER_URL }) });
  });
}

function requireOriginLead(task, actor, intake) {
  const intendedSession = intake?.leadSessionId || task.metadata.leadThreadId ||
    (task.from_agent === task.assigned_to ? session(task) : null);
  if (!actor.actorSessionId || actor.actorAgent !== task.from_agent || intendedSession && intendedSession !== actor.actorSessionId) {
    throw new Error("This collaboration action requires the bound lead session");
  }
}

export function captureCollaborationIntake(engine, task, actor, { mode = "auto", permissions = task.permissions, opening = null, unassigned = false, claimKey = null } = {}) {
  if (!task.metadata?.workflow) throw new Error("Collaboration requires workflow protocol 2");
  const previous = latest(engine, task, "collaboration_intake");
  if (unassigned) {
    if (!claimKey || actor || !task.metadata.coordinationOnly || task.from_agent !== task.assigned_to || session(task) || previous) {
      throw new Error("An unassigned collaboration intake must be a fresh coordination-only task");
    }
  } else {
    requireOriginLead(task, actor, previous);
  }
  if (opening) {
    const key = required(opening.eventId, "eventId");
    const eventId = collaborationEventId(task.id, "collaboration_open", key);
    const prior = engine.repos.getTaskEvent(eventId);
    if (prior && prior.payloadHash !== hash(opening)) throw new Error("TASK_EVENT_CONFLICT: same open event has different content");
    if (!prior) record(engine, task, "collaboration_open", key, opening, { taskId: task.id });
  }
  if (previous) {
    parseCollaborationIntent(previous.originalPrompt, mode === "auto" ? previous.mode : mode);
    if (mode !== "auto" && previous.mode !== "auto" && previous.mode !== mode) throw new Error("Collaboration mode was frozen at intake");
    if (hash(permissions ?? {}) !== hash(previous.permissions)) throw new Error("The collaboration intake scope changed. Use a new task for newly authorized scope.");
    return previous;
  }
  const intent = parseCollaborationIntent(task.prompt, mode);
  const intake = {
    ...intent, leadSessionId: actor?.actorSessionId ?? null, permissions: structuredClone(permissions ?? {}),
    sourceRef: `task:${task.id}:original-request`, contractVersion: task.metadata.workflow.contract.version,
  };
  record(engine, task, "collaboration_intake", "original", intake, intake);
  if (unassigned) record(engine, task, "collaboration_adoption_capability", "original", { claimKey }, null);
  return intake;
}

export function claimCollaborationSession(engine, args, actor) {
  return engine.repos.atomic(() => {
    const task = engine.repos.getTask(required(args.taskId, "member taskId"));
    const root = engine.repos.getTask(required(args.collaborationTaskId, "collaborationTaskId"));
    const leadAgent = root?.metadata?.workRun?.leadAgent ?? root?.from_agent;
    if (!root?.metadata?.workflow || !latest(engine, root, "collaboration_intake") ||
        !task?.metadata?.workflow || task.id === root.id || ![root.from_agent, leadAgent].includes(task.from_agent) ||
        !actor.actorSessionId || task.assigned_to !== actor.actorAgent || args.agent && args.agent !== actor.actorAgent ||
        args.conversationId && args.conversationId !== actor.actorSessionId ||
        session(task) && session(task) !== actor.actorSessionId ||
        task.metadata?.workRunBinding && task.metadata.workRunBinding.taskId !== root.id) {
      throw new Error("Collaboration session bootstrap requires the intended host session and an available scoped child task");
    }
    const old = engine.repos.getTaskEvent(collaborationEventId(task.id, "collaboration_session", root.id));
    if (old) {
      if (!terminal.has(root.status) && !terminal.has(task.status)) configureCollaborationWakeup(engine, task, actor, args);
      return task;
    }
    requireRunnable(engine, root);
    requireRunnable(engine, task);
    if (task.metadata?.workRunBinding || !within(path.resolve(root.cwd || "."), path.resolve(task.cwd || "."))) {
      throw new Error("Collaboration session bootstrap requires a task within the Lead's project");
    }
    const claimed = engine.claimTask({
      taskId: task.id, agent: actor.actorAgent, conversationId: actor.actorSessionId,
      model: args.model || null, effort: args.effort || null,
    });
    record(engine, claimed, "collaboration_session", root.id, actor, actor);
    configureCollaborationWakeup(engine, claimed, actor, args);
    return engine.repos.getTask(task.id);
  });
}

function claimLead(engine, task, actor, input) {
  const original = latest(engine, task, "collaboration_intake");
  if (!original || original.leadSessionId || task.metadata.workRunBinding || task.metadata.workRun) {
    throw new Error("This task is unavailable for Lead adoption");
  }
  const attached = latest(engine, task, "collaboration_lead_claim");
  requireOriginLead(task, actor, attached);
  const capability = engine.repos.getTaskEvent(collaborationEventId(task.id, "collaboration_adoption_capability", "original"));
  const proposedHash = hash({ claimKey: input.claimKey });
  if (!capability || !crypto.timingSafeEqual(Buffer.from(capability.payloadHash), Buffer.from(proposedHash))) {
    throw new Error("The project Workbench adoption key is required to claim this intake");
  }
  if (attached) return { ...original, ...attached };
  if (terminal.has(task.status)) throw new Error("The collaboration task is closed");
  const eventId = required(input.eventId, "eventId");
  const binding = { leadSessionId: actor.actorSessionId };
  const workflow = task.metadata.workflow;
  engine.repos.putTask({
    ...task, bound_conversation_id: actor.actorSessionId, required_conversation_id: actor.actorSessionId, session_id: actor.actorSessionId,
    metadata: { ...task.metadata, leadThreadId: actor.actorSessionId,
      workflow: { ...workflow, owner: { ...workflow.owner, conversationId: actor.actorSessionId } } }, updated_at: engine._nowIso(),
  });
  record(engine, task, "collaboration_lead_claim", eventId, { ...actor, eventId }, binding);
  return { ...original, ...binding };
}

export function postWorkbenchCollaborationInstruction(engine, task, { eventId, content }) {
  return engine.repos.atomic(() => {
    task = engine.repos.getTask(task.id);
    const intake = latest(engine, task, "collaboration_intake");
    const run = task.metadata.workRun;
    const leadBound = run?.leadSessionId || latest(engine, task, "collaboration_lead_claim")?.leadSessionId || intake?.leadSessionId;
    if (!intake || !leadBound || terminal.has(task.status)) throw new Error("A current bound Lead is required to receive an instruction");
    const key = required(eventId, "eventId");
    const text = required(content, "content");
    const payload = { content: text };
    const kind = "collaboration_user_instruction";
    const prior = engine.repos.getTaskEvent(collaborationEventId(task.id, kind, key));
    if (prior && prior.payloadHash !== hash(payload)) throw new Error("TASK_EVENT_CONFLICT: same ID has different instruction text");
    if (prior) return { ...prior.result, duplicate: true };
    let boardEntry = null;
    if (run?.evidenceUnlocked) {
      const recipient = coordinatorBinding(engine, task, run);
      if (recipient?.conversationId === leadBound) {
        boardEntry = recordWorkBoardEntry(engine, task, JSON.stringify(["workbench-instruction", key]), {
          type: "user_instruction", channel: "main", fromMemberId: "@user", toMemberIds: ["@coordinator"],
          text: "A user instruction is recorded for the current Lead. Read it through bridge_collaborate resume.",
        });
        notifyWorkBoardPost(engine, { task, run, sender: { ...recipient, memberId: "@user" }, recipient, seq: boardEntry.seq });
      }
    }
    const result = { taskId: task.id, content: text, eventId: key, boardSeq: boardEntry?.seq ?? null, target: "current_lead", recordedAt: engine._nowIso() };
    record(engine, task, kind, key, payload, result);
    return result;
  });
}

function userInstructions(engine, task) {
  return engine.repos.listTaskEvents({ taskId: task.id, kind: "collaboration_user_instruction", limit: 20 })
    .map(event => ({ ...event.result, seq: event.seq }));
}

function approvedBrief(task, intake, value) {
  if (!value || !["confirmed", "existing_authorization"].includes(value.type)) {
    throw new Error("Teamwork approval requires confirmed user approval or a source for existing authorization");
  }
  const contract = task.metadata.workflow.contract;
  const sourceRefs = stringList(value.sourceRefs, "approval sourceRefs", 1);
  const authorizedRefs = new Set([intake.sourceRef, ...contract.sourceRefs.filter(ref => typeof ref === "string")]);
  if (value.type === "existing_authorization" && !sourceRefs.some(ref => authorizedRefs.has(ref))) {
    throw new Error("Existing authorization must cite the original user request or an approved contract source");
  }
  return {
    type: value.type, originalPrompt: intake.originalPrompt, scope: { ...contract.scope, permissions: intake.permissions },
    sourceRefs, attachmentRefs: stringList(value.attachmentRefs ?? [], "attachmentRefs"),
    successCriteria: [...new Set([
      ...stringList(value.successCriteria, "successCriteria", 1),
      ...contract.successCriteria.map(item => typeof item === "string" ? item : (item?.description ?? JSON.stringify(item))),
    ])],
    constraints: [...new Set([...intake.constraints, ...stringList(value.constraints ?? [], "constraints")])],
    contractVersion: contract.version,
  };
}

function prepare(task, intake, specification, approval) {
  const currentApproval = approval?.contractVersion === task.metadata.workflow.contract.version ? approval : null;
  return prepareCollaboration({
    objective: intake.originalPrompt, mode: intake.mode, specification, approval: currentApproval,
    authorizedWriteRoots: intake.permissions?.writeRoots,
  });
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function writeRoots(task, values) {
  return (values ?? []).map(root => path.resolve(task.cwd || ".", root));
}

function validatePlannedScopes(task, intake, plan) {
  const approvedRoots = writeRoots(task, intake.permissions.writeRoots);
  for (const step of plan.steps) {
    for (const root of writeRoots(task, step.writeRoots)) {
      if (!approvedRoots.some(approved => within(approved, root))) {
        throw new Error(`Step ${step.stepId} exceeds the Lead's authorized write scope: ${root}`);
      }
    }
  }
}

function resolvedMember(engine, task, memberId, taskId, steps, permissions) {
  const child = engine.repos.getTask(required(taskId, "member taskId"));
  if (!child?.metadata?.workflow || ![task.from_agent, task.metadata?.workRun?.leadAgent].includes(child.from_agent) || !session(child)) {
    throw new Error(`Member ${memberId} requires a protocol 2 task with a verified host or provider session`);
  }
  if (memberId !== coordinatorMember && (child.id === task.id || !collaborationSessionAttested(engine, child, task))) {
    throw new Error(`Member ${memberId} must bootstrap its real session with bridge_claim_task(collaborationTaskId) before binding`);
  }
  validateCollaborationMemberScope(task, child, steps, permissions);
  return { memberId, taskId: child.id, agent: child.assigned_to, conversationId: session(child) };
}

function requireRunnable(engine, task) {
  if (engine.getControlState().paused) throw new Error("The bridge is paused. Collaboration execution can resume after it is unpaused.");
  if (terminal.has(task.status)) throw new Error("The collaboration task is closed");
}

function bindWorkPlan(engine, task, actor, intake, plan, bindings = {}) {
  if (!bindings || Array.isArray(bindings) || typeof bindings !== "object") throw new Error("bindings must be keyed by prepared member IDs");
  const roleIds = new Set(plan.steps.map(step => step.memberId));
  for (const memberId of Object.keys(bindings)) {
    if (!roleIds.has(memberId)) throw new Error(`Unknown collaboration member: ${memberId}`);
  }
  validatePlannedScopes(task, intake, plan);
  const members = [...roleIds].map(memberId => {
    const bound = Object.hasOwn(bindings, memberId) ? bindings[memberId] : null;
    if (bound !== null && (!bound || typeof bound !== "object" || Object.keys(bound).some(key => key !== "taskId"))) {
      throw new Error("Member bindings accept only a stored taskId");
    }
    const isLead = memberId === coordinatorMember;
    const taskId = bound?.taskId ?? (isLead ? task.id : null);
    if (!taskId) {
      if (bound) throw new Error(`Binding for ${memberId} requires taskId`);
      return { memberId, pendingBinding: true };
    }
    const member = resolvedMember(engine, task, memberId, taskId, plan.steps.filter(step => step.memberId === memberId), intake.permissions);
    const matchesLead = member.agent === actor.actorAgent && member.conversationId === actor.actorSessionId;
    if (isLead !== matchesLead) throw new Error(isLead ? "Bind the final check to the current lead session" : "Workers must use sessions distinct from the lead");
    return member;
  });
  const { collaboration } = plan;
  const steps = plan.steps.map(step => ({ ...step, writeRoots: writeRoots(task, step.writeRoots) }));
  const requirements = plan.requirements.map(item => ({ ...item }));
  for (const [index, criterion] of task.metadata.workflow.contract.deliveryCriteria.entries()) {
    const description = typeof criterion === "string" ? criterion : criterion?.description ?? JSON.stringify(criterion);
    const requirementId = criterion?.requirementId || criterion?.id || `delivery-${index + 1}`;
    const existing = requirements.find(item => item.requirementId === requirementId || item.description === description);
    if (existing && existing.description !== description) throw new Error(`Requirement ${requirementId} conflicts with the task contract`);
    if (!existing) requirements.push({ requirementId, description, stepIds: [collaboration.finalStepId] });
  }
  if (!requirements.length) requirements.push({ requirementId: "delivery", description: collaboration.objective, stepIds: [collaboration.finalStepId] });
  return { members, steps, collaboration, requirements };
}

function currentStep(step, run) {
  const byId = new Map(run.steps.map(item => [item.stepId, item]));
  return {
    ...step,
    role: run.collaboration.roles.find(role => role.stepId === step.stepId) ?? null,
    inputs: step.dependsOn.map(id => {
      const upstream = byId.get(id);
      return { stepId: id, stepVersion: upstream.version, status: upstream.status, receipt: upstream.receipt };
    }),
  };
}

function nextRunAction(engine, run) {
  if (run.status === "completed") return { action: "report", acceptance: run.acceptance };
  const paused = engine.getControlState().paused;
  if (run.status === "awaiting_acceptance") return paused ? { action: "wait_for_unpause", readySteps: [] }
    : { action: "accept_or_revise", runId: run.runId, runVersion: run.version, requirements: run.requirements };
  const ready = run.steps.filter(step => step.status === "ready");
  const root = engine.repos.getTask(run.taskId);
  const steps = ready.map(step => ({ ...currentStep(step, run), handoff: workRunStepWakeup(engine, root, run, step) }));
  if (paused) return { action: "wait_for_unpause", readySteps: steps };
  const leadCheck = ready.find(step => step.stepId === run.collaboration.finalStepId);
  if (leadCheck) {
    const member = run.members.find(item => item.memberId === leadCheck.memberId);
    if (isWorkRunLead(engine.repos.getTask(run.taskId), run, { actorAgent: member?.agent, actorSessionId: member?.conversationId })) {
      return { action: "lead_check", step: currentStep(leadCheck, run) };
    }
  }
  const candidates = run.steps.filter(step => step.status === "pending_binding").map(step => currentStep(step, run));
  const resumeTargets = steps.map(step => step.handoff).filter(handoff => handoff?.state === "needs_host_resume");
  return {
    action: resumeTargets.length ? "resume_bound_workers" : ready.length ? "continue_workers" : candidates.length ? "provision_members" : "inspect_dependencies",
    readySteps: steps, bindingNeeded: candidates,
    ...(resumeTargets.length && { resumeTargets }),
    queuedMembers: run.members.filter(member => member.pendingBinding).map(member => member.memberId),
  };
}

function resolvedRun(engine, task, actor) {
  const root = task.metadata?.workRunBinding ? engine.repos.getTask(task.metadata.workRunBinding.taskId) : task;
  const run = workRunOverview(engine, root, actor);
  if (!run?.collaboration) return { root, run: null, member: null, lead: false };
  const lead = Boolean(actor.actorSessionId) && isWorkRunLead(root, run, actor);
  const member = run.members.find(item => !item.retiredAt && !item.pendingBinding && actor.actorSessionId &&
    item.agent === actor.actorAgent && item.conversationId === actor.actorSessionId);
  if (!lead && !member) throw new Error("Collaboration work run is unavailable to this session");
  return { root, run, member, lead };
}

function checkMutationPayload(task, action, eventId, args, engine) {
  const key = required(eventId, "eventId");
  const kind = `collaboration_${action}`;
  const previous = engine.repos.getTaskEvent(collaborationEventId(task.id, kind, key));
  if (previous && previous.payloadHash !== hash(args)) throw new Error("TASK_EVENT_CONFLICT: same ID has different content");
  return { key, kind, previous };
}

export function createCollaborationHandler(bridgeDb, actor, { worker = false, open = null } = {}) {
  const engine = bridgeDb.engine;
  return args => {
    const { action, taskId, eventId, specification, mode, approval, bindings, stepId } = args;
    if (!actionNames.includes(action)) throw new Error("Unknown collaboration action");
    if (worker && action !== "brief") throw new Error("This action requires the lead tool profile");
    if (action === "open") {
      if (!open || !actor.actorSessionId || taskId !== undefined) throw new Error("Opening intake requires the host-bound lead and a new event key");
      const key = required(eventId, "eventId");
      const { cwd, title, priority, readRoots, writeRoots, allowedCommands, requestedTools, forbiddenOperations, contract } = args;
      const intakeTaskId = `collaboration-${hash([actor.actorAgent, actor.actorSessionId, key]).slice(0, 32)}`;
      required(args.objective, "objective");
      return open({
        taskId: intakeTaskId, prompt: args.objective, cwd, title, priority, readRoots,
        writeRoots, allowedCommands, requestedTools, forbiddenOperations, contract,
        collaborationMode: mode ?? "auto", autoWakeup: args.autoWakeup, wakeupDriver: args.wakeupDriver,
      }, args).then(result => ({ ...result.collaboration, taskId: result.task.id, task: result.task, preflight: result.preflight,
        ...(result.wakeupRoute && { wakeupRoute: result.wakeupRoute }) }));
    }
    if (action === "plan" && !taskId) {
      return { ok: true, ...prepareCollaboration({ objective: args.objective, mode, specification }) };
    }
    return engine.repos.atomic(() => {
      const task = engine.repos.getTask(required(taskId, "taskId"));
      if (!task?.metadata?.workflow) throw new Error("Collaboration requires an existing workflow protocol 2 task");
      if (args.objective !== undefined && args.objective !== task.prompt) throw new Error("The original objective is frozen on the task");
      const { root, run, member, lead } = resolvedRun(engine, task, actor);
      if (action === "brief") {
        if (!run) throw new Error("Start the collaboration before reading a work-step brief");
        const step = run.steps.find(item => item.stepId === required(stepId, "stepId"));
        if (!step || (!lead && step.memberId !== member?.memberId)) throw new Error("Collaboration brief is unavailable to this session");
        return { ok: true, runId: run.runId, runVersion: run.version, step: currentStep(step, run) };
      }
      const initialIntake = latest(engine, root, "collaboration_intake");
      if (action === "claim_lead") {
        const intake = claimLead(engine, root, actor, args);
        return { ok: true, taskId: root.id, intake, instructions: userInstructions(engine, root), ...prepare(root, intake) };
      }
      const attachment = latest(engine, root, "collaboration_lead_claim");
      const savedIntake = initialIntake ? { ...initialIntake, ...attachment } : null;
      if (savedIntake && !savedIntake.leadSessionId && !run) throw new Error("Open the intended native Lead session and call bridge_collaborate with action claim_lead");
      if (run && !lead) throw new Error("This action requires the current bound collaboration lead");
      if (!run) requireOriginLead(root, actor, savedIntake);
      const savedPlan = latest(engine, root, "collaboration_plan");
      const savedApproval = latest(engine, root, "collaboration_approve");
      if (action === "resume" || action === "status") {
        const instructions = userInstructions(engine, root);
        if (run) return { ok: true, state: run.status, run, instructions, nextAction: nextRunAction(engine, run) };
        const intake = savedIntake ?? { ...parseCollaborationIntent(root.prompt), permissions: root.permissions };
        return { ok: true, intake, instructions, ...prepare(root, intake, savedPlan?.specification, savedApproval) };
      }
      if (action === "bind") {
        if (!run || !lead) throw new Error("Binding requires the current work run lead");
        const target = run.members.find(item => item.memberId === required(args.memberId, "memberId"));
        if (!target) throw new Error("Unknown collaboration member");
        const member = resolvedMember(engine, root, target.memberId, args.memberTaskId, run.steps.filter(step => step.memberId === target.memberId), savedIntake?.permissions);
        if (member.agent === actor.actorAgent && member.conversationId === actor.actorSessionId) throw new Error("Workers must use sessions distinct from the lead");
        requireRunnable(engine, root);
        configureCollaborationWakeup(engine, engine.repos.getTask(member.taskId),
          { actorAgent: member.agent, actorSessionId: member.conversationId }, args);
        const result = changeWorkRun(engine, { ...actor, action: "bind_member", taskId: root.id, runId: run.runId, eventId,
          runVersion: args.runVersion, memberId: target.memberId, member,
          ...(args.autoWakeup !== undefined && { autoWakeup: args.autoWakeup }),
          ...(args.wakeupDriver !== undefined && { wakeupDriver: args.wakeupDriver }) });
        const next = workRunOverview(engine, engine.repos.getTask(root.id), actor);
        return { ok: true, result, state: next.status, run: next, nextAction: nextRunAction(engine, next) };
      }
      if (!mutationKinds.has(action)) throw new Error("Unknown collaboration action");
      const persisted = action !== "plan" || eventId != null;
      const payload = { ...args, ...actor };
      const event = persisted ? checkMutationPayload(root, action, eventId, payload, engine) : null;
      if (event?.previous) {
        if (action === "start" && run) return { ok: true, result: { ...event.previous.result, duplicate: true }, state: run.status, run, nextAction: nextRunAction(engine, run) };
        return action === "approve" ? { ok: true, approval: event.previous.result, duplicate: true } :
          { ok: true, ...event.previous.result, duplicate: true };
      }
      if (run) throw new Error("The approved blueprint is attached to an active work run. Use resume or manage changes on the board.");
      const intake = savedIntake ?? (persisted ? captureCollaborationIntake(engine, root, actor, { mode }) :
        { ...parseCollaborationIntent(root.prompt, mode), permissions: root.permissions });
      const effective = specification ?? savedPlan?.specification;
      const chosen = intake.mode === "auto" && mode && mode !== "auto" ? { ...intake, mode } : intake;
      if (mode && mode !== "auto" && mode !== chosen.mode) throw new Error("Collaboration mode was frozen at intake");
      if (action === "plan") {
        const planned = prepare(root, chosen, effective, savedApproval);
        if (planned.plan) validatePlannedScopes(root, chosen, planned.plan);
        if (event) record(engine, root, event.kind, event.key, payload, { ...planned, specification: effective ?? null });
        return { ok: true, ...planned };
      }
      if (action === "approve") {
        const prior = prepare(root, chosen, effective, null);
        if (prior.mode !== "teamwork") throw new Error("Brief approval is for Teamwork");
        if (prior.state === "needs_plan") throw new Error("Prepare a complete Teamwork blueprint before approving its brief");
        const approved = {
          ...approvedBrief(root, chosen, approval),
          comparisonProtocolFingerprint: hash(prior.plan.collaboration.comparisonProtocol ?? null),
        };
        record(engine, root, event.kind, event.key, payload, approved);
        const planned = prepare(root, chosen, effective, approved);
        return { ok: true, approval: approved, ...planned };
      }
      requireRunnable(engine, root);
      const planned = prepare(root, chosen, effective, savedApproval);
      if (planned.state !== "ready") throw new Error(`Collaboration is ${planned.state}. Complete the next action returned by plan before starting.`);
      if (planned.mode === "teamwork" && savedApproval.comparisonProtocolFingerprint !== hash(planned.plan.collaboration.comparisonProtocol ?? null)) {
        throw new Error("The comparison protocol changed after approval. Approve the revised brief before starting.");
      }
      const workPlan = bindWorkPlan(engine, root, actor, chosen, planned.plan, bindings);
      const result = startWorkRun(engine, { ...actor, taskId: root.id, eventId, workPlan, workMode: planned.plan.workMode, allowPendingBindings: true });
      record(engine, root, event.kind, event.key, payload, result);
      const active = workRunOverview(engine, engine.repos.getTask(root.id), actor);
      return { ok: true, result, state: active.status, run: active, nextAction: nextRunAction(engine, active) };
    });
  };
}

export function registerCollaborationTools(registerBridgeTool, bridgeDb, actor, options = {}) {
  if (options.worker) {
    registerBridgeTool({
      name: "bridge_collaborate",
      description: "Read the current brief and dependency receipts for your bound collaboration step.",
      inputSchema: {
        type: "object", additionalProperties: false, required: ["action", "taskId", "stepId"],
        properties: { action: { type: "string", enum: ["brief"] }, taskId: { type: "string" }, stepId: { type: "string" } },
      },
    }, createCollaborationHandler(bridgeDb, actor, options));
    return;
  }
  registerBridgeTool({
    name: "bridge_collaborate",
    description: "Prepare, approve, start, bind, or resume Boost, Swarm, and Teamwork over active work runs.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["action"],
      properties: {
        action: { type: "string", enum: actionNames }, taskId: { type: "string" }, eventId: { type: "string" },
        objective: { type: "string" }, mode: { type: "string", enum: ["auto", "boost", "swarm", "teamwork"] },
        specification: { type: "object" }, approval: { type: "object" }, bindings: { type: "object" },
        claimKey: { type: "string" }, stepId: { type: "string" }, memberId: { type: "string" }, memberTaskId: { type: "string" },
        cwd: { type: "string" }, title: { type: "string" },
        priority: { type: "string", enum: ["low", "normal", "high", "urgent"] }, contract: { type: "object" },
        readRoots: { type: "array" }, writeRoots: { type: "array" }, allowedCommands: { type: "array" },
        requestedTools: { type: "array" }, forbiddenOperations: { type: "array" },
        runVersion: { type: "integer", minimum: 1 },
        autoWakeup: { type: "boolean" }, wakeupDriver: { type: "string" },
      },
    },
  }, createCollaborationHandler(bridgeDb, actor, options));
}

export { isCollaborationCommand };
