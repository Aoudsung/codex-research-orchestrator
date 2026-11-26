import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BridgeDatabase } from "../src/core/bridge-db.mjs";
import { registerBridgeTools } from "../src/core/bridge-tools.mjs";
import { McpStdioServer } from "../src/core/mcp-server.mjs";

function setup(t) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-recipes-"));
  const dbPath = path.join(project, "bridge.sqlite");
  const databases = [];
  const env = {
    MCP_CALLER_AGENT: undefined, MCP_TARGET_AGENT: undefined, MCP_ONE_SHOT_WORKER: "1",
    BRIDGE_DISABLE_WAKEUP_DAEMON: "1", BRIDGE_DISABLE_CLI_WAKEUP: "1",
    RESEARCH_MEMORY_PROJECT: undefined,
  };
  for (const [key, value] of Object.entries(env)) {
    const original = process.env[key];
    t.after(() => {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    });
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const db of databases) {
      db.stopCrossProcessWatcher();
      db.db.close();
    }
    fs.rmSync(project, { recursive: true, force: true });
  });
  function connect(callerSessionId, toolProfile = "lead") {
    const db = new BridgeDatabase(dbPath);
    databases.push(db);
    const server = new McpStdioServer({ name: callerSessionId });
    registerBridgeTools(server, db, { defaultCaller: "codex", callerSessionId, toolProfile });
    let sequence = 0;
    let response;
    server._send = value => { if (value.id !== undefined) response = value; };
    return async (tool, args, errorPattern) => {
      const id = ++sequence;
      await server._dispatch({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "bridge_" + tool, arguments: args } });
      assert.equal(response?.id, id);
      assert.equal(response.error, undefined);
      const result = JSON.parse(response.result.content[0].text);
      if (errorPattern) {
        assert.equal(response.result.isError, true, JSON.stringify(result));
        assert.match(result.error, errorPattern);
      } else {
        assert.equal(response.result.isError, false, JSON.stringify(result));
        assert.notEqual(result.ok, false);
      }
      return result;
    };
  }
  const lead = connect("lead");
  async function provision(taskId, role, { attest = true, sessionId = "worker-" + role.memberId, writeRoots = role.writeRoots ?? [] } = {}) {
    const memberTaskId = taskId + "-" + role.memberId;
    await lead("create_task", {
      taskId: memberTaskId, prompt: "Scoped worker bootstrap for " + role.memberId,
      cwd: project, assignedTo: "codex", autoWakeup: false, writeRoots,
      ...(!attest && { requiredConversationId: sessionId }),
    });
    const worker = connect(sessionId, "worker");
    if (attest) await worker("claim_task", { taskId: memberTaskId, collaborationTaskId: taskId });
    return { worker, memberTaskId };
  }
  function bind(taskId, run, role, memberTaskId, errorPattern) {
    return lead("collaborate", { action: "bind", taskId, memberId: role.memberId, memberTaskId,
      eventId: "bind-" + role.memberId, runVersion: run.version }, errorPattern);
  }
  return { project, connect, lead, provision, bind };
}

function track(id, objective, overrides = {}) {
  return { id, title: objective, objective, deliverable: objective + " artifact", acceptance: "Replay the scoped check for " + id, ...overrides };
}

function deliver(call, taskId, stepId, stepVersion, receiptId, extra = {}, errorPattern) {
  return call("submit_task_receipt", {
    operation: "work_step", taskId, runId: taskId, stepId, stepVersion, receiptId,
    outcome: "delivered", summary: "Observed check passed", evidenceRefs: ["artifact:" + receiptId], ...extra,
  }, errorPattern);
}

test("ordinary Boost intake, observed member identities, counterexample, versioned retest and lead evidence", async t => {
  const f = setup(t);
  const opened = await f.lead("create_task", {
    prompt: "/boost Investigate intermittent missing rows after refresh",
    cwd: f.project, autoWakeup: false,
  });
  const taskId = opened.task.id;
  const plan = opened.collaboration;
  assert.equal(plan.mode, "boost");
  assert.equal(plan.route, "investigation");
  assert.deepEqual(plan.plan.collaboration.boostPairs, [{ authorStepId: "candidate", reviewStepId: "candidate-challenge" }]);
  const [first, challenger] = plan.roleBriefs;
  const candidate = await f.provision(taskId, first);
  const challenge = await f.provision(taskId, challenger, { attest: false });
  const start = { action: "start", taskId, eventId: "start", bindings: { candidate: { taskId: candidate.memberTaskId } } };
  await f.lead("collaborate", { ...start, bindings: { ...start.bindings, [challenger.memberId]: { taskId: challenge.memberTaskId } } }, /bootstrap/);
  const active = await f.lead("collaborate", start);
  assert.deepEqual(active.run.readySteps, ["candidate"]);
  assert.equal((await f.lead("collaborate", start)).result.duplicate, true);
  await f.lead("collaborate", { ...start, bindings: {} }, /TASK_EVENT_CONFLICT/);
  await challenge.worker("claim_task", { taskId: challenge.memberTaskId, collaborationTaskId: taskId });
  const firstDelivery = await deliver(candidate.worker, taskId, "candidate", 1, "hypothesis");
  const attached = await f.bind(taskId, firstDelivery.result, challenger, challenge.memberTaskId);
  const brief = await challenge.worker("collaborate", { action: "brief", taskId, stepId: challenger.stepId });
  assert.match(brief.step.brief, /original request/i);
  assert.equal(brief.step.inputs[0].receipt.evidenceRefs[0], "artifact:hypothesis");
  await candidate.worker("collaborate", { action: "brief", taskId, stepId: challenger.stepId }, /unavailable/);
  const counterexample = await deliver(challenge.worker, taskId, challenger.stepId, 1, "falsify", {
    outcome: "counterexample", counterexample: { stepId: "candidate", description: "Primary trace contradicts candidate", evidenceRefs: ["trace:counterexample"] },
  });
  assert.ok(counterexample.result.version > attached.run.version);
  const stale = await deliver(candidate.worker, taskId, "candidate", 1, "stale-candidate");
  assert.equal(stale.result.staleForTransition, true);
  await deliver(candidate.worker, taskId, "candidate", 2, "repaired");
  const retest = await deliver(challenge.worker, taskId, challenger.stepId, 2, "verified");
  assert.deepEqual(retest.result.readySteps, ["lead-check"]);
  const resumed = await f.connect("lead")("collaborate", { action: "resume", taskId });
  assert.equal(resumed.nextAction.action, "lead_check");
  assert.equal(resumed.nextAction.step.inputs[0].receipt.receiptId, "verified");
  await deliver(f.lead, taskId, "lead-check", 2, "lead-checked");
  const awaiting = await f.lead("collaborate", { action: "status", taskId });
  assert.equal(awaiting.state, "awaiting_acceptance");
  const result = await f.lead("accept_task_delivery", {
    taskId, runId: taskId, runVersion: awaiting.run.version, eventId: "accept",
    requirementEvidence: awaiting.run.requirements.map(requirement => ({
      requirementId: requirement.requirementId, stepId: "lead-check", stepVersion: 2, receiptId: "lead-checked",
      evidenceRefs: ["artifact:lead-checked"],
    })),
  });
  assert.equal(result.result.status, "completed");
});

test("Swarm reserves separate track scopes and applies a verifier counterexample before integration", async t => {
  const f = setup(t);
  for (const dir of ["parser", "cache"]) fs.mkdirSync(path.join(f.project, dir));
  const opened = await f.lead("collaborate", {
    action: "open", objective: "$swarm Update the parser and cache independently", eventId: "intent", cwd: f.project, writeRoots: ["parser", "cache"],
  });
  assert.equal(opened.state, "needs_plan");
  const { taskId } = opened;
  assert.equal((await f.lead("collaborate", {
    action: "open", objective: "$swarm Update the parser and cache independently", eventId: "intent", cwd: f.project, writeRoots: ["parser", "cache"],
  })).taskId, taskId);
  const parser = track("parser", "Adjust parser behavior", { writeRoots: ["parser"] });
  const cache = track("cache", "Fix cache invalidation", { writeRoots: ["cache"] });
  await f.lead("collaborate", { action: "plan", taskId, specification: { tracks: [parser, { ...cache, deliverable: parser.deliverable }] } }, /distinct/);
  const prepared = await f.lead("collaborate", {
    action: "plan", taskId, eventId: "plan", specification: { tracks: [parser, cache], maxParallel: 2 },
  });
  const workers = new Map();
  for (const role of prepared.roleBriefs.filter(role => role.memberId !== "lead")) {
    workers.set(role.memberId, await f.provision(taskId, role));
  }
  const started = await f.lead("collaborate", { action: "start", taskId, eventId: "run", bindings: Object.fromEntries(
    [...workers].map(([role, member]) => [role, { taskId: member.memberTaskId }]),
  ) });
  assert.deepEqual(started.run.readySteps, ["track-parser", "track-cache"]);
  await deliver(workers.get("track-parser").worker, taskId, "track-parser", 1, "parse");
  const merged = await deliver(workers.get("track-cache").worker, taskId, "track-cache", 1, "cache");
  assert.deepEqual(merged.result.readySteps, ["swarm-verify:1"]);
  await deliver(workers.get("swarm-verify:1").worker, taskId, "swarm-verify:1", 1, "cache-rejection", {
    outcome: "counterexample", counterexample: { stepId: "track-cache", description: "Stale key retained", evidenceRefs: ["trace:stale"] },
  });
  await deliver(workers.get("track-cache").worker, taskId, "track-cache", 2, "cache-repair");
  const checked = await deliver(workers.get("swarm-verify:1").worker, taskId, "swarm-verify:1", 2, "parser-cache-check");
  assert.deepEqual(checked.result.readySteps, ["swarm-integrate"]);
});

test("Teamwork stalls dependent work on separate current milestone checks", async t => {
  const f = setup(t);
  const routes = [
    ["/teamwork Review the research paper about Lean 4 proofs", "document_review"],
    ["/teamwork Prove the stated inequality", "informal_math"],
    ["/teamwork Prove the stated inequality. Use a very large team", "team_math"],
    ["/teamwork Formalize the stated inequality in Lean 4", "lean4"],
    ["/teamwork Implement a targeted patch to the parser diagnostic", "light_engineering"],
  ];
  for (const [objective, route] of routes) assert.equal((await f.lead("collaborate", { action: "plan", objective })).route, route);
  const opened = await f.lead("collaborate", {
    action: "open", objective: "/teamwork Produce an engineering assessment and rollout plan",
    eventId: "intent", cwd: f.project,
  });
  const { taskId } = opened;
  const specification = { route: "general", milestones: [
    track("assessment", "Check current integration"),
    track("rollout", "Draft the rollout handoff", { dependsOn: ["assessment"] }),
  ] };
  const plan = await f.lead("collaborate", { action: "plan", taskId, eventId: "plan", specification });
  assert.equal(plan.state, "needs_approval");
  await f.lead("collaborate", { action: "start", taskId, eventId: "start" }, /needs_approval/);
  const approval = { type: "existing_authorization", sourceRefs: [opened.intake.sourceRef], successCriteria: ["Assessment and rollout are both verifiable"] };
  await f.lead("collaborate", { action: "approve", taskId, eventId: "approval", approval });
  const active = await f.lead("collaborate", { action: "start", taskId, eventId: "start" });
  assert.equal(active.run.collaboration.mode, "teamwork");
  const run = active.run;
  assert.deepEqual(run.bindingNeededSteps, ["orchestrator"]);
  const { stepIds, exitStepIds } = run.collaboration.milestones[0];
  assert.equal(stepIds.length, 4);
  assert.equal(exitStepIds.length, 3);
  assert.deepEqual(run.steps.find(step => step.stepId === "milestone-rollout").dependsOn, exitStepIds);
  for (const stepId of exitStepIds) {
    const check = run.steps.find(step => step.stepId === stepId);
    assert.notEqual(check.memberId, "milestone-assessment");
    assert.deepEqual(check.dependsOn, ["milestone-assessment"]);
  }
});

test("native Teamwork chip preserves a large research plan with nested Boost, comparative design and two-slot waves", async t => {
  const f = setup(t);
  const suffix = " 那么究竟有没有能够让无论是 7B 还是 1.5B 乃至其他参数量的模型在 TextCrafter、ALFWorld 与 WebShop 都能取得 SOTA 表现的方案呢？Use a very large team of agents. 从而为我构建出一个真正可行且 excellent 的方案. 推进方案与实现的系统升级 过程中要采用/boost 来驱动各个 subagent，从而确保整个方案的质量。不允许任何非公平实验对比的设置";
  const nativePrompt = String.raw`[/teamwork]\(slashCommand;teamwork)` + suffix;
  const opened = await f.lead("collaborate", { action: "open", objective: nativePrompt, eventId: "native", cwd: f.project });
  const { taskId } = opened;
  assert.equal(opened.mode, "teamwork");
  assert.equal(opened.route, "general");
  assert.equal(opened.intake.requestedStrategy.teamSize, "large");
  assert.equal(opened.intake.requestedStrategy.boostScope, "substantive_tracks");
  assert.equal((await f.lead("collaborate", { action: "plan", objective: "[/teamwork](slashCommand;teamwork)" + suffix })).mode, "teamwork");

  const specification = { route: "general", maxParallel: 2, milestones: [
    { ...track("environments", "Establish environment-specific check definitions"), mode: "swarm", tracks: [
      track("textcrafter", "Check TextCrafter task and split definitions"),
      track("alfworld", "Check ALFWorld task and split definitions"),
      track("webshop", "Check WebShop task and split definitions"),
      track("baseline", "Check evidence of matched baseline availability"),
    ] },
    track("design", "Specify a feasible design across model sizes", { dependsOn: ["environments"] }),
  ] };
  const missingProtocol = await f.lead("collaborate", { action: "plan", taskId, specification });
  assert.equal(missingProtocol.nextAction.action, "author_comparison_protocol");
  specification.comparisonProtocol = {
    purpose: "design", dimensions: { modelSize: ["1.5B", "7B"], environment: ["TextCrafter", "ALFWorld", "WebShop"] },
    matchFields: ["split", "interactionBudget", "selectionRule"], openDimensions: ["modelSize"],
  };
  const prepared = await f.lead("collaborate", { action: "plan", taskId, specification, eventId: "blueprint" });
  assert.equal(prepared.state, "needs_approval", JSON.stringify(prepared));
  assert.equal(prepared.plan.collaboration.originalPrompt, nativePrompt);
  const approved = await f.lead("collaborate", { action: "approve", taskId, eventId: "approval", approval: {
    type: "existing_authorization", sourceRefs: [opened.intake.sourceRef], successCriteria: ["Provide a reproducible matched comparison design"],
  } });
  assert.equal(approved.state, "ready");
  assert.match(approved.approval.constraints.join("\n"), /不允许任何非公平实验对比的设置/);
  const initial = await f.lead("collaborate", { action: "start", taskId, eventId: "run" });
  let run = initial.run;
  assert.equal(run.members.filter(member => !member.pendingBinding).length, 1);
  assert.ok(run.members.length > 16);
  assert.equal(run.collaboration.requestedStrategy.maxParallel, 2);
  const substantive = prepared.roleBriefs.filter(role => !role.primitive);
  assert.deepEqual(new Set(run.collaboration.boostPairs.map(pair => pair.authorStepId)), new Set(substantive.map(role => role.stepId)));
  assert.deepEqual(run.bindingNeededSteps, ["orchestrator"]);

  async function provisionAndDeliver(stepId) {
    const role = prepared.roleBriefs.find(item => item.stepId === stepId);
    const member = await f.provision(taskId, role);
    const attached = await f.bind(taskId, run, role, member.memberTaskId);
    assert.ok(attached.run.readySteps.includes(stepId));
    await deliver(member.worker, taskId, stepId, 1, "receipt-" + stepId);
    run = (await f.connect("lead")("collaborate", { action: "resume", taskId })).run;
  }
  await provisionAndDeliver("orchestrator");
  await provisionAndDeliver("boost-check:orchestrator");
  assert.equal(run.bindingNeededSteps.length, 2);
  assert.equal(run.queuedSteps.length, 2);
  const [first, second] = run.bindingNeededSteps;
  await provisionAndDeliver(first);
  assert.ok(run.bindingNeededSteps.includes(second));
  assert.equal(run.bindingNeededSteps.length + run.readySteps.length, 2);
  assert.ok(run.steps.some(step => step.stepId.startsWith("boost-check:") && step.status !== "delivered"));
  await f.lead("accept_task_delivery", { taskId, runId: taskId, runVersion: run.version,
    eventId: "premature", requirementEvidence: [] }, /must deliver/);
});

test("cold collaboration intake reads explicit strategy in its own instruction scope", async t => {
  const f = setup(t);
  const examples = [
    ["Use Teamwork, with Boost for every substantive assignment. Compare archive encodings at cold and warm temperatures.", "default", "substantive_tracks"],
    ["Use Teamwork to assess indoor navigation. Use a very large team of agents. Apply [/boost](slashCommand;boost) to guide each delegated contribution.", "large", "substantive_tracks"],
    ["/teamwork Measure sensor latency by adapter. Do not use a very large team and do not use /boost for every worker.", "default", "none"],
    ["/teamwork Explain the paper's discussion of a very large team and /boost. All workers should retain source references.", "default", "none"],
    ["/teamwork Use /boost for the replication track only. All workers must retain versioned inputs.", "default", "none"],
    ["/teamwork Use a large team but do not use a large team. Use Boost for every worker but never use Boost for every worker.", "default", "none"],
    ["使用 Teamwork：评估低温储存与室温储存。组建一支超大团队。每条轨道都使用 Boost。", "large", "substantive_tracks"],
    [String.raw`/teamwork 比较排班方案。需要使用大型团队；要采用[/boost]\(slashCommand;boost)辅助每项子任务。`, "large", "substantive_tracks"],
    ["/teamwork 调查日志时序。不要使用一支大型团队；禁止使用/boost来驱动每个子任务。", "default", "none"],
    ["/teamwork 文档介绍了 Boost。所有成员都应保存输入条件。", "default", "none"],
    ["/teamwork Document puzzle constraints. For every substantive assignment, apply Boost.", "default", "substantive_tracks"],
    ["/teamwork 对照不同冷却工艺，不需要使用大型团队，也不要给所有子代理使用 Boost。", "default", "none"],
    ["/teamwork Compare test stations. Keep the team small, and apply Boost to each delegated track.", "default", "substantive_tracks"],
  ];
  for (const [index, [objective, teamSize, boostScope]] of examples.entries()) {
    const opened = await f.lead("collaborate", { action: "open", cwd: f.project, eventId: "scope-" + index, objective });
    assert.equal(opened.state, "needs_plan", objective);
    assert.equal(opened.mode, "teamwork", objective);
    assert.equal(opened.plan, undefined);
    assert.equal(opened.intake.originalPrompt, objective);
    assert.equal(opened.planningBrief.originalPrompt, objective);
    assert.deepEqual(opened.intake.requestedStrategy, { teamSize, boostScope }, objective);
    assert.deepEqual(opened.planningBrief.requestedStrategy, { teamSize, boostScope }, objective);
    if (index === 2) {
      for (const [strategy, error] of [[{ teamSize: "large" }, /excludes a large team/], [{ boostScope: "substantive_tracks" }, /excludes Boost/]]) {
        await f.lead("collaborate", { action: "plan", taskId: opened.taskId, specification: { strategy } }, error);
      }
    }
    if (index === 3) {
      const planned = await f.lead("collaborate", { action: "plan", taskId: opened.taskId, specification: {
        strategy: { teamSize: "large", boostScope: "substantive_tracks" },
        milestones: [track("sources", "Inventory archive formats"), track("ownership", "Determine who maintains each reference")],
      } });
      assert.equal(planned.state, "needs_approval");
      assert.equal(planned.plan.collaboration.requestedStrategy.teamSize, "large");
      assert.equal(planned.plan.collaboration.requestedStrategy.boostScope, "substantive_tracks");
    }
  }
});
