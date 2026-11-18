import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BridgeDatabase } from "../src/core/bridge-db.mjs";
import { registerBridgeTools } from "../src/core/bridge-tools.mjs";
import { saveCollaboratorPolicy } from "../src/core/collaborator-registry.mjs";
import { judgeTaskEffort } from "../src/core/effort-judge.mjs";
import { McpStdioServer } from "../src/core/mcp-server.mjs";
import { isPinnedSessionInUse, preparePiExecutionSpec } from "../src/core/pi-executor.mjs";
import { evaluateSubagentReuse } from "../src/domain/dispatch-planner.mjs";
import { REASONS } from "../src/domain/model.mjs";
import {
  buildDriverWakeupPrompt,
  coalesceWakeupMessages,
  isCriticalWakeupMessage,
} from "../src/runtime/drivers.mjs";
import {
  createPiGoogleStreamWrapper,
  sdkSupportsGoogleXhigh,
  supportsGoogleGenaiContinuation,
} from "../src/runtime/pi-google-adapter.mjs";
import { resolveSafeLocalPath } from "../src/runtime/pi-worker.mjs";

function makeHarness(t) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-v130-"));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  fs.mkdirSync(path.join(project, ".agent-bridge"), { recursive: true });
  fs.mkdirSync(path.join(project, ".pi", "sessions"), { recursive: true });
  fs.writeFileSync(path.join(project, "controls.md"), "# Controls\nforbid_claude_code: true\n", "utf8");
  fs.writeFileSync(path.join(project, "colab_runner.py"), "# colab script\n", "utf8");

  const carbonPiPath = path.join(project, ".pi", "sessions", "carbon.jsonl");
  const argonPiPath = path.join(project, ".pi", "sessions", "argon.jsonl");
  fs.writeFileSync(carbonPiPath, '{"role":"assistant","message":{"role":"assistant"}}\n', "utf8");
  fs.writeFileSync(argonPiPath, '{"role":"assistant","message":{"role":"assistant"}}\n', "utf8");

  saveCollaboratorPolicy(project, {
    collaborationPolicyVersion: "2000-01-01-fixture-collab-v1",
    protocolEpoch: "fixture-protocol-v3",
    coordinatorSessionId: "00000000-0000-7000-8000-000000000001",
    channelPreferences: {
      gemini: ["pi_pinned", "antigravity_pinned"],
      gpt: ["codex"],
      openWeight: ["pi_task_explicit"],
      webPro: ["chatgpt_web_project"],
    },
    modelAliases: {
      "gemini-4-carbon": ["gemini-pro-orchestrator", "google-vertex/gemini-4-carbon"],
      "gemini-4-argon": ["gemini-pro-orchestrator-argon", "google-vertex/gemini-4-argon"],
      "kimi-3.1-pro": ["auto/kimi-k3.1-pro", "kimi-k3.1-pro"],
      "deepseek-v4.1-flash": ["auto/deepseek-v4.1-flash"],
    },
    pinnedSessions: {
      pi: {
        carbon: {
          provider: "google-vertex",
          model: "gemini-4-carbon",
          sessionId: "00000000-0000-7000-8000-000000000002",
          sessionPath: carbonPiPath,
          cwd: project,
          preserveExistingConfiguration: true,
          preserveProjectRetryAndCompactionSettings: true,
          maxConcurrentCalls: 1,
        },
        argon: {
          provider: "google-vertex",
          model: "gemini-4-argon",
          sessionId: "00000000-0000-7000-8000-000000000003",
          sessionPath: argonPiPath,
          cwd: project,
          preserveExistingConfiguration: true,
          preserveProjectRetryAndCompactionSettings: true,
          maxConcurrentCalls: 1,
        },
      },
      antigravity: {
        carbon: {
          model: "gemini-4-carbon",
          nativeModelId: "gemini-pro-orchestrator",
          conversationId: "00000000-0000-4000-8000-000000000004",
        },
        argon: {
          model: "gemini-4-argon",
          nativeModelId: "gemini-pro-orchestrator-argon",
          conversationId: "00000000-0000-4000-8000-000000000005",
        },
        colab: {
          model: "gemini-4-argon",
          nativeModelId: "gemini-pro-orchestrator-argon",
          conversationId: "00000000-0000-4000-8000-000000000006",
          dedicatedScope: "colab_fixture",
        },
      },
      webPro: {
        projectName: "Example Research Project",
        projectUrl: "https://example.com/projects/research",
      },
    },
    subagentLifecyclePolicy: {
      retireAfterTaskHandback: {
        "/root/fixture_worker": {
          boundTaskId: "fixture-deployment-task",
          sessionId: "00000000-0000-7000-8000-000000000007",
          recordedModel: "gpt-6-sol",
          recordedEffort: "medium",
        },
      },
      softSizeRotationBytes: 8 * 1024 * 1024,
    },
  });

  const dbPath = path.join(project, ".agent-bridge", "bridge.sqlite");
  const bridgeDb = new BridgeDatabase(dbPath);
  const tools = new Map();
  const fakeServer = {
    registerTool(def, handler) {
      tools.set(def.name, { def, handler });
    },
    registerResource() {},
    sendNotification() {},
  };

  const prevProj = process.env.RESEARCH_MEMORY_PROJECT;
  const prevTest = process.env.AGENT_BRIDGE_ALLOW_TEST_RUNNER;
  process.env.RESEARCH_MEMORY_PROJECT = project;
  process.env.AGENT_BRIDGE_ALLOW_TEST_RUNNER = "1";
  t.after(() => {
    bridgeDb.db.close();
    if (prevProj === undefined) delete process.env.RESEARCH_MEMORY_PROJECT;
    else process.env.RESEARCH_MEMORY_PROJECT = prevProj;
    if (prevTest === undefined) delete process.env.AGENT_BRIDGE_ALLOW_TEST_RUNNER;
    else process.env.AGENT_BRIDGE_ALLOW_TEST_RUNNER = prevTest;
  });

  registerBridgeTools(fakeServer, bridgeDb, {
    defaultCaller: "codex",
    defaultTarget: "antigravity",
    toolProfile: "lead",
  });

  const call = (name, args) => tools.get(name).handler(args);
  return { project, bridgeDb, tools, call, carbonPiPath, argonPiPath };
}

test("three-surface collaboration recovery injects into wakeup prompts and task overview", (t) => {
  const { project, bridgeDb } = makeHarness(t);

  // Create protected test host task so it shows in in-flight + retiring card
  bridgeDb.createTask({
    taskId: "fixture-deployment-task",
    fromAgent: "codex",
    assignedTo: "codex",
    title: "test host deployment",
    prompt: "Deploy the sample package on test host",
    cwd: project,
    requiredModel: "gpt-6-sol",
    boundConversationId: "00000000-0000-7000-8000-000000000007",
    metadata: { effort: "medium", role: "worker_sol", protocolEpoch: "fixture-protocol-v3" },
  });

  const overview = bridgeDb.getTaskOverview("fixture-deployment-task");
  assert.ok(overview.collaborationRecovery);
  assert.match(overview.collaborationRecovery.textBlock, /2000-01-01-fixture-collab-v1/);
  assert.match(overview.collaborationRecovery.textBlock, /fixture-protocol-v3/);
  assert.match(overview.collaborationRecovery.textBlock, /retire_after\(fixture-deployment-task\)/);

  const wakeupPrompt = buildDriverWakeupPrompt({
    route: {
      task_id: "t-sub",
      thread_id: "thr-1",
      to_agent: "codex",
      target_session_id: "00000000-0000-7000-8000-000000000001",
      driver: "codex_ipc",
    },
    claim: { messageIds: ["m1"], maxSeq: 1, messages: [] },
    task: { from_agent: "codex", assigned_to: "antigravity" },
    recoveryDigest: overview.collaborationRecovery,
  });
  assert.match(wakeupPrompt, /\[Collaboration Recovery\] policy=2000-01-01-fixture-collab-v1/);
  assert.match(wakeupPrompt, /bridge_plan_dispatch/);
});

test("bridge_plan_dispatch -> createTask(planId) enforcement, Luna effort caching & admission", async (t) => {
  const { project, bridgeDb, call } = makeHarness(t);

  let judgeCalls = 0;
  const mockCatalog = async () => ["low", "medium", "high"];
  const mockJudge = async ({ targetModel }) => {
    judgeCalls += 1;
    return { effort: "medium", reason: `Moderate proof complexity for ${targetModel}.` };
  };

  const plan = await call("bridge_plan_dispatch", {
    objective: "Audit sample convergence contract",
    workload: "math_or_efficiency_audit",
    taskKey: "fixture-contract-audit",
    cwd: project,
    _testCatalogProvider: mockCatalog,
    _testJudgeRunner: mockJudge,
  });

  assert.equal(plan.selectedAgent, "codex");
  assert.equal(plan.selectedModel, "gpt-6.2-astra");
  assert.equal(plan.selectedEffort, "medium");
  assert.equal(plan.handoffBootstrap.forkTurns, "none");
  assert.equal(judgeCalls, 1);

  // Second dispatch on same (taskKey, model) reuses task-scoped effort cache
  const plan2 = await call("bridge_plan_dispatch", {
    objective: "Audit sample convergence contract",
    workload: "math_or_efficiency_audit",
    taskKey: "fixture-contract-audit",
    cwd: project,
    _testCatalogProvider: mockCatalog,
    _testJudgeRunner: mockJudge,
  });
  assert.equal(plan2.effortCached, true);
  assert.equal(plan2.effortSource, "task_cache");
  assert.equal(judgeCalls, 1);

  // Plan mismatch rejected on wrong agent/model/effort
  await assert.rejects(
    call("bridge_create_task", {
      planId: plan.planId,
      assignedTo: "antigravity",
      prompt: "Audit convergence contract",
      cwd: project,
    }),
    (err) => err.code === REASONS.DISPATCH_PLAN_MISMATCH
  );
  await assert.rejects(
    call("bridge_create_task", {
      planId: plan.planId,
      assignedTo: "codex",
      requiredModel: "gpt-6.1-sol",
      prompt: "Audit convergence contract",
      cwd: project,
    }),
    (err) => err.code === REASONS.DISPATCH_PLAN_MISMATCH
  );
  await assert.rejects(
    call("bridge_create_task", {
      planId: plan.planId,
      assignedTo: "codex",
      effort: "high",
      prompt: "Audit convergence contract",
      cwd: project,
    }),
    (err) => err.code === REASONS.DISPATCH_PLAN_MISMATCH
  );

  // Matching createTask + claim propagates dispatchSelection & selectedEffort
  const created = await call("bridge_create_task", {
    planId: plan.planId,
    prompt: "Audit convergence contract",
    cwd: project,
    readRoots: ["controls.md"],
  });
  assert.equal(created.task.required_model, "gpt-6.2-astra");
  assert.equal(created.task.metadata.effort, "medium");
  assert.equal(created.task.metadata.protocolEpoch, "fixture-protocol-v3");

  const claimed = await call("bridge_claim_task", {
    taskId: created.task.id,
    agent: "codex",
    model: "gpt-6.2-astra",
  });
  assert.equal(claimed.selectedEffort, "medium");
  assert.equal(claimed.dispatchSelection.planId, plan.planId);

  // Pause gate rejects effort judge BEFORE calling judgeRunner
  bridgeDb.setControlState({ paused: true, reason: "maintenance" });
  await assert.rejects(
    judgeTaskEffort({
      bridgeDb,
      objective: "Paused task",
      targetModel: "gpt-6.1-sol",
      catalogProvider: mockCatalog,
      judgeRunner: async () => {
        throw new Error("Should not execute when paused");
      },
    }),
    /paused/i
  );
  bridgeDb.setControlState({ paused: false });

  // Invalid judge output fails closed without silent default fallback
  await assert.rejects(
    judgeTaskEffort({
      bridgeDb,
      objective: "Strict error check",
      taskKey: "strict-err",
      targetModel: "gpt-6.1-sol",
      catalogProvider: mockCatalog,
      judgeRunner: async () => ({ effort: "ultra", reason: "Disallowed ultra" }),
    }),
    (err) => err.code === REASONS.EFFORT_JUDGE_UNAVAILABLE
  );
});

test("Gemini PI-first fallback to pinned Antigravity, native model alias match, and Colab routing", async (t) => {
  const { project, bridgeDb, call } = makeHarness(t);
  const mockCatalog = async () => ["minimal", "low", "medium", "high"];
  const mockJudge = async () => ({ effort: "high", reason: "Panoramic design requires high thinking." });

  // Idle PI carbon -> pi_pinned selected first
  const piPlan = await call("bridge_plan_dispatch", {
    objective: "Panoramic architecture synthesis",
    workload: "panoramic_design",
    taskKey: "pan-1",
    cwd: project,
    _testCatalogProvider: mockCatalog,
    _testJudgeRunner: mockJudge,
  });
  assert.equal(piPlan.selectedChannel, "pi_pinned");
  assert.equal(piPlan.provider, "google-vertex");
  assert.equal(piPlan.targetSessionId, "00000000-0000-7000-8000-000000000002");

  // Occupy pinned PI carbon session
  const busyTask = await call("bridge_create_task", {
    planId: piPlan.planId,
    prompt: "Run first panoramic design pass",
    cwd: project,
    readRoots: ["."],
  });
  assert.ok(busyTask.ok);

  // Next panoramic design sees PI busy -> falls back to pinned Antigravity
  const agyFallbackPlan = await call("bridge_plan_dispatch", {
    objective: "Second concurrent panoramic review",
    workload: "panoramic_design",
    taskKey: "pan-2",
    cwd: project,
    _testCatalogProvider: mockCatalog,
    _testJudgeRunner: mockJudge,
  });
  assert.equal(agyFallbackPlan.selectedChannel, "antigravity");
  assert.equal(agyFallbackPlan.piBusyFallbackApplied, true);
  assert.equal(agyFallbackPlan.targetSessionId, "00000000-0000-4000-8000-000000000004");

  // Antigravity native model alias 'gemini-pro-orchestrator' satisfies 'gemini-4-carbon'
  const agyTask = await call("bridge_create_task", {
    planId: agyFallbackPlan.planId,
    prompt: "Execute via fallback Antigravity",
    cwd: project,
    readRoots: ["."],
  });
  const bound = bridgeDb.verifyAndBindTask({
    taskId: agyTask.task.id,
    actualModel: "gemini-pro-orchestrator",
    conversationId: "00000000-0000-4000-8000-000000000004",
    modelSource: "runtime_init_metadata",
  });
  assert.equal(bound.actual_model, "gemini-pro-orchestrator");

  // Colab writeRoot routes to dedicated Colab Antigravity session
  const colabPlan = await call("bridge_plan_dispatch", {
    objective: "Sync Colab sample script",
    workload: "coupled_core_impl",
    writeRoots: ["colab_runner.py"],
    taskKey: "colab-1",
    cwd: project,
    _testCatalogProvider: mockCatalog,
    _testJudgeRunner: mockJudge,
  });
  assert.equal(colabPlan.selectedChannel, "antigravity");
  assert.equal(colabPlan.targetSessionId, "00000000-0000-4000-8000-000000000006");
});

test("subagent retirement policy blocks reusing retiring test host author on new tasks and flags >8 MiB JSONL", (t) => {
  const { project, bridgeDb } = makeHarness(t);
  const policy = bridgeDb.getCollaboratorPolicy(project);

  const reuse = evaluateSubagentReuse({
    candidateSubagents: [
      {
        agentPath: "/root/fixture_worker",
        sessionId: "00000000-0000-7000-8000-000000000007",
        model: "gpt-6-sol",
        effort: "medium",
        role: "worker_sol",
        protocolEpoch: "fixture-protocol-v3",
      },
    ],
    selectedAgent: "codex",
    selectedRole: "worker_sol",
    selectedModel: "gpt-6-sol",
    selectedEffort: "medium",
    isolationProfile: "shared",
    policy,
  });
  assert.equal(reuse.reuseAllowed, false);
  assert.equal(reuse.action, "spawn_new");
  assert.match(reuse.reason, /retiring_after_task\(fixture-deployment-task\)/);

  const blind = evaluateSubagentReuse({
    candidateSubagents: [
      { agentPath: "/root/fixture_reviewer", model: "gpt-6-astra", effort: "high", role: "reviewer" },
    ],
    selectedAgent: "codex",
    selectedRole: "reviewer",
    selectedModel: "gpt-6-astra",
    selectedEffort: "high",
    isolationProfile: "blind_review",
    policy,
  });
  assert.equal(blind.action, "spawn_new");
  assert.equal(blind.reuseAllowed, false);

  const bigSub = evaluateSubagentReuse({
    candidateSubagents: [
      {
        agentPath: "/root/fixture_fresh_worker",
        sessionId: "fresh-sol-uuid",
        model: "gpt-6-sol",
        effort: "medium",
        role: "worker_sol",
        protocolEpoch: "fixture-protocol-v3",
        jsonlBytes: 9 * 1024 * 1024,
      },
    ],
    selectedAgent: "codex",
    selectedRole: "worker_sol",
    selectedModel: "gpt-6-sol",
    selectedEffort: "medium",
    isolationProfile: "shared",
    policy,
  });
  assert.equal(bigSub.reuseAllowed, true);
  assert.equal(bigSub.rotationAdvisory?.shouldRotate, true);
});

test("detached dual-mode pi_exec preserves pinned settings vs task_explicit overrides & rejects dyschop", async (t) => {
  const { project, call } = makeHarness(t);
  const mockRunner = path.join(project, "mock-pi-runner.mjs");
  fs.writeFileSync(
    mockRunner,
    `export async function runMockPiTask(spec) {
      return {
        actualProvider: spec.provider,
        actualModel: spec.model,
        actualEffort: spec.effort || "medium",
        sessionId: spec.sessionId || ("mock-pi-" + spec.taskId),
        sessionPath: spec.sessionPath || (spec.runDir + "/session.jsonl"),
        appliedOverrides: spec.preserveExistingConfiguration ? null : { retry: { maxRetries: spec.retries }, compaction: { enabled: spec.compaction } },
        response: "complete\\nmock pi finished",
      };
    }\n`,
    "utf8"
  );

  // Task-explicit open-weight worker uses retries=0, compaction=false
  const explicitRes = await call("pi_exec", {
    prompt: "Extract log metrics into summary",
    sessionMode: "task_explicit",
    provider: "magpie",
    model: "auto/deepseek-v4.1-flash",
    effort: "low",
    cwd: project,
    readRoots: ["controls.md"],
    _testRunnerModule: mockRunner,
  });
  assert.equal(explicitRes.ok, true);
  assert.equal(explicitRes.receipt.transportOutcome, "delivered");
  assert.equal(explicitRes.receipt.preserveExistingConfiguration, false);
  assert.deepEqual(explicitRes.receipt.appliedOverrides, {
    retry: { maxRetries: 0 },
    compaction: { enabled: false },
  });

  // Pinned Gemini worker preserves user retry/compaction configuration
  const pinnedRes = await call("pi_exec", {
    prompt: "Continue pinned carbon synthesis",
    sessionMode: "pinned",
    provider: "google-vertex",
    model: "gemini-4-carbon",
    effort: "high",
    cwd: project,
    readRoots: ["controls.md"],
    _testRunnerModule: mockRunner,
  });
  assert.equal(pinnedRes.ok, true);
  assert.equal(pinnedRes.receipt.preserveExistingConfiguration, true);
  assert.equal(pinnedRes.receipt.preserveProjectRetryAndCompactionSettings, true);
  assert.equal(pinnedRes.receipt.appliedOverrides, null);

  // Dyschop is always rejected
  await assert.rejects(
    call("pi_exec", {
      prompt: "Forbidden dyschop call",
      provider: "dyschop",
      model: "dyschop/kimi-k2",
      cwd: project,
      _testRunnerModule: mockRunner,
    }),
    /dyschop/i
  );

  // isPinnedSessionInUse detects live lockfile / unanswered turn
  const lockBusy = isPinnedSessionInUse({
    projectRoot: project,
    sessionId: "00000000-0000-7000-8000-000000000002",
    sessionPath: path.join(project, ".pi", "sessions", "carbon.jsonl"),
    requiredModel: "gemini-4-carbon",
    activeTasks: [
      {
        id: "live-pi-1",
        status: "in_progress",
        bound_conversation_id: "00000000-0000-7000-8000-000000000002",
        required_model: "gemini-4-carbon",
        metadata: { channel: "pi_pinned", executor: "pi" },
      },
    ],
  });
  assert.equal(lockBusy.busy, true);
});

test("selective wakeup coalescing preserves failures/deliveries and emits tools/list_changed on schema drift", async () => {
  const msgs = [
    { id: "m1", seq: 1, subject: "progress tick 1", metadata: { outcome: "progress" } },
    { id: "m2", seq: 2, subject: "progress tick 2", metadata: { outcome: "progress" } },
    { id: "m3", seq: 3, subject: "Task delivery ready", metadata: { outcome: "delivered" } },
    { id: "m4", seq: 4, subject: "heartbeat tick 3", metadata: { outcome: "progress" } },
    { id: "m5", seq: 5, subject: "Control revision", metadata: { controlVersion: "v2" } },
  ];
  assert.equal(isCriticalWakeupMessage(msgs[0]), false);
  assert.equal(isCriticalWakeupMessage(msgs[2]), true);
  assert.equal(isCriticalWakeupMessage(msgs[4]), true);

  const coalesced = coalesceWakeupMessages(msgs);
  assert.equal(coalesced.foldedProgressCount, 2);
  assert.deepEqual(
    coalesced.kept.map((m) => m.id),
    ["m3", "m4", "m5"]
  );

  // Verify McpStdioServer detects schema signature change and emits notifications/tools/list_changed
  const server = new McpStdioServer({ name: "test-mcp", version: "1.3.0" });
  const sent = [];
  server._send = (obj) => sent.push(obj);
  server.registerTool(
    { name: "tool_a", description: "a", inputSchema: { type: "object", properties: {} } },
    () => ({ ok: true })
  );
  await server._dispatch({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
  await server._dispatch({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  assert.equal(sent.some((m) => m.method === "notifications/tools/list_changed"), false);

  server.registerTool(
    { name: "tool_b", description: "b", inputSchema: { type: "object", properties: {} } },
    () => ({ ok: true })
  );
  await server._dispatch({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
  const notifIdx = sent.findIndex((m) => m.method === "notifications/tools/list_changed");
  const respIdx = sent.findIndex((m) => m.id === 3);
  assert.ok(notifIdx >= 0 && respIdx > notifIdx, "notifications/tools/list_changed must precede updated tools/list response");
});

test("resolveSafeLocalPath accepts in-project absolute roots/paths and rejects escapes", (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-path-"));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));

  fs.mkdirSync(path.join(project, "src", "sample"), { recursive: true });
  fs.writeFileSync(path.join(project, "controls.md"), "# Controls\n", "utf8");
  fs.writeFileSync(path.join(project, "src", "sample", "engine.py"), "# engine\n", "utf8");
  const outsideFile = path.join(outside, "secret.txt");
  fs.writeFileSync(outsideFile, "secret\n", "utf8");

  const realProject = fs.realpathSync(project);
  const absControls = path.join(project, "controls.md");
  const absEngine = path.join(realProject, "src", "sample", "engine.py");

  assert.equal(
    resolveSafeLocalPath(project, "controls.md", [project]),
    fs.realpathSync(absControls)
  );
  assert.equal(
    resolveSafeLocalPath(project, absControls, [project]),
    fs.realpathSync(absControls)
  );
  assert.equal(
    resolveSafeLocalPath(project, absEngine, [path.join(project, "src")]),
    fs.realpathSync(absEngine)
  );

  assert.throws(
    () => resolveSafeLocalPath(project, outsideFile, [project]),
    /escapes project root/i
  );
  assert.throws(
    () => resolveSafeLocalPath(project, "../secret.txt", ["."]),
    /Path traversal/i
  );
  assert.throws(
    () => resolveSafeLocalPath(project, "controls.md", [outside]),
    /outside/i
  );
});

test("explicitPiRoutes (Hydrogen fixedEffort=xhigh) flow through dispatch -> intake -> preparePiExecutionSpec", async (t) => {
  const { project, bridgeDb, call } = makeHarness(t);

  await call("bridge_sync_collaborators", {
    action: "update",
    projectRoot: project,
    policy: {
      explicitPiRoutes: [
        {
          provider: "google-vertex",
          model: "gemini-4-hydrogen",
          fixedEffort: "xhigh",
        },
      ],
    },
  });

  const plan = await call("bridge_plan_dispatch", {
    objective: "Implement sample analysis package",
    workload: "coupled_core_impl",
    explicitModel: "google-vertex/gemini-4-hydrogen",
    taskKey: "hydrogen-fixture-impl",
    cwd: project,
  });
  assert.equal(plan.selectedChannel, "pi_task_explicit");
  assert.equal(plan.provider, "google-vertex");
  assert.equal(plan.selectedModel, "gemini-4-hydrogen");
  assert.equal(plan.sessionMode, "task_explicit");
  assert.equal(plan.selectedEffort, "xhigh");
  assert.equal(plan.effortSource, "fixed_model");

  const created = await call("bridge_create_task", {
    planId: plan.planId,
    prompt: "Implement sample package incrementally",
    cwd: project,
    readRoots: [project],
    writeRoots: ["."],
  });
  assert.equal(created.task.required_model, "gemini-4-hydrogen");
  assert.equal(created.task.metadata.sessionMode, "task_explicit");
  assert.equal(created.task.metadata.provider, "google-vertex");
  assert.equal(created.task.metadata.effort, "xhigh");

  const { spec } = preparePiExecutionSpec({
    bridgeDb,
    projectRoot: project,
    task: created.task,
    prompt: created.task.prompt,
    contextFiles: [path.join(project, "controls.md")],
  });
  assert.equal(spec.provider, "google-vertex");
  assert.equal(spec.model, "gemini-4-hydrogen");
  assert.equal(spec.effort, "xhigh");
  assert.equal(spec.sessionMode, "task_explicit");
  assert.equal(spec.maxLengthContinuations, 2);
});

test("pi_exec handles length auto-continuation, partial output_limit, and pre-transport vs upstream error classification", async (t) => {
  const { project, bridgeDb, call } = makeHarness(t);

  // Case 1: Initial turn hits length, single auto-continuation completes cleanly.
  const continueRunner = path.join(project, "mock-length-then-complete.mjs");
  fs.writeFileSync(
    continueRunner,
    `export async function runMockPiTask() {
      return {
        actualProvider: "google-vertex",
        actualModel: "gemini-4-hydrogen",
        actualEffort: "xhigh",
        turns: [
          { stopReason: "length", response: "", usage: { output: 65536, reasoning: 65533 } },
          { stopReason: "stop", response: "complete\\nApplied incremental edits.", usage: { output: 420 } },
        ],
      };
    }\n`,
    "utf8"
  );
  await call("bridge_sync_collaborators", {
    action: "update",
    projectRoot: project,
    policy: {
      explicitPiRoutes: [
        { provider: "google-vertex", model: "gemini-4-hydrogen", fixedEffort: "xhigh" },
      ],
    },
  });

  const contRes = await call("pi_exec", {
    prompt: "Apply package edits incrementally",
    model: "gemini-4-hydrogen",
    cwd: project,
    readRoots: [project],
    contextFiles: [path.join(project, "controls.md")],
    maxLengthContinuations: 2,
    _testRunnerModule: continueRunner,
  });
  assert.equal(contRes.ok, true);
  assert.equal(contRes.status, "complete");
  assert.equal(contRes.receipt.invocationOutcome, "complete");
  assert.equal(contRes.receipt.lengthContinuationsUsed, 1);
  assert.equal(contRes.receipt.transportOutcome, "delivered");
  assert.equal(contRes.authorizationReuse.reusableTaskAuthorization, true);
  const evLines = fs.readFileSync(path.join(contRes.receiptPath, "..", "events.jsonl"), "utf8");
  assert.match(evLines, /"type":"length_continuation"/);

  // Case 2: Workflow task exhausts length continuations -> partial/output_limit + workflow progress (not blocked).
  const exhaustRunner = path.join(project, "mock-length-exhausted.mjs");
  fs.writeFileSync(
    exhaustRunner,
    `export async function runMockPiTask() {
      return {
        actualProvider: "google-vertex",
        actualModel: "gemini-4-hydrogen",
        actualEffort: "xhigh",
        turns: [
          { stopReason: "length", response: "", usage: { output: 65536, reasoning: 65533 } },
          { stopReason: "length", response: "", usage: { output: 65536, reasoning: 65530 } },
        ],
      };
    }\n`,
    "utf8"
  );

  const wfPlan = await call("bridge_plan_dispatch", {
    objective: "Hydrogen large package task",
    workload: "coupled_core_impl",
    explicitModel: "google-vertex/gemini-4-hydrogen",
    cwd: project,
  });
  const wfTaskRes = await call("bridge_create_task", {
    planId: wfPlan.planId,
    prompt: "Run Hydrogen workflow task",
    cwd: project,
    readRoots: [project],
    writeRoots: ["."],
  });
  const partialRes = await call("pi_exec", {
    taskId: wfTaskRes.task.id,
    maxLengthContinuations: 1,
    _testRunnerModule: exhaustRunner,
  });
  assert.equal(partialRes.ok, true);
  assert.equal(partialRes.status, "partial");
  assert.equal(partialRes.receipt.invocationOutcome, "partial");
  assert.equal(partialRes.receipt.partialReason, "output_limit");
  assert.equal(partialRes.receipt.lengthContinuationsUsed, 1);
  assert.equal(partialRes.receipt.transportOutcome, "delivered");
  assert.equal(partialRes.authorizationReuse.reusableTaskAuthorization, true);
  assert.equal(partialRes.authorizationReuse.classification, "output_limit_partial");
  const updatedWfTask = bridgeDb.getTaskById(wfTaskRes.task.id);
  assert.notEqual(updatedWfTask.phase, "blocked");
  assert.equal(updatedWfTask.phase, "in_progress");

  // Case 3: Pre-transport local error sets reusableTaskAuthorization=true; upstream error sets false.
  const preTransportRunner = path.join(project, "mock-pre-transport-err.mjs");
  fs.writeFileSync(
    preTransportRunner,
    `export async function runMockPiTask() {
      return {
        actualProvider: "google-vertex",
        actualModel: "gemini-4-hydrogen",
        beforeGenerationTransport: true,
        stopReason: "error",
        errorMessage: "Unsupported Google thinking level mapping for google-vertex/gemini-4-hydrogen: xhigh -> xhigh",
      };
    }\n`,
    "utf8"
  );
  const preErrRes = await call("pi_exec", {
    prompt: "Pre-transport adapter error test",
    model: "gemini-4-hydrogen",
    cwd: project,
    readRoots: [project],
    _testRunnerModule: preTransportRunner,
  });
  assert.equal(preErrRes.ok, false);
  assert.equal(preErrRes.status, "error");
  assert.equal(preErrRes.receipt.invocation.failure.beforeGenerationTransport, true);
  assert.equal(preErrRes.authorizationReuse.reusableTaskAuthorization, true);
  assert.equal(preErrRes.authorizationReuse.classification, "local_pre_transport_error");

  const upstreamErrRunner = path.join(project, "mock-upstream-err.mjs");
  fs.writeFileSync(
    upstreamErrRunner,
    `export async function runMockPiTask() {
      return {
        actualProvider: "google-vertex",
        actualModel: "gemini-4-hydrogen",
        upstreamRequestAttempted: true,
        lastResponseStatus: 503,
        stopReason: "error",
        errorMessage: "Vertex backend returned HTTP 503",
      };
    }\n`,
    "utf8"
  );
  const upErrRes = await call("pi_exec", {
    prompt: "Upstream HTTP error test",
    model: "gemini-4-hydrogen",
    cwd: project,
    readRoots: [project],
    _testRunnerModule: upstreamErrRunner,
  });
  assert.equal(upErrRes.ok, false);
  assert.equal(upErrRes.receipt.invocation.failure.beforeGenerationTransport, false);
  assert.equal(upErrRes.authorizationReuse.reusableTaskAuthorization, false);
  assert.equal(upErrRes.authorizationReuse.classification, "upstream_or_runtime_failure");
});

test("pi-google-adapter semver checks and self-contained Google Vertex fallbacks work without patching ~/.pi", async (t) => {
  assert.equal(supportsGoogleGenaiContinuation("2.21.0"), false);
  assert.equal(supportsGoogleGenaiContinuation("2.29.1"), true);
  assert.equal(supportsGoogleGenaiContinuation("2.32.0"), true);
  assert.equal(sdkSupportsGoogleXhigh({ toGoogleSdkThinkingLevel: (l) => (l === "HIGH" ? "HIGH" : undefined) }), false);
  assert.equal(sdkSupportsGoogleXhigh({ toGoogleSdkThinkingLevel: (l) => l }), true);

  // Test Case C: non-hydrogen google-vertex model with xhigh on unpatched SDK forces thinkingLevel=XHIGH in onPayload.
  let seenOptions = null;
  let seenParams = null;
  const origFn = async (_model, _ctx, opts) => {
    seenOptions = opts;
    seenParams = await opts.onPayload({ model: "gemini-4-carbon", config: {} }, { id: "gemini-4-carbon" });
    return { done: true };
  };
  const wrapper = createPiGoogleStreamWrapper({
    originalStreamFunction: origFn,
    googleSharedMod: { toGoogleSdkThinkingLevel: (l) => (l === "XHIGH" ? undefined : l) },
    googleGenaiVersion: "2.32.0",
  });
  await wrapper({ provider: "google-vertex", id: "gemini-4-carbon" }, { messages: [] }, { reasoning: "xhigh" });
  assert.equal(seenOptions.reasoning, "high");
  assert.equal(seenParams.config.thinkingConfig.thinkingLevel, "XHIGH");

  // Test Case B: self-contained unary Hydrogen fallback using a minimal fake SDK root (no network).
  const fakeSdkRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fake-pi-sdk-"));
  t.after(() => fs.rmSync(fakeSdkRoot, { recursive: true, force: true }));
  const writeMod = (rel, body) => {
    const p = path.join(fakeSdkRoot, "node_modules", rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body, "utf8");
  };
  writeMod(
    "@google/genai/dist/node/index.mjs",
    `export const ResourceScope = { COLLECTION: "COLLECTION" };
     export class GoogleGenAI {
       constructor(cfg) { this.cfg = cfg; }
       models = {
         async countTokens() { return { totalTokens: 120000 }; },
         async generateContent(params) {
           return {
             responseId: "resp-1",
             candidates: [{
               finishReason: "STOP",
               content: { parts: [{ thought: true, text: "plan" }, { text: "complete\\nDone." }] },
             }],
             usageMetadata: { promptTokenCount: 120000, candidatesTokenCount: 10, thoughtsTokenCount: 5, totalTokenCount: 120015 },
           };
         },
       };
     }`
  );
  writeMod(
    "@earendil-works/pi-ai/dist/utils/event-stream.js",
    `export class AssistantMessageEventStream {
       constructor() { this.events = []; }
       push(e) { this.events.push(e); }
       end() { this.ended = true; }
     }`
  );
  writeMod(
    "@earendil-works/pi-ai/dist/utils/transcript.js",
    `export const collapseSystemMessages = (c) => c;
     export const getCurrentTools = () => [];
     export const getInitialSystemMessage = () => null;`
  );
  writeMod("@earendil-works/pi-ai/dist/utils/text.js", `export const getSystemMessageText = () => "";`);
  writeMod("@earendil-works/pi-ai/dist/utils/sanitize-unicode.js", `export const sanitizeSurrogates = (s) => s;`);
  writeMod("@earendil-works/pi-ai/dist/utils/headers.js", `export const providerHeadersToRecord = (...a) => Object.assign({}, ...a.filter(Boolean));`);
  writeMod("@earendil-works/pi-ai/dist/utils/identity.js", `export const getIdentityHeaders = () => ({});`);
  writeMod("@earendil-works/pi-ai/dist/utils/error-body.js", `export const normalizeProviderError = (e) => e; export const formatProviderError = (e) => String(e?.message || e);`);
  writeMod("@earendil-works/pi-ai/dist/models.js", `export const calculateCost = () => {}; export const clampThinkingLevel = (_, l) => l;`);
  writeMod(
    "@earendil-works/pi-ai/dist/api/google-shared.js",
    `export const convertMessages = () => [{ role: "user", parts: [{ text: "hi" }] }];
     export const convertTools = () => [];
     export const isThinkingPart = (p) => p.thought === true;
     export const mapStopReason = (r) => (r === "STOP" ? "stop" : "error");
     export const resolveGoogleFunctionCallingMode = () => undefined;
     export const retainThoughtSignature = (a, b) => b || a;
     export const supportsGoogleStrictToolSampling = () => false;`
  );

  const settingsObserved = [];
  const fakeRuntime = {
    async getAuth() {
      return { auth: { apiKey: "test-api-key" }, env: {} };
    },
  };
  const hWrapper = createPiGoogleStreamWrapper({
    sdkRoot: fakeSdkRoot,
    runtime: fakeRuntime,
    originalStreamFunction: () => {
      throw new Error("Should not use originalStreamFunction when bridgeHydrogenLongDecodeProtocol is absent");
    },
    googleVertexMod: {},
    googleGenaiVersion: "2.32.0",
    onGenerationSettings: (s) => settingsObserved.push(s),
  });
  const stream = hWrapper(
    { provider: "google-vertex", id: "gemini-4-hydrogen", baseUrl: "" },
    { messages: [] },
    { reasoning: "xhigh" }
  );
  const finalMsg = await stream.result();
  assert.equal(finalMsg.stopReason, "stop");
  assert.equal(settingsObserved.length, 1);
  assert.equal(settingsObserved[0].protocol, "bridge-self-contained-unary-v1");
  assert.equal(settingsObserved[0].maxOutputTokens, 1048576 - 120000);
  const doneEv = stream.events.find((e) => e.type === "done");
  assert.ok(doneEv, "self-contained Hydrogen stream must emit done event");
  assert.equal(doneEv.reason, "stop");
});
