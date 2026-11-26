import crypto from "node:crypto";
import path from "node:path";
import { normalizeReviewPacket } from "../core/review-packet.mjs";
import { validateWriteRootExclusivity } from "./intake.mjs";
import { collaborationSessionAttested, expandDynamicCollaborationTrack } from "./collaboration-playbook.mjs";
import { normalizeComparisonProtocol, validateComparisonEvidence } from "./comparison-evidence.mjs";
import {
  acceptanceRecipient, coordinator, coordinatorBinding, memberBinding, notifyWorkBoardPost, notifyWorkRunAcceptance,
  notifyWorkRunLeadTransfer, notifyWorkRunStep, obsoleteRunNotices,
} from "./member-transport.mjs";

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

export function transactWorkRun(engine, args, kind, id, apply) {
  required(id, kind === "work_run_receipt" ? "receiptId" : "eventId");
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
      payload: kind === "work_board_post" ? { actorAgent: args.actorAgent, actorSessionId: args.actorSessionId } : args,
      result, contractVersion: task.metadata.workflow.contract.version,
      createdAt: engine._nowIso(), seq: engine.repos.nextSeq(),
    });
    return result;
  });
}

function taskSession(task) {
  return task.bound_conversation_id || task.metadata.workflow?.owner?.conversationId ||
    task.session_id || task.required_conversation_id || null;
}

function workScope(task, item, stepId) {
  const authorized = roots(task);
  const declared = item.writeRoots === undefined ? authorized : roots(task, item.writeRoots);
  if (declared.some(root => !authorized.some(allowed => within(allowed, root))) ||
      authorized.some(scope => !declared.some(root => within(root, scope)))) {
    throw new Error(`Step ${stepId} writeRoots must cover the write scope already authorized for its task`);
  }
  return declared;
}

function roots(task, values = task.permissions?.writeRoots ?? []) {
  return refs(values, "writeRoots").map(root => path.resolve(task.cwd || ".", root));
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function validateCollaborationMemberScope(root, memberTask, steps, permissions) {
  const allowedRoots = steps.flatMap(step => roots(root, step.writeRoots ?? []));
  if (roots(memberTask).some(scope => !allowedRoots.some(allowed => within(allowed, scope)))) {
    throw new Error("Member task has write access beyond its assigned step scope");
  }
  if (!memberTask.permissions || !permissions) return;
  const forbidden = new Set(memberTask.permissions.forbiddenOperations ?? []);
  if ((permissions.forbiddenOperations ?? []).some(operation => !forbidden.has(operation))) {
    throw new Error("Member task must preserve the Lead's forbidden operations");
  }
  const approved = roots(root, [...(permissions.readRoots ?? []), ...(permissions.writeRoots ?? [])]);
  if (approved.length && roots(memberTask, memberTask.permissions.readRoots ?? [])
    .some(scope => !approved.some(allowed => within(allowed, scope)))) {
    throw new Error("Member task has read access beyond the approved material");
  }
  for (const key of ["requestedTools", "allowedCommands"]) {
    const allowed = permissions[key] ?? [];
    if (allowed.length && (memberTask.permissions[key] ?? []).some(value => !allowed.includes(value))) {
      throw new Error(`Member task exceeds the Lead's ${key} scope`);
    }
  }
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

function validateTrackExclusivity(engine, task, steps, ancestors, boundTaskIds) {
  for (const [i, left] of steps.entries()) {
    for (const right of steps.slice(i + 1)) {
      if (ancestors.get(left.stepId).has(right.stepId) || ancestors.get(right.stepId).has(left.stepId)) continue;
      if (left.writeRoots.some(a => right.writeRoots.some(b => within(a, b) || within(b, a)))) {
        throw new Error(`WRITE_ROOT_CONFLICT: Concurrent steps ${left.stepId} and ${right.stepId} overlap`);
      }
      if (left.taskId && left.taskId === right.taskId) {
        throw new Error(`Concurrent steps ${left.stepId} and ${right.stepId} need separate task bindings`);
      }
    }
  }
  const otherTasks = engine.repos.listTasks({ limit: Number.MAX_SAFE_INTEGER })
    .filter(other => other.id !== task.id && !boundTaskIds.has(other.id) && other.metadata?.workRunBinding?.taskId !== task.id);
  for (const step of steps) {
    validateWriteRootExclusivity({
      taskId: step.taskId, permissions: { writeRoots: step.writeRoots }, existingTasks: otherTasks, strict: true,
    });
  }
}

function normalizePlan(engine, task, requestedMode, input, allowPendingBindings) {
  if (!input && !["auto", "single"].includes(requestedMode)) {
    throw new Error(`${requestedMode} requires a workPlan with named members and steps`);
  }
  const plan = input ?? {
    members: [{ memberId: "owner", agent: task.assigned_to, taskId: task.id }],
    steps: [{ stepId: "delivery", memberId: "owner" }],
  };
  const members = records(plan.members, "members").map(item => {
    const memberId = required(item.memberId, "memberId");
    if (memberId === "@coordinator") throw new Error("The @coordinator memberId is reserved");
    const role = item.role == null ? {} : { role: required(item.role, "member role") };
    if (item.pendingBinding === true) {
      if (!allowPendingBindings || item.agent || item.conversationId || item.taskId) throw new Error("A recipe must authorize deferred member binding");
      return { memberId, agent: null, taskId: null, conversationId: null, pendingBinding: true, ...role };
    }
    if (!agents.has(item.agent)) throw new Error(`Unknown agent for work run member ${memberId}`);
    return {
      memberId, agent: item.agent, ...role,
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
    const common = {
      stepId, kind, memberId: member.memberId,
      description: item.description == null ? null : required(item.description, "step description"),
      ...(item.brief != null && { brief: required(item.brief, "step brief") }),
      dependsOn: refs(item.dependsOn ?? [], "dependsOn"),
      ...(kind === "independent" && { inputPacket: normalizeReviewPacket(item.inputPacket) }),
      version: 1, status: "waiting", blockedBy: [], receipt: null, rejection: null, revision: null,
    };
    if (member.pendingBinding) {
      if (item.taskId) throw new Error(`Pending member ${member.memberId} requires a deferred task binding`);
      return { ...common, taskId: null, writeRoots: [],
        ...(item.writeRoots !== undefined && { declaredWriteRoots: refs(item.writeRoots, "writeRoots") }) };
    }
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
    const writeRoots = workScope(workTask, item, stepId);
    return { ...common, taskId: workTaskId, writeRoots };
  });
  for (const member of members) {
    if (member.pendingBinding) {
      if (!steps.some(step => step.memberId === member.memberId)) throw new Error(`Pending member ${member.memberId} needs a planned step`);
      continue;
    }
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
  const bound = members.filter(member => !member.pendingBinding);
  if (new Set(bound.map(member => JSON.stringify([member.agent, member.conversationId]))).size !== bound.length) {
    throw new Error("Each work run member needs a distinct agent/session identity");
  }
  const stepIndex = byId(steps, "stepId");
  const ancestors = getAncestors(steps);
  const selected = selectMode(requestedMode, steps, ancestors);
  validateTrackExclusivity(engine, task, steps, ancestors, new Set(bindings.keys()));
  if (plan.collaboration && !allowPendingBindings) throw new Error("Use the collaboration recipe entry point to set work run collaboration metadata");
  return { ...selected, members, steps, requirements: normalizeRequirements(task, plan.requirements, stepIndex), bindings,
    ...(plan.collaboration && { collaboration: normalizeCollaboration(plan.collaboration) }),
  };
}

function normalizeCollaboration(value) {
  const fields = ["schemaVersion", "mode", "route", "originalPrompt", "objective", "brief", "requestedStrategy", "milestones", "roles", "boostPairs", "finalStepId", "comparisonProtocol"];
  const encoded = value && JSON.stringify(Object.fromEntries(fields.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])));
  if (!value || typeof value !== "object" || Array.isArray(value) || !encoded || Buffer.byteLength(encoded) > 64 * 1024) {
    throw new Error("Work plan collaboration must be a JSON object up to 64 KiB");
  }
  const result = JSON.parse(encoded);
  if (result.comparisonProtocol !== undefined) result.comparisonProtocol = normalizeComparisonProtocol(result.comparisonProtocol);
  return result;
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
  const members = byId(run.members, "memberId");
  const previouslyReady = new Set(run.steps.filter(step => step.status === "ready").map(step => step.stepId));
  const independent = run.steps.filter(isIndependent);
  const missingAnalyses = independent.filter(step => !step.receipt).map(step => step.stepId);
  run.evidenceUnlocked = !missingAnalyses.length;
  for (const step of run.steps) {
    step.blockedBy = step.dependsOn.filter(id => !steps.get(id).receipt);
    if (!isIndependent(step) && !step.receipt) {
      step.blockedBy = [...new Set([...step.blockedBy, ...missingAnalyses])];
    }
    step.status = step.receipt ? "delivered" : run.acceptance ? "stopped" :
      step.blockedBy.length ? "waiting" : (!step.taskId || members.get(step.memberId).retiredAt) ? "pending_binding" : "ready";
    if (step.receipt && isIndependent(step)) {
      step.receipt = run.evidenceUnlocked ? currentReceipt(engine, run, step, incoming) :
        { receiptId: step.receipt.receiptId, stepVersion: step.version };
    }
  }
  const capacity = run.collaboration?.requestedStrategy?.maxParallel;
  if (Number.isInteger(capacity) && capacity > 0) {
    const busy = new Set();
    const candidates = run.steps.filter(step => ["ready", "pending_binding"].includes(step.status));
    candidates.sort((left, right) => Number(previouslyReady.has(right.stepId)) - Number(previouslyReady.has(left.stepId)) ||
      Number(right.status === "ready") - Number(left.status === "ready"));
    for (const step of candidates) {
      const member = members.get(step.memberId);
      if (member.agent && member.conversationId === run.leadSessionId && (!run.leadAgent || member.agent === run.leadAgent)) continue;
      if (busy.has(step.memberId) || (busy.size >= capacity && !previouslyReady.has(step.stepId))) {
        step.status = "queued";
      } else {
        busy.add(step.memberId);
      }
    }
  }
  run.readySteps = run.steps.filter(step => step.status === "ready").map(step => step.stepId);
  run.bindingNeededSteps = run.steps.filter(step => step.status === "pending_binding").map(step => step.stepId);
  run.queuedSteps = run.steps.filter(step => step.status === "queued").map(step => step.stepId);
  run.status = run.acceptance ? "completed" :
    run.steps.every(step => step.receipt) ? "awaiting_acceptance" : "active";
}

export function saveRun(engine, task, run) {
  return engine.repos.putTask({
    ...task, metadata: { ...task.metadata, workRun: run }, updated_at: engine._nowIso(),
  });
}

export function recordWorkBoardEntry(engine, task, logicalKey, entry) {
  const eventId = eventKey(task.id, "work_board_entry", logicalKey);
  const seq = engine.repos.nextSeq();
  const createdAt = engine._nowIso();
  const event = engine.repos.putTaskEvent({
    eventId, taskId: task.id, logicalKey, kind: "work_board_entry", seq, createdAt,
    payloadHash: crypto.createHash("sha256").update(JSON.stringify(canonical(entry))).digest("hex"),
    payload: entry, contractVersion: task.metadata.workflow.contract.version,
  });
  return { ...event.payload, seq: event.seq, createdAt: event.createdAt };
}

function emitReady(engine, task, run, previous = []) {
  const before = new Set(previous.filter(step => step.status === "ready").map(step => JSON.stringify([step.stepId, step.version])));
  for (const old of previous) {
    const next = run.steps.find(step => step.stepId === old.stepId);
    if (old.status === "pending_binding" && !(next?.status === "pending_binding" && next.version === old.version)) {
      obsoleteRunNotices(engine, { run, recipient: coordinator(task, run),
        match: notice => notice.body.metadata?.bindingStepId === old.stepId && notice.body.metadata?.stepVersion === old.version,
        reason: "skipped_work_run_stale",
      });
    }
    if (old.status !== "ready" || (next?.status === "ready" && next.version === old.version)) continue;
    obsoleteRunNotices(engine, { run, recipient: run.members.find(member => member.memberId === old.memberId),
      match: notice => notice.body.metadata?.stepId === old.stepId && notice.body.metadata?.stepVersion === old.version,
      reason: "skipped_work_run_stale",
    });
  }
  for (const step of run.steps) {
    const prior = previous.find(item => item.stepId === step.stepId);
    if (step.status === "pending_binding" && run.evidenceUnlocked &&
        !(prior?.status === "pending_binding" && prior.version === step.version)) {
      const entry = recordWorkBoardEntry(engine, task, JSON.stringify(["binding", step.stepId, step.version, run.version]), {
        type: "binding_needed", channel: "main", fromMemberId: "@coordinator", toMemberIds: ["@coordinator"],
        stepId: step.stepId, stepVersion: step.version, memberId: step.memberId,
        text: `Step ${step.stepId} is eligible for assignment. Attach the exact task and session for ${step.memberId}.`,
      });
      const recipient = coordinatorBinding(engine, task, run);
      if (recipient) notifyWorkBoardPost(engine, { task, run, sender: coordinator(task, run), recipient, seq: entry.seq,
        metadata: { bindingStepId: step.stepId, stepVersion: step.version } });
    }
    if (step.status !== "ready" || before.has(JSON.stringify([step.stepId, step.version]))) continue;
    const member = run.members.find(item => item.memberId === step.memberId);
    if (member.conversationId) notifyWorkRunStep(engine, { task, run, step, member });
    if (!isIndependent(step) && run.evidenceUnlocked) {
      recordWorkBoardEntry(engine, task, JSON.stringify(["ready", step.stepId, step.version, run.version]), {
        type: "step_ready", channel: "main", fromMemberId: "@coordinator", toMemberIds: [step.memberId],
        stepId: step.stepId, stepVersion: step.version,
        text: step.description ?? `Step ${step.stepId} is ready.`,
      });
    }
  }
}

function emitAcceptanceReady(engine, task, run, previous) {
  if (previous.status === "awaiting_acceptance" && previous.version !== run.version) {
    obsoleteRunNotices(engine, { run, recipient: acceptanceRecipient(engine, task, previous),
      match: notice => notice.body.subject === "Work run ready for acceptance" && notice.body.metadata?.runVersion === previous.version,
      reason: run.acceptance ? "skipped_work_run_closed" : "skipped_work_run_stale",
    });
  }
  if (run.status !== "awaiting_acceptance" || previous.version === run.version) return;
  const recipient = acceptanceRecipient(engine, task, run);
  if (!recipient) return;
  notifyWorkRunAcceptance(engine, { task, run });
  recordWorkBoardEntry(engine, task, JSON.stringify(["acceptance", run.version]), {
    type: "acceptance_ready", channel: "main", fromMemberId: "@coordinator", toMemberIds: [recipient.memberId],
    runVersion: run.version, text: "All work run steps have delivered. Review the current evidence and requirements.",
  });
}

function resultOf(run) {
  const { runId, taskId, workMode, requestedMode, selectionReason, version, status, readySteps } = run;
  return {
    accepted: true, runId, taskId, workMode, requestedMode, selectionReason, version, status, readySteps,
    bindingNeededSteps: run.bindingNeededSteps, queuedSteps: run.queuedSteps,
    ...(run.acceptance && { disposition: run.acceptance.disposition ?? "complete" }),
  };
}

export function startWorkRun(engine, args) {
  return transactWorkRun(engine, args, "work_run_start", args.eventId, task => {
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
    const { bindings, ...plan } = normalizePlan(engine, task, requestedMode, args.workPlan, args.allowPendingBindings === true);
    const leadSessionId = trustedLeadSession || args.actorSessionId || null;
    if (!leadSessionId && plan.members.length > 1 && plan.members.some(member => member.agent === task.from_agent)) {
      throw new Error("Bind the lead session before starting a run with another member on the lead's agent");
    }
    const run = {
      runId: task.id, taskId: task.id, requestedMode, version: 1, ...plan, leadSessionId, leadAgent: task.from_agent,
      contractVersion: task.metadata.workflow.contract.version,
      acceptor: task.metadata.workflow.contract.acceptor,
      acceptorFollowsLead: task.metadata.workflow.contract.acceptor === task.from_agent,
      acceptance: null, createdAt: engine._nowIso(),
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

function dynamicTask(engine, root, run, member, taskId) {
  const task = engine.repos.getTask(required(taskId, "binding taskId"));
  const binding = task?.metadata?.workRunBinding;
  const belongs = task?.id === root.id || binding?.taskId === root.id && binding.memberId === member.memberId;
  if (!task?.metadata?.workflow || ![root.from_agent, run.leadAgent].includes(task.from_agent) ||
      task.assigned_to !== member.agent || taskSession(task) !== member.conversationId ||
      terminal.has(task.status) || ["delivered", "completed", "cancelled"].includes(task.metadata.workflow.status) ||
      (!belongs && (binding || task.metadata.workRun)) || (task.id === root.id && member.taskId !== root.id)) {
    throw new Error(`Binding requires a compatible active task and the exact session for ${member.memberId}`);
  }
  const project = path.resolve(root.cwd || ".");
  if (!within(project, path.resolve(task.cwd || ".")) || roots(task).some(scope => !within(project, scope))) {
    throw new Error("A dynamic task and its write scope must belong to the work run project");
  }
  if (run.collaboration && task.id !== root.id) {
    if (!collaborationSessionAttested(engine, task, root)) {
      throw new Error("The member must attest its task and session through bridge_claim_task before binding to this recipe");
    }
    const intake = engine.repos.listTaskEvents({ taskId: root.id, kind: "collaboration_intake", limit: 1 })[0]?.result;
    const permissions = intake?.permissions ?? root.permissions;
    validateCollaborationMemberScope(root, task, [{ writeRoots: permissions?.writeRoots ?? [] }], permissions);
  }
  return task;
}

function bindDynamicTask(engine, root, run, task, member) {
  if (task.id === root.id) return;
  engine.repos.putTask({
    ...task, metadata: { ...task.metadata, workRunBinding: {
      taskId: root.id, runId: run.runId, memberId: member.memberId,
      stepIds: run.steps.filter(step => step.taskId === task.id).map(step => step.stepId),
    } }, updated_at: engine._nowIso(),
  });
}

function addRunMember(engine, task, run, item) {
  const memberId = required(item?.memberId, "memberId");
  if (memberId.startsWith("@") || !agents.has(item.agent)) throw new Error("A named member and a supported agent are required");
  const conversationId = required(item.conversationId, "conversationId");
  const taskId = required(item.taskId, "member taskId");
  if (taskId === task.id || run.members.some(member => member.memberId === memberId ||
      (member.agent === item.agent && member.conversationId === conversationId))) {
    throw new Error("The named member, session, and task must be distinct run bindings");
  }
  const member = { memberId, agent: item.agent, conversationId, taskId, joinedAfterSeq: boardHead(engine, task),
    ...(item.role != null && { role: required(item.role, "member role") }) };
  const workTask = dynamicTask(engine, task, run, member, taskId);
  bindDynamicTask(engine, task, run, workTask, member);
  run.members.push(member);
  return { memberId };
}

function boardHead(engine, task) {
  return engine.repos.listTaskEvents({ taskId: task.id, kind: "work_board_entry", limit: 1 })[0]?.seq ?? 0;
}

function bindRunMember(engine, task, run, args) {
  const member = activeMember(run, args.memberId);
  const item = args.member;
  if (!member.pendingBinding || !item || !agents.has(item.agent) || (item.memberId && item.memberId !== member.memberId)) {
    throw new Error("Binding requires a deferred role and its exact authorized task, agent and session");
  }
  const conversationId = required(item.conversationId, "conversationId");
  const taskId = required(item.taskId, "member taskId");
  if (taskId === task.id || run.members.some(candidate => candidate.agent === item.agent && candidate.conversationId === conversationId)) {
    throw new Error("A deferred member requires a distinct task and session binding");
  }
  Object.assign(member, { agent: item.agent, conversationId, taskId, joinedAfterSeq: boardHead(engine, task) });
  const workTask = dynamicTask(engine, task, run, member, taskId);
  for (const step of run.steps.filter(step => step.memberId === member.memberId)) {
    step.taskId = taskId;
    step.writeRoots = workScope(workTask, { writeRoots: step.declaredWriteRoots }, step.stepId);
    if (isIndependent(step) && step.writeRoots.length) throw new Error("An independent step must use an authorized read-only task");
    delete step.declaredWriteRoots;
  }
  delete member.pendingBinding;
  bindDynamicTask(engine, task, run, workTask, member);
  return { memberId: member.memberId };
}

function activeMember(run, id) {
  const member = run.members.find(item => item.memberId === id && !item.retiredAt);
  if (!member) throw new Error(`Unknown active work run member: ${id}`);
  return member;
}

function addRunTrack(engine, task, run, item) {
  const stepId = required(item?.stepId, "track stepId");
  if (run.steps.some(step => step.stepId === stepId)) throw new Error(`Duplicate track stepId: ${stepId}`);
  const member = activeMember(run, item.memberId);
  const workTask = member.pendingBinding ? null : dynamicTask(engine, task, run, member, item.taskId ?? member.taskId);
  if (!workTask && item.taskId) throw new Error("A deferred member must first be bound to its task");
  const kind = item.kind ?? "work";
  if (!kinds.has(kind) || kind === "independent") throw new Error("Dynamic tracks require a public work run step kind");
  const step = {
    stepId, kind, memberId: member.memberId, taskId: workTask?.id ?? null, writeRoots: workTask ? workScope(workTask, item, stepId) : [],
    ...(!workTask && item.writeRoots !== undefined && { declaredWriteRoots: refs(item.writeRoots, "writeRoots") }),
    description: item.description == null ? null : required(item.description, "step description"),
    ...(item.brief != null && { brief: required(item.brief, "step brief") }),
    dependsOn: refs(item.dependsOn ?? [], "dependsOn"), version: 1, status: "waiting", blockedBy: [],
    receipt: null, rejection: null, revision: null,
  };
  run.steps.push(step);
  const requirementIds = refs(item.requirementIds ?? [], "requirementIds");
  for (const id of requirementIds) {
    const requirement = run.requirements.find(entry => entry.requirementId === id);
    if (!requirement) throw new Error(`Unknown delivery requirement: ${id}`);
    requirement.stepIds.push(stepId);
  }
  if (workTask) bindDynamicTask(engine, task, run, workTask, member);
  return { stepId, memberId: member.memberId };
}

function addCollaborationTrack(engine, task, run, track) {
  const expanded = expandDynamicCollaborationTrack(run.collaboration, track);
  const first = addRunTrack(engine, task, run, expanded.steps[0]);
  const addedStepIds = [first.stepId];
  if (expanded.boostPair) {
    const reviewer = addRunTrack(engine, task, run, expanded.steps[1]);
    if (reviewer.memberId === first.memberId) throw new Error("Boost challenge requires a distinct member session");
    addedStepIds.push(reviewer.stepId);
    run.collaboration.boostPairs = [...(run.collaboration.boostPairs ?? []), expanded.boostPair];
  }
  const gate = addedStepIds.at(-1);
  const requested = refs(track.beforeStepIds ?? [], "beforeStepIds");
  const final = run.collaboration?.finalStepId;
  const downstream = new Set(final ? [...requested, final] : requested);
  const revised = new Set();
  for (const id of downstream) {
    const step = run.steps.find(item => item.stepId === id);
    if (!step || isIndependent(step) || addedStepIds.includes(id)) throw new Error(`Invalid downstream track: ${id}`);
    const prior = getAncestors(run.steps);
    step.dependsOn = [...new Set([...step.dependsOn, gate])];
    if (prior.get(gate).has(id)) throw new Error(`WORK_RUN_DEPENDENCY_CYCLE: ${id}`);
    if (step.status !== "waiting" || step.receipt) invalidate(run, step, {}, revised);
  }
  return { ...first, addedStepIds };
}

function retireRunMember(engine, task, run, args) {
  const member = activeMember(run, args.memberId);
  if (member.pendingBinding) throw new Error("A required deferred member cannot be retired before delivering its planned steps");
  const lead = coordinator(task, run);
  if ((member.agent === lead.agent && member.conversationId === lead.conversationId) ||
      run.steps.some(step => step.memberId === member.memberId && (!step.receipt || isIndependent(step)))) {
    throw new Error("Retirement requires a successor for lead duties and no open or isolated work assigned to the member");
  }
  if (!(run.acceptorFollowsLead ?? run.acceptor === task.from_agent) && member.agent === run.acceptor &&
      !run.members.some(candidate => candidate !== member && !candidate.retiredAt && candidate.agent === run.acceptor)) {
    throw new Error("The run requires an active bound acceptor");
  }
  const tasks = memberBinding(engine, task, run, member)?.tasks ?? [];
  for (const item of tasks) {
    if (item.id !== task.id) engine.revokeTaskLease(item.id);
  }
  member.retiredAt = engine._nowIso();
  obsoleteRunNotices(engine, { run, recipient: member, match: () => true, reason: "skipped_work_run_retired" });
  return { memberId: member.memberId };
}

function reassignRunTrack(engine, task, run, args) {
  const step = run.steps.find(item => item.stepId === args.stepId);
  if (!step || step.receipt || isIndependent(step)) throw new Error("Reassignment requires an undelivered public track");
  if (args.stepVersion !== step.version) throw new Error("WORK_RUN_STEP_VERSION_CONFLICT");
  const member = activeMember(run, args.memberId);
  const pair = run.collaboration?.boostPairs?.find(item => item.authorStepId === step.stepId || item.reviewStepId === step.stepId);
  if (pair && run.steps.some(item => item.stepId !== step.stepId &&
      [pair.authorStepId, pair.reviewStepId].includes(item.stepId) && item.memberId === member.memberId)) {
    throw new Error("Boost author and challenger require distinct member sessions");
  }
  const proposed = dynamicTask(engine, task, run, member, args.memberTaskId ?? member.taskId);
  const previous = step.taskId && engine.repos.getTask(step.taskId);
  if (step.memberId === member.memberId && step.taskId === proposed.id) throw new Error("The track already has this binding");
  if (step.status === "ready" && previous?.status === "in_progress") {
    throw new Error("Reassignment requires the current execution to stop first");
  }
  const scope = workScope(proposed, args, step.stepId);
  if (scope.some(root => !step.writeRoots.some(allowed => within(allowed, root))) ||
      step.writeRoots.some(root => !scope.some(allowed => within(allowed, root)))) {
    throw new Error("Reassignment must preserve the track's write scope");
  }
  const oldMember = run.members.find(item => item.memberId === step.memberId);
  invalidate(run, step, { memberId: member.memberId, taskId: proposed.id, writeRoots: scope });
  if (previous && previous.id !== proposed.id) {
    bindDynamicTask(engine, task, run, previous, oldMember);
    if (previous.id !== task.id && !run.steps.some(item => item.taskId === previous.id && !item.receipt)) {
      engine.revokeTaskLease(previous.id);
      run.releasedTaskIds = [...new Set([...(run.releasedTaskIds ?? []), previous.id])];
    }
  }
  bindDynamicTask(engine, task, run, proposed, member);
  return { stepId: step.stepId, memberId: member.memberId };
}

function handoffRunLead(engine, task, run, args) {
  const member = activeMember(run, args.memberId);
  const previous = coordinator(task, run);
  if (args.conversationId !== member.conversationId || !memberBinding(engine, task, run, member) ||
      (member.agent === previous.agent && member.conversationId === previous.conversationId) ||
      (run.evidenceUnlocked === false && run.steps.some(step => isIndependent(step) && step.memberId === member.memberId))) {
    throw new Error("Handoff requires a distinct active member with its exact eligible session binding");
  }
  dynamicTask(engine, task, run, member, member.taskId);
  const followsLead = run.acceptorFollowsLead ?? run.acceptor === task.from_agent;
  run.leadAgent = member.agent;
  run.leadMemberId = member.memberId;
  run.leadSessionId = member.conversationId;
  run.acceptorFollowsLead = followsLead;
  if (followsLead) run.acceptor = member.agent;
  const successor = coordinatorBinding(engine, task, run);
  obsoleteRunNotices(engine, { run, recipient: previous,
    match: notice => notice.body.metadata?.boardSeq != null ||
      ["Work run ready for acceptance", "Work run lead responsibility transferred"].includes(notice.body.subject),
    reason: "skipped_work_run_handoff",
    onObsolete: notice => {
      const seq = notice.body.metadata?.boardSeq;
      if (seq != null) notifyWorkBoardPost(engine, { task, run, sender: previous, recipient: successor, seq,
        metadata: notice.body.metadata });
    },
  });
  return { memberId: member.memberId };
}

export function changeWorkRun(engine, args) {
  return transactWorkRun(engine, args, "work_run_change", args.eventId, task => {
    const previous = task.metadata.workRun;
    if (!previous || previous.runId !== args.runId) throw new Error("Work run not found");
    if (!args.actorSessionId || !isWorkRunLead(task, previous, args) || !coordinatorBinding(engine, task, previous)) {
      throw new Error("This change requires the current bound work run lead");
    }
    if (previous.status === "completed" || terminal.has(task.status)) throw new Error("The work run is closed");
    if (args.runVersion !== previous.version) throw new Error("WORK_RUN_VERSION_CONFLICT");
    const run = structuredClone(previous);
    const changes = {
      add_member: () => addRunMember(engine, task, run, args.member),
      bind_member: () => bindRunMember(engine, task, run, args),
      add_track: () => addCollaborationTrack(engine, task, run, args.track),
      retire_member: () => retireRunMember(engine, task, run, args),
      reassign_track: () => reassignRunTrack(engine, task, run, args),
      handoff_lead: () => handoffRunLead(engine, task, run, args),
    };
    const apply = changes[args.action];
    if (!apply) throw new Error("Unknown work run change");
    const details = apply();
    if (["add_track", "bind_member", "reassign_track"].includes(args.action)) {
      validateTrackExclusivity(engine, task, run.steps, getAncestors(run.steps), new Set(run.steps.map(step => step.taskId)));
    }
    run.version += 1;
    refresh(engine, run);
    const saved = saveRun(engine, task, run);
    emitReady(engine, saved, run, previous.steps);
    emitAcceptanceReady(engine, saved, run, previous);
    const successor = args.action === "handoff_lead" ? coordinatorBinding(engine, saved, run) : null;
    if (run.evidenceUnlocked) {
      const entry = recordWorkBoardEntry(engine, saved, JSON.stringify(["change", args.eventId]), {
        type: args.action, channel: "main", fromMemberId: "@coordinator", toMemberIds: successor ? ["@coordinator"] : [],
        ...details, ...(successor && { text: `Work run lead responsibility transferred to ${successor.boundMemberId}.` }),
      });
      if (successor) notifyWorkBoardPost(engine, { task: saved, run, sender: coordinator(task, previous), recipient: successor, seq: entry.seq });
    } else if (successor) {
      notifyWorkRunLeadTransfer(engine, { task: saved, run, previous: coordinator(task, previous), recipient: successor });
    }
    return { ...resultOf(run), ...details };
  });
}

function matchesActor(member, args) {
  return !member.retiredAt && member.agent === args.actorAgent && (!member.conversationId || member.conversationId === args.actorSessionId);
}

export function isWorkRunLead(task, run, args) {
  return (run.leadAgent ?? task.from_agent) === args.actorAgent && (!run.leadSessionId || run.leadSessionId === args.actorSessionId);
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

function invalidate(run, target, update, revised = new Set()) {
  const ancestors = getAncestors(run.steps);
  for (const step of run.steps) {
    if (!revised.has(step.stepId) && (step === target || ancestors.get(step.stepId).has(target.stepId) || (isIndependent(target) && !isIndependent(step)))) {
      revised.add(step.stepId);
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
  const leadAccepts = run.acceptorFollowsLead ?? run.acceptor === task.from_agent;
  if (leadAccepts && !isWorkRunLead(task, run, args)) throw new Error("Acceptance requires the bound lead session");
  const acceptorMembers = run.members.filter(member => member.agent === run.acceptor);
  if (!leadAccepts && acceptorMembers.length &&
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
  const protocol = run.collaboration?.comparisonProtocol;
  const fairReceipt = protocol && steps.get(run.collaboration.finalStepId)?.receipt;
  const comparisons = protocol ? validateComparisonEvidence(protocol, fairReceipt?.comparisonEvidence, {
    disposition, evidenceRefs: fairReceipt?.evidenceRefs ?? [],
  }) : null;
  run.acceptance = {
    receiptId: args.receiptId, runVersion: run.version, contractVersion: run.contractVersion,
    actor: args.actorAgent, disposition, summary, openQuestions, requirementEvidence, acceptedAt: engine._nowIso(),
    ...(comparisons && { comparisons }),
  };
}

function stopReadyNotices(engine, root, run) {
  for (const recipient of [...run.members, coordinator(root, run)]) {
    obsoleteRunNotices(engine, { run, recipient, match: () => true, reason: "skipped_work_run_closed" });
  }
}

function closeTasks(engine, root, run) {
  const now = engine._nowIso();
  const ids = new Set([root.id, ...run.steps.map(step => step.taskId), ...run.members.map(member => member.taskId),
    ...(run.releasedTaskIds ?? [])].filter(Boolean));
  for (const id of ids) {
    const task = engine.repos.getTask(id);
    if (!task) continue;
    const workflow = task.metadata.workflow;
    const steps = run.steps.filter(step => step.taskId === id);
    const completed = id === root.id || (steps.length > 0 && steps.every(step => step.receipt));
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
  return transactWorkRun(engine, args, "work_run_receipt", args.receiptId, task => {
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
      if (!owner && !(args.outcome === "revise" && isWorkRunLead(task, run, args))) {
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
          const protocol = run.collaboration?.comparisonProtocol;
          const fairAudit = protocol && step.stepId === run.collaboration.finalStepId;
          if (fairAudit && args.comparisonEvidence !== undefined) {
            validateComparisonEvidence(protocol, args.comparisonEvidence, { disposition: "partial", evidenceRefs });
          }
          step.receipt = { receiptId: args.receiptId, stepVersion: step.version, summary, evidenceRefs };
          if (fairAudit && args.comparisonEvidence !== undefined) step.receipt.comparisonEvidence = structuredClone(args.comparisonEvidence);
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
    emitAcceptanceReady(engine, saved, run, previous);
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
  if (!actor.actorAgent) return run;
  const root = parent ? engine.repos.getTask(parent.taskId) : task;
  const lead = isWorkRunLead(root, run, actor);
  return {
    ...run,
    steps: run.steps.map(step => {
      const owner = ownsStep(engine, run, step, actor);
      const { brief, inputPacket, ...publicStep } = step;
      return {
        ...publicStep,
        ...((lead || owner) && brief !== undefined && { brief }),
        ...((lead || owner) && inputPacket !== undefined && { inputPacket }),
        ...(!run.evidenceUnlocked && isIndependent(step) && step.receipt && owner &&
          { receipt: currentReceipt(engine, run, step) }),
      };
    }),
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
      ...(receipt.comparisonEvidence !== undefined && { comparisonEvidence: receipt.comparisonEvidence }),
    });
  }
  return {
    accepted: false, status: "needs_work_run_receipt", runId: run?.runId ?? null,
    stepId: step?.stepId ?? null, stepVersion: step?.version ?? null,
    reason: step && isIndependent(step) ? "Independent work requires a receipt from the isolated executor." :
      "Report the current step ID and version, trusted owner session, and delivery evidence using a work run receipt.",
  };
}
