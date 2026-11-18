import crypto from "node:crypto";
import path from "node:path";
import { normalizeReviewPacket } from "../core/review-packet.mjs";
import { validateWriteRootExclusivity } from "./intake.mjs";
import { notifyWorkRunAcceptance, notifyWorkRunStep } from "./member-transport.mjs";

const modes = new Set(["auto", "single", "parallel", "investigate", "milestone"]);
const kinds = new Set(["work", "independent", "synthesis", "challenge", "review", "milestone"]);
const agents = new Set(["codex", "claude-code", "antigravity"]);
const terminal = new Set(["completed", "cancelled", "failed"]);
const outcomes = new Set(["progress", "delivered", "counterexample", "revise", "accept"]);
const assessments = new Set(["supported", "counterexample", "insufficient"]);
const isIndependent = step => step.kind === "independent";
const isCheck = step => ["challenge", "review", "synthesis"].includes(step.kind);

function required(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a nonempty string`);
  return value.trim();
}

function records(value, name) {
  if (!Array.isArray(value) || value.some(item => !item || typeof item !== "object" || Array.isArray(item))) {
    throw new Error(`${name} must be an array of objects`);
  }
  return value;
}

function refs(value, name) {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array of strings`);
  return [...new Set(value.map(ref => required(ref, name)))];
}

function evidence(value, name) {
  const values = refs(value ?? [], name);
  if (!values.length) throw new Error(`${name} requires at least one reference`);
  return values;
}

function byId(items, key) {
  const index = new Map(items.map(item => [item[key], item]));
  if (index.size !== items.length) throw new Error(`Duplicate ${key} in work plan`);
  return index;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

function eventKey(taskId, kind, id) {
  return `work-run:${JSON.stringify([taskId, kind, id])}`;
}

function transact(engine, args, kind, id, apply) {
  required(id, kind === "work_run_start" ? "eventId" : "receiptId");
  if (!agents.has(args.actorAgent)) throw new Error("A trusted work run actor is required");
  const eventId = eventKey(args.taskId, kind, id);
  const payloadHash = crypto.createHash("sha256").update(JSON.stringify(canonical(args))).digest("hex");
  return engine.repos.atomic(() => {
    const task = engine.repos.getTask(args.taskId);
    if (!task?.metadata?.workflow) throw new Error("Work runs require a workflow protocol 2 task");
    const prior = engine.repos.getTaskEvent(eventId);
    if (prior) {
      if (prior.payloadHash !== payloadHash) throw new Error("TASK_EVENT_CONFLICT: same ID has different content");
      return { ...prior.result, duplicate: true };
    }
    const result = apply(task);
    engine.repos.putTaskEvent({
      eventId, taskId: task.id, logicalKey: id, kind, payloadHash,
      payload: args, result, contractVersion: task.metadata.workflow.contract.version,
      createdAt: engine._nowIso(), seq: engine.repos.nextSeq(),
    });
    return result;
  });
}

function taskSession(task) {
  return task.bound_conversation_id || task.metadata.workflow?.owner?.conversationId ||
    task.session_id || task.required_conversation_id || null;
}

function roots(task, values = task.permissions?.writeRoots ?? []) {
  return refs(values, "writeRoots").map(root => path.resolve(task.cwd || ".", root));
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function getAncestors(steps) {
  const index = byId(steps, "stepId");
  const all = new Map();
  const visiting = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error(`WORK_RUN_DEPENDENCY_CYCLE: ${id}`);
    if (all.has(id)) return all.get(id);
    const step = index.get(id);
    if (!step) throw new Error(`Unknown work plan dependency: ${id}`);
    visiting.add(id);
    const parents = new Set();
    for (const dep of step.dependsOn) {
      parents.add(dep);
      for (const parent of visit(dep)) parents.add(parent);
    }
    visiting.delete(id);
    all.set(id, parents);
    return parents;
  }
  for (const step of steps) visit(step.stepId);
  return all;
}

function selectMode(requestedMode, steps, ancestors) {
  const independent = steps.filter(isIndependent);
  const distinctMembers = new Set(steps.map(step => step.memberId)).size;
  const hasMilestone = steps.some(step => step.kind === "milestone");
  const hasInvestigation = independent.length > 0 || steps.some(step => step.kind === "challenge");
  const parallel = steps.some(left => steps.some(right => left.memberId !== right.memberId &&
    !ancestors.get(left.stepId).has(right.stepId) && !ancestors.get(right.stepId).has(left.stepId)));
  const workMode = requestedMode !== "auto" ? requestedMode
    : hasMilestone ? "milestone"
    : hasInvestigation ? "investigate"
    : parallel ? "parallel"
    : distinctMembers > 1 && steps.some(step => step.dependsOn.length) ? "milestone"
    : "single";
  if (workMode === "single" && distinctMembers !== 1) {
    throw new Error("Single mode requires one working member. Use milestone mode for sequential handoffs.");
  }
  if (workMode === "parallel" && !parallel) {
    throw new Error("Parallel mode requires concurrent steps assigned to distinct members.");
  }
  if (workMode === "milestone" && !steps.some(step => step.dependsOn.length)) {
    throw new Error("Milestone mode requires at least one planned handoff between dependent steps.");
  }
  if (independent.length) {
    const ownsDistinctBranches = new Set(independent.map(step => step.memberId)).size === independent.length;
    const checksAll = steps.some(step => isCheck(step) &&
      independent.every(branch => ancestors.get(step.stepId).has(branch.stepId)));
    if (independent.length < 2 || !ownsDistinctBranches || !checksAll ||
        independent.some(step => step.dependsOn.length || step.writeRoots.length)) {
      throw new Error("Investigation requires at least two read-only independent root steps with distinct members and a downstream check depending on all of them.");
    }
  } else if (workMode === "investigate" || hasInvestigation) {
    const hasPublicChallenge = steps.some(step => step.kind === "challenge" && steps.some(author =>
      author.memberId !== step.memberId && ancestors.get(step.stepId).has(author.stepId)));
    if (!hasPublicChallenge) {
      throw new Error("Public investigation requires a challenge step that depends on another member's work.");
    }
  }
  const reasons = {
    single: "The plan assigns its work to one member.",
    parallel: "The plan has concurrent steps owned by different members.",
    investigate: independent.length ? "The plan calls for independent analysis before a shared check." :
      "The plan assigns a second member to challenge an upstream result.",
    milestone: "The plan calls for dependent handoffs between stages.",
  };
  return { workMode, selectionReason: requestedMode === "auto" ? reasons[workMode] : `Explicit ${workMode} mode.` };
}

function normalizeRequirements(task, values, steps) {
  const list = records(values ?? [], "requirements").map((item) => ({
    requirementId: required(item.requirementId, "requirementId"),
    description: required(item.description, "requirement description"),
    stepIds: refs(item.stepIds ?? [], "requirement stepIds"),
  }));
  const index = byId(list, "requirementId");
  const contract = task.metadata.workflow.contract;
  for (const [i, item] of contract.deliveryCriteria.entries()) {
    const description = required(typeof item === "string" ? item : item?.description || JSON.stringify(item), "delivery criterion");
    const requirementId = required(item?.requirementId || item?.id || `delivery-${i + 1}`, "delivery criterion ID");
    const existing = index.get(requirementId) || list.find(entry => entry.description === description);
    if (existing) {
      if (existing.description !== description) throw new Error(`Requirement ${requirementId} conflicts with the task delivery contract`);
    } else {
      const requirement = { requirementId, description, stepIds: [] };
      index.set(requirementId, requirement);
      list.push(requirement);
    }
  }
  if (!list.length) list.push({ requirementId: "delivery", description: contract.objective, stepIds: [] });
  for (const requirement of list) {
    for (const id of requirement.stepIds) {
      if (!steps.has(id)) throw new Error(`Unknown work plan requirement step: ${id}`);
    }
  }
  return list;
}

function normalizePlan(engine, task, requestedMode, input) {
  if (!input && !["auto", "single"].includes(requestedMode)) {
    throw new Error(`${requestedMode} requires a workPlan with named members and steps`);
  }
  const plan = input ?? {
    members: [{ memberId: "owner", agent: task.assigned_to, taskId: task.id }],
    steps: [{ stepId: "delivery", memberId: "owner" }],
  };
  const members = records(plan.members, "members").map(item => {
    const memberId = required(item.memberId, "memberId");
    if (!agents.has(item.agent)) throw new Error(`Unknown agent for work run member ${memberId}`);
    if (memberId === "@coordinator") throw new Error("The @coordinator memberId is reserved");
    return {
      memberId, agent: item.agent,
      conversationId: item.conversationId == null ? null : required(item.conversationId, "conversationId"),
      taskId: item.taskId == null ? null : required(item.taskId, "member taskId"),
    };
  });
  const stepsInput = records(plan.steps, "steps");
  if (!members.length || !stepsInput.length) throw new Error("workPlan requires named members and steps");
  const memberIndex = byId(members, "memberId");
  const bindings = new Map();
  const steps = stepsInput.map(item => {
    const stepId = required(item.stepId, "stepId");
    const member = memberIndex.get(item.memberId);
    if (!member) throw new Error(`Unknown member for step ${stepId}`);
    const kind = item.kind ?? "work";
    if (!kinds.has(kind)) throw new Error(`Unknown work run step kind: ${kind}`);
    const memberDefault = member.taskId || stepsInput.find(step => step.memberId === member.memberId && step.taskId)?.taskId;
    const workTaskId = item.taskId || memberDefault || (member.agent === task.assigned_to ? task.id : null);
    if (!workTaskId) throw new Error(`Bind member ${member.memberId} to an existing task before starting the run`);
    const workTask = workTaskId === task.id ? task : engine.repos.getTask(workTaskId);
    if (!workTask?.metadata?.workflow || workTask.from_agent !== task.from_agent ||
        workTask.assigned_to !== member.agent || terminal.has(workTask.status) ||
        workTask.metadata.workRunBinding || workTask.metadata.workRun) {
      throw new Error(`Step ${stepId} needs a compatible active protocol 2 task for member ${member.memberId}`);
    }
    if (!within(path.resolve(task.cwd || "."), path.resolve(workTask.cwd || "."))) {
      throw new Error(`Step ${stepId} task must belong to the work run project`);
    }
    if (["delivered", "completed", "cancelled"].includes(workTask.metadata.workflow.status)) {
      throw new Error(`Step ${stepId} cannot bind a task with a final workflow receipt`);
    }
    const session = taskSession(workTask);
    if (member.conversationId && session !== member.conversationId) {
      throw new Error(`Step ${stepId} task session does not match member ${member.memberId}`);
    }
    member.conversationId ??= session;
    member.taskId ??= memberDefault || workTaskId;
    const binding = bindings.get(workTaskId) ?? { task: workTask, memberId: member.memberId, stepIds: [] };
    if (binding.memberId !== member.memberId) throw new Error("Each task may bind to only one work run member");
    binding.stepIds.push(stepId);
    bindings.set(workTaskId, binding);
    const authorizedRoots = roots(workTask);
    const writeRoots = item.writeRoots === undefined ? authorizedRoots : roots(workTask, item.writeRoots);
    if (writeRoots.some(root => !authorizedRoots.some(allowed => within(allowed, root))) ||
        authorizedRoots.some(root => !writeRoots.some(declared => within(declared, root)))) {
      throw new Error(`Step ${stepId} writeRoots must cover the write scope already authorized for its task`);
    }
    return {
      stepId, kind, memberId: member.memberId, taskId: workTaskId,
      description: item.description == null ? null : required(item.description, "step description"),
      dependsOn: refs(item.dependsOn ?? [], "dependsOn"), writeRoots,
      ...(kind === "independent" && { inputPacket: normalizeReviewPacket(item.inputPacket) }),
      version: 1, status: "waiting", blockedBy: [], receipt: null, rejection: null, revision: null,
    };
  });
  for (const member of members) {
    if (!steps.some(step => step.memberId === member.memberId && step.taskId === member.taskId)) {
      throw new Error(`Bind a step to the default task for member ${member.memberId}`);
    }
    if (members.length > 1 && !member.conversationId) {
      throw new Error(`Bind member ${member.memberId} to an existing conversation before starting a multi-member run`);
    }
    for (const binding of bindings.values()) {
      if (binding.memberId === member.memberId && taskSession(binding.task) !== member.conversationId) {
        throw new Error(`All tasks for member ${member.memberId} must use the same bound conversation`);
      }
    }
  }
  if (new Set(members.map(member => JSON.stringify([member.agent, member.conversationId]))).size !== members.length) {
    throw new Error("Each work run member needs a distinct agent/session identity");
  }
  const stepIndex = byId(steps, "stepId");
  const ancestors = getAncestors(steps);
  const selected = selectMode(requestedMode, steps, ancestors);
  for (const [i, left] of steps.entries()) {
    for (const right of steps.slice(i + 1)) {
      if (ancestors.get(left.stepId).has(right.stepId) || ancestors.get(right.stepId).has(left.stepId)) continue;
      if (left.writeRoots.some(a => right.writeRoots.some(b => within(a, b) || within(b, a)))) {
        throw new Error(`WRITE_ROOT_CONFLICT: Concurrent steps ${left.stepId} and ${right.stepId} overlap`);
      }
      if (left.taskId === right.taskId) {
        throw new Error(`Concurrent steps ${left.stepId} and ${right.stepId} need separate task bindings`);
      }
    }
  }
  const otherTasks = engine.repos.listTasks({ limit: Number.MAX_SAFE_INTEGER })
    .filter(other => other.id !== task.id && !bindings.has(other.id));
  for (const step of steps) {
    validateWriteRootExclusivity({
      taskId: step.taskId, permissions: { writeRoots: step.writeRoots }, existingTasks: otherTasks, strict: true,
    });
  }
  return { ...selected, members, steps, requirements: normalizeRequirements(task, plan.requirements, stepIndex), bindings };
}

function currentReceipt(engine, run, step, incoming) {
  if (!step.receipt) return null;
  const id = step.receipt.receiptId;
  const payload = id === incoming?.receiptId ? incoming :
    engine.repos.getTaskEvent(eventKey(run.taskId, "work_run_receipt", id))?.payload;
  if (!payload) throw new Error(`Work run receipt ${id} is missing`);
  return {
    receiptId: id, stepVersion: step.version, summary: required(payload.summary, "delivery summary"),
    evidenceRefs: evidence(payload.evidenceRefs, "delivery evidenceRefs"),
  };
}

function refresh(engine, run, incoming = null) {
  const steps = byId(run.steps, "stepId");
  const independent = run.steps.filter(isIndependent);
  const missingAnalyses = independent.filter(step => !step.receipt).map(step => step.stepId);
  run.evidenceUnlocked = !missingAnalyses.length;
  for (const step of run.steps) {
    step.blockedBy = step.dependsOn.filter(id => !steps.get(id).receipt);
    if (!isIndependent(step) && !step.receipt) {
      step.blockedBy = [...new Set([...step.blockedBy, ...missingAnalyses])];
    }
    step.status = step.receipt ? "delivered" :
      run.acceptance ? "stopped" : step.blockedBy.length ? "waiting" : "ready";
    if (step.receipt && isIndependent(step)) {
      step.receipt = run.evidenceUnlocked ? currentReceipt(engine, run, step, incoming) :
        { receiptId: step.receipt.receiptId, stepVersion: step.version };
    }
  }
  run.readySteps = run.steps.filter(step => step.status === "ready").map(step => step.stepId);
  run.status = run.acceptance ? "completed" :
    run.steps.every(step => step.receipt) ? "awaiting_acceptance" : "active";
}

function saveRun(engine, task, run) {
  return engine.repos.putTask({
    ...task, metadata: { ...task.metadata, workRun: run }, updated_at: engine._nowIso(),
  });
}

function emitReady(engine, task, run, previous = []) {
  const before = new Set(previous.filter(step => step.status === "ready").map(step => JSON.stringify([step.stepId, step.version])));
  for (const step of run.steps) {
    if (step.status !== "ready" || before.has(JSON.stringify([step.stepId, step.version]))) continue;
    const member = run.members.find(item => item.memberId === step.memberId);
    if (member.conversationId) notifyWorkRunStep(engine, { task, run, step, member });
  }
}

function resultOf(run) {
  const { runId, taskId, workMode, requestedMode, selectionReason, version, status, readySteps } = run;
  return {
    accepted: true, runId, taskId, workMode, requestedMode, selectionReason, version, status, readySteps,
    ...(run.acceptance && { disposition: run.acceptance.disposition ?? "complete" }),
  };
}

export function startWorkRun(engine, args) {
  return transact(engine, args, "work_run_start", args.eventId, task => {
    if (task.from_agent !== args.actorAgent) throw new Error("Only the task lead can start a work run");
    const trustedLeadSession = task.metadata.leadThreadId || null;
    if (trustedLeadSession && args.actorSessionId !== trustedLeadSession) {
      throw new Error("Starting this work run requires the bound lead session");
    }
    if (terminal.has(task.status) || task.metadata.workflow.status === "delivered") {
      throw new Error("Work runs require an active task without a final receipt");
    }
    if (task.metadata.workRun || task.metadata.workRunBinding) throw new Error("Task already belongs to a work run");
    const requestedMode = args.workMode ?? "auto";
    if (!modes.has(requestedMode)) throw new Error(`Unknown work mode: ${requestedMode}`);
    const { bindings, ...plan } = normalizePlan(engine, task, requestedMode, args.workPlan);
    const leadSessionId = trustedLeadSession || args.actorSessionId || null;
    if (!leadSessionId && plan.members.length > 1 && plan.members.some(member => member.agent === task.from_agent)) {
      throw new Error("Bind the lead session before starting a run with another member on the lead's agent");
    }
    const run = {
      runId: task.id, taskId: task.id, requestedMode, version: 1, ...plan, leadSessionId,
      contractVersion: task.metadata.workflow.contract.version,
      acceptor: task.metadata.workflow.contract.acceptor, acceptance: null, createdAt: engine._nowIso(),
    };
    refresh(engine, run);
    for (const { task: child, memberId, stepIds } of bindings.values()) {
      if (child.id !== task.id) engine.repos.putTask({
        ...child, metadata: { ...child.metadata, workRunBinding: { taskId: task.id, runId: run.runId, memberId, stepIds } },
        updated_at: engine._nowIso(),
      });
    }
    const saved = saveRun(engine, task, run);
    emitReady(engine, saved, run);
    return resultOf(run);
  });
}

function matchesActor(member, args) {
  return member.agent === args.actorAgent && (!member.conversationId || member.conversationId === args.actorSessionId);
}

function isLead(task, run, args) {
  return task.from_agent === args.actorAgent && (!run.leadSessionId || run.leadSessionId === args.actorSessionId);
}

function ownsStep(engine, run, step, args) {
  const member = run.members.find(item => item.memberId === step.memberId);
  const workTask = engine.repos.getTask(step.taskId);
  if (workTask?.assigned_to !== member.agent || terminal.has(workTask.status)) return false;
  const session = taskSession(workTask);
  if (member.conversationId && member.conversationId !== session) return false;
  return matchesActor({
    ...member, conversationId: member.conversationId || session,
  }, args);
}

function invalidate(run, target, update) {
  const ancestors = getAncestors(run.steps);
  for (const step of run.steps) {
    if (step === target || ancestors.get(step.stepId).has(target.stepId)) {
      step.version += 1;
      step.receipt = null;
      step.progress = null;
      step.rejection = null;
      step.revision = null;
    }
  }
  Object.assign(target, update);
  run.acceptance = null;
}

function assessRequirement(item, requirement, steps, evidenceUnlocked) {
  const assessment = item.assessment ?? "supported";
  if (!assessments.has(assessment)) throw new Error(`Unknown requirement assessment: ${assessment}`);
  const explanation = assessment !== "supported" || item.explanation !== undefined
    ? required(item.explanation, "requirement assessment explanation") : null;
  const result = {
    requirementId: requirement.requirementId, assessment, ...(explanation && { explanation }),
  };
  const evidenceRefs = refs(item.evidenceRefs ?? [], "requirement evidenceRefs");
  if (assessment === "insufficient" && !evidenceRefs.length &&
      [item.stepId, item.stepVersion, item.receiptId].every(value => value == null)) {
    return { ...result, evidenceRefs };
  }
  const step = steps.get(item.stepId);
  if (!step || (requirement.stepIds.length && !requirement.stepIds.includes(step.stepId))) {
    throw new Error(`Invalid evidence source for requirement ${requirement.requirementId}`);
  }
  const receipt = step.receipt ?? (assessment === "counterexample" ? step.rejection : null);
  if (!receipt || receipt.receiptId !== item.receiptId || step.version !== item.stepVersion) {
    throw new Error(`Requirement ${requirement.requirementId} must reference a current step receipt`);
  }
  if (!receipt.evidenceRefs || (isIndependent(step) && !evidenceUnlocked && receipt === step.receipt)) {
    throw new Error(`Requirement ${requirement.requirementId} can only cite evidence released to the work run`);
  }
  if (!evidenceRefs.length) throw new Error("Requirement evidenceRefs requires at least one reference");
  if (evidenceRefs.some(ref => !receipt.evidenceRefs.includes(ref))) {
    throw new Error(`Requirement ${requirement.requirementId} references evidence absent from the cited receipt`);
  }
  return { ...result, stepId: step.stepId, stepVersion: step.version, receiptId: receipt.receiptId, evidenceRefs };
}

function accept(engine, task, run, args) {
  if (run.acceptor !== args.actorAgent) throw new Error("Only the configured acceptor can accept a work run");
  if (args.actorAgent === task.from_agent && !isLead(task, run, args)) throw new Error("Acceptance requires the bound lead session");
  const acceptorMembers = run.members.filter(member => member.agent === run.acceptor);
  if (args.actorAgent !== task.from_agent && acceptorMembers.length &&
      !acceptorMembers.some(member => matchesActor(member, args))) {
    throw new Error("Acceptance requires a bound acceptor session");
  }
  if (args.runVersion !== run.version) throw new Error("WORK_RUN_VERSION_CONFLICT");
  const disposition = args.disposition ?? "complete";
  if (!["complete", "partial"].includes(disposition)) throw new Error(`Unknown acceptance disposition: ${disposition}`);
  const partial = disposition === "partial";
  if (!partial && run.status !== "awaiting_acceptance") {
    throw new Error("All work run steps must deliver before complete acceptance");
  }
  const openQuestions = partial ? evidence(args.openQuestions, "openQuestions") : refs(args.openQuestions ?? [], "openQuestions");
  const summary = partial ? required(args.summary, "partial acceptance summary") : args.summary ?? "";
  const requirements = byId(run.requirements, "requirementId");
  const steps = byId(run.steps, "stepId");
  const coverage = new Map();
  const requirementEvidence = records(args.requirementEvidence, "requirementEvidence").map(item => {
    const req = requirements.get(item.requirementId);
    if (!req) throw new Error(`Unknown delivery requirement ${item.requirementId}`);
    const assessment = assessRequirement(item, req, steps, run.evidenceUnlocked);
    const prior = coverage.get(req.requirementId);
    if (prior && prior !== assessment.assessment) {
      throw new Error(`Requirement ${req.requirementId} must have a single assessment`);
    }
    coverage.set(req.requirementId, assessment.assessment);
    return assessment;
  });
  const missing = run.requirements.filter(req => !coverage.has(req.requirementId));
  if (missing.length) throw new Error(`Acceptance is missing evidence for ${missing.map(req => req.requirementId).join(", ")}`);
  const allSupported = [...coverage.values()].every(assessment => assessment === "supported");
  if (!partial && !allSupported) throw new Error("Complete acceptance requires every requirement to be supported");
  if (partial && allSupported && run.status === "awaiting_acceptance") {
    throw new Error("Partial acceptance requires an undelivered step or an unresolved requirement");
  }
  run.acceptance = {
    receiptId: args.receiptId, runVersion: run.version, contractVersion: run.contractVersion,
    actor: args.actorAgent, disposition, summary, openQuestions, requirementEvidence, acceptedAt: engine._nowIso(),
  };
}

function stopReadyNotices(engine, root, run) {
  const recipients = [...run.members, { agent: root.from_agent, conversationId: run.leadSessionId }];
  for (const { agent, conversationId } of recipients) {
    if (!conversationId) continue;
    const notices = engine.repos.queryMessages({
      actorAgent: agent, actorSessionId: conversationId, runId: run.runId,
      unreadOnly: true, limit: Number.MAX_SAFE_INTEGER,
    });
    for (const message of notices) {
      if (["none", "pending", "dispatched", "failed", "skipped_wakeup_guard"].includes(message.wakeup_status) &&
          engine.repos.getMemberMessage(message.id)?.from_member_id === "@coordinator") {
        engine.repos.putMessage({ ...message, wakeup_status: "skipped_work_run_closed" });
      }
    }
  }
}

function closeTasks(engine, root, run) {
  const now = engine._nowIso();
  const ids = new Set([root.id, ...run.steps.map(step => step.taskId)]);
  for (const id of ids) {
    const task = engine.repos.getTask(id);
    if (!task) continue;
    const workflow = task.metadata.workflow;
    const steps = run.steps.filter(step => step.taskId === id);
    const completed = id === root.id || steps.every(step => step.receipt);
    const status = completed ? "completed" : "cancelled";
    const summary = id === root.id ? run.acceptance.summary :
      steps.map(step => step.receipt?.summary).filter(Boolean).join("\n");
    engine.repos.putTask({
      ...task, status, phase: status, phase_label: completed ? "Completed" : "Closed with open work",
      result: summary, updated_at: now, completed_at: now,
      metadata: {
        ...task.metadata, workflow: {
          ...workflow, status, summary, continuation: null, pendingHandoff: null,
          acceptance: {
            actor: run.acceptance.actor, workRunId: run.runId, receiptId: run.acceptance.receiptId,
            disposition: run.acceptance.disposition, at: now,
          },
        },
      },
    });
    engine.revokeTaskLease(id);
  }
}

function applyWorkRunReceipt(engine, args, isolated = false) {
  if (!outcomes.has(args.outcome)) throw new Error(`Unknown work run receipt outcome: ${args.outcome}`);
  return transact(engine, args, "work_run_receipt", args.receiptId, task => {
    const previous = task.metadata.workRun;
    if (!previous || previous.runId !== args.runId) throw new Error("Work run not found");
    const run = structuredClone(previous);
    if (run.status === "completed") throw new Error("The work run is complete");
    if (terminal.has(task.status)) throw new Error("The work run task is terminal");
    if (args.outcome === "accept") {
      accept(engine, task, run, args);
    } else {
      const step = run.steps.find(item => item.stepId === args.stepId);
      if (!step) throw new Error(`Unknown work run step: ${args.stepId}`);
      const owner = ownsStep(engine, run, step, args);
      if (!owner && !(args.outcome === "revise" && isLead(task, run, args))) {
        throw new Error("The trusted actor does not own this work run step");
      }
      if (isolated && (!isIndependent(step) || args.packetDigest !== step.inputPacket.digest)) {
        throw new Error("An isolated receipt must match its approved independent input packet");
      }
      if (isIndependent(step) && !isolated && ["progress", "delivered"].includes(args.outcome)) {
        throw new Error("Independent work requires a receipt from the isolated executor");
      }
      if (step.version !== args.stepVersion) {
        return { ...resultOf(run), staleForTransition: true, stepId: step.stepId, stepVersion: step.version };
      }
      if (args.outcome === "revise") {
        if (!step.receipt) throw new Error("Revisions require a delivered step");
        invalidate(run, step, { revision: {
          receiptId: args.receiptId, summary: required(args.summary, "revision summary"),
          sourceRefs: evidence(args.sourceRefs, "revision sourceRefs"),
        } });
      } else {
        if (step.status !== "ready") throw new Error(`Step ${step.stepId} is ${step.status}`);
        if (args.outcome === "delivered") {
          const summary = required(args.summary, "delivery summary");
          const evidenceRefs = evidence(args.evidenceRefs, "delivery evidenceRefs");
          step.receipt = { receiptId: args.receiptId, stepVersion: step.version, summary, evidenceRefs };
          step.progress = null;
        } else if (args.outcome === "progress") {
          const summary = required(args.summary, "progress summary");
          step.progress = { receiptId: args.receiptId, ...(!isIndependent(step) && { summary }) };
        } else if (args.outcome === "counterexample") {
          const claim = args.counterexample;
          const target = run.steps.find(item => item.stepId === claim?.stepId);
          if (!isCheck(step) || !target?.receipt || !getAncestors(run.steps).get(step.stepId).has(target.stepId)) {
            throw new Error("A counterexample must come from a ready downstream check and target a delivered dependency");
          }
          invalidate(run, target, { rejection: {
            receiptId: args.receiptId, stepId: step.stepId,
            description: required(claim.description, "counterexample description"),
            evidenceRefs: evidence(claim.evidenceRefs, "counterexample evidenceRefs"),
          } });
        }
      }
    }
    run.version += 1;
    refresh(engine, run, args);
    const saved = saveRun(engine, task, run);
    emitReady(engine, saved, run, previous.steps);
    if (run.status === "awaiting_acceptance" && previous.status !== run.status) {
      notifyWorkRunAcceptance(engine, { task: saved, run });
    }
    if (run.acceptance) {
      stopReadyNotices(engine, saved, run);
      closeTasks(engine, saved, run);
    }
    return resultOf(run);
  });
}

export function submitWorkRunReceipt(engine, args) {
  return applyWorkRunReceipt(engine, args);
}

export function attestIndependentWorkRunReceipt(engine, args) {
  return applyWorkRunReceipt(engine, { ...args, outcome: "delivered" }, true);
}

export function workRunOverview(engine, task, actor = {}) {
  const parent = task?.metadata?.workRunBinding;
  const run = parent ? engine.repos.getTask(parent.taskId)?.metadata?.workRun : task?.metadata?.workRun;
  if (!run) return null;
  if (run.evidenceUnlocked || !actor.actorAgent) return run;
  return {
    ...run,
    steps: run.steps.map(step => isIndependent(step) && step.receipt && ownsStep(engine, run, step, actor)
      ? { ...step, receipt: currentReceipt(engine, run, step) }
      : step),
  };
}

export function assertWorkRunTaskReady(engine, task, { stepId } = {}) {
  if (!task?.metadata?.workRun && !task?.metadata?.workRunBinding) return;
  const run = workRunOverview(engine, task);
  const steps = run?.steps.filter(step => step.taskId === task.id && step.status === "ready" &&
    (stepId === undefined || stepId === step.stepId)) ?? [];
  if (steps.length !== 1) {
    throw new Error("WORK_RUN_STEP_NOT_READY: Read the current plan before starting this task");
  }
  const [step] = steps;
  return { run, step, member: run.members.find(item => item.memberId === step.memberId) };
}

export function submitBoundWorkRunReceipt(engine, task, args) {
  const run = workRunOverview(engine, task);
  const assigned = run?.steps.filter(step => step.taskId === task.id) ?? [];
  const pending = assigned.filter(step => step.status === "ready");
  const step = pending.length === 1 ? pending[0] : null;
  const receipt = args.workRun;
  const reported = receipt && assigned.find(item => item.stepId === receipt.stepId);
  if (reported && !isIndependent(reported) &&
      receipt.runId === run.runId && Number.isInteger(receipt.stepVersion) && args.actorSessionId &&
      (args.outcome === "progress" || (args.outcome === "delivered" && receipt.evidenceRefs?.length))) {
    const w = task.metadata.workflow;
    if (w.contract.version !== args.contractVersion || w.owner.epoch !== args.ownerEpoch) {
      return { accepted: true, status: "stale_work_run_receipt", staleForTransition: true };
    }
    return submitWorkRunReceipt(engine, {
      taskId: run.taskId, runId: receipt.runId, stepId: receipt.stepId, stepVersion: receipt.stepVersion,
      receiptId: args.receiptId, actorAgent: args.actorAgent, actorSessionId: args.actorSessionId,
      outcome: args.outcome, summary: args.summary, evidenceRefs: receipt.evidenceRefs,
    });
  }
  return {
    accepted: false, status: "needs_work_run_receipt", runId: run?.runId ?? null,
    stepId: step?.stepId ?? null, stepVersion: step?.version ?? null,
    reason: step && isIndependent(step) ? "Independent work requires a receipt from the isolated executor." :
      "Report the current step ID and version, trusted owner session, and delivery evidence using a work run receipt.",
  };
}
