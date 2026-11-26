import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { BridgeDatabase } from "../src/core/bridge-db.mjs";
import { registerBridgeTools } from "../src/core/bridge-tools.mjs";
import { McpStdioServer } from "../src/core/mcp-server.mjs";

function workspace(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "work-board-mcp-"));
  const filename = path.join(cwd, "bridge.sqlite");
  const databases = [];
  const env = { MCP_CALLER_AGENT: undefined, MCP_TARGET_AGENT: undefined, MCP_ONE_SHOT_WORKER: "1",
    BRIDGE_DISABLE_CLI_WAKEUP: "1", BRIDGE_DISABLE_WAKEUP_DAEMON: "1", RESEARCH_MEMORY_PROJECT: undefined };
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const db of databases) {
      db.stopCrossProcessWatcher();
      db.db.close();
    }
    fs.rmSync(cwd, { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  return {
    cwd,
    connect(callerSessionId, profile = "worker", defaultCaller = "codex") {
      const db = new BridgeDatabase(filename);
      databases.push(db);
      const server = new McpStdioServer({ name: callerSessionId });
      registerBridgeTools(server, db, { defaultCaller, callerSessionId, toolProfile: profile });
      const responses = new Map();
      const notifications = [];
      let nextId = 0;
      server._send = envelope => {
        if (envelope.id !== undefined) responses.set(envelope.id, envelope);
        else notifications.push(envelope);
      };
      const call = async (tool, args, expectError = false) => {
        const id = ++nextId;
        await server._dispatch({ jsonrpc: "2.0", id, method: "tools/call",
          params: { name: `bridge_${tool}`, arguments: args } });
        const response = responses.get(id);
        responses.delete(id);
        assert.ok(response && !response.error, JSON.stringify(response));
        const output = JSON.parse(response.result.content[0].text);
        assert.equal(Boolean(response.result.isError), expectError, JSON.stringify(output));
        assert.notEqual(output.errorCode, "INVALID_TOOL_ARGUMENTS", JSON.stringify(output));
        return output;
      };
      return { call, db, notifications };
    },
  };
}

const board = (peer, taskId, action, options = {}, error = false) => peer.call("work_board", { taskId, runId: taskId, action, ...options }, error);
const receipt = (peer, taskId, stepId, stepVersion = 1, extra = {}, error = false) => peer.call("submit_task_receipt", {
  operation: "work_step", taskId, runId: taskId, stepId, stepVersion, receiptId: `${stepId}-v${stepVersion}`,
  outcome: "delivered", summary: `Verified ${stepId}`, evidenceRefs: [`artifact:${stepId}-v${stepVersion}`], ...extra,
}, error);

function createTask(peer, cwd, taskId, requiredConversationId, extra = {}) {
  return peer.call("create_task", { taskId, cwd, prompt: `Scoped assignment ${taskId}`, protocolVersion: 2,
    assignedTo: "codex", requiredConversationId, autoWakeup: false, ...extra });
}

test("the board wakes only the named peer and restores history from a second SQLite connection", async t => {
  const { cwd, connect } = workspace(t);
  const lead = connect("lead", "lead");
  const author = connect("author");
  const reviewer = connect("reviewer");
  const stranger = connect("unbound", "lead");
  const taskId = "shared-board";
  for (const memberId of ["author", "reviewer"]) await createTask(lead, cwd, memberId, memberId);
  await createTask(lead, cwd, taskId, "lead", { workMode: "milestone", workPlan: {
    members: ["author", "reviewer"].map(memberId => ({ memberId, agent: "codex", taskId: memberId, conversationId: memberId })),
    steps: [{ stepId: "write", memberId: "author" }, { stepId: "check", memberId: "reviewer", dependsOn: ["write"] }],
  } });
  assert.match((await board(stranger, taskId, "status", {}, true)).error, /unavailable/i);
  await board(lead, taskId, "create_channel", { eventId: "channel", channel: "validation" });
  await board(lead, taskId, "subscribe", { eventId: "join", channel: "validation", memberId: "author" });
  await board(author, taskId, "post", { eventId: "quiet", channel: "validation", text: "Scoped board note" });
  assert.match((await board(reviewer, taskId, "read", { channel: "validation" }, true)).error, /unavailable/i);
  const page = await board(reviewer, taskId, "read", {});
  assert.ok(page.entries.every(entry => entry.text !== "Scoped board note"));
  const cursor = page.nextSince;
  const targetWait = board(reviewer, taskId, "wait", { since: cursor, waitMs: 1500 });
  const leadWait = board(lead, taskId, "wait", { since: cursor, waitMs: 100 });
  const post = { eventId: "target", channel: "validation", text: "Reproduce the trace", toMemberIds: ["reviewer"] };
  const result = await board(author, taskId, "post", post);
  assert.equal((await targetWait).entries.at(-1).seq, result.seq);
  assert.equal((await leadWait).timedOut, true);
  assert.equal((await board(author, taskId, "post", post)).duplicate, true);
  assert.match((await board(author, taskId, "post", { ...post, text: "Changed retry" }, true)).error, /TASK_EVENT_CONFLICT/);

  const reader = connect("reviewer");
  const restored = await board(reader, taskId, "read", { since: cursor });
  assert.deepEqual(restored.entries.map(entry => entry.text), [post.text]);
  assert.equal(restored.nextSince, result.seq);
  const originalInbox = await reviewer.call("read_messages", { runId: taskId, markAsRead: false });
  const notices = originalInbox.messages.filter(message => message.metadata?.boardSeq === result.seq);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].toMemberId, "reviewer");
  const strangerInbox = await stranger.call("read_messages", { runId: taskId, markAsRead: false });
  assert.equal(strangerInbox.messages.length, 0);
  for (let i = 0; i < 20 && !reviewer.notifications.some(item => item.params?.data?.messageId === notices[0].id); i++) await delay(30);
  assert.ok(reviewer.notifications.some(item => item.params?.data?.messageId === notices[0].id));
  assert.ok(!stranger.notifications.some(item => item.params?.data?.messageId === notices[0].id));
  const generic = await stranger.call("get_task_overview", { taskId });
  assert.ok(!JSON.stringify(generic).includes(post.text));
});

test("dynamic tracks preserve their dependency history and transfer pending lead notices to the successor", async t => {
  const { cwd, connect } = workspace(t);
  const lead = connect("lead", "lead");
  const draft = connect("draft");
  const reviewer = connect("reviewer", "lead");
  const helper = connect("helper");
  const taskId = "lifecycle";
  for (const id of ["draft", "reviewer", "helper"]) await createTask(lead, cwd, id, id);
  await createTask(lead, cwd, taskId, "lead", { workMode: "parallel", workPlan: {
    members: ["draft", "reviewer"].map(memberId => ({ memberId, agent: "codex", taskId: memberId, conversationId: memberId })),
    steps: [{ stepId: "draft", memberId: "draft" }, { stepId: "review", memberId: "reviewer" }],
  } });
  const member = { memberId: "helper", agent: "codex", conversationId: "helper", taskId: "helper" };
  const addMember = { eventId: "add-helper", runVersion: 1, member };
  assert.match((await board(lead, taskId, "add_member", { ...addMember, eventId: "forged", member: { ...member, conversationId: "wrong" } }, true)).error, /exact session/);
  const result = await board(lead, taskId, "add_member", addMember);
  const track = { stepId: "third", memberId: "helper", dependsOn: ["draft", "review"], brief: "Integrate both delivered parts" };
  const options = { eventId: "add-third", runVersion: result.version, track };
  const replay = await Promise.all([board(lead, taskId, "add_track", options), board(lead, taskId, "add_track", options)]);
  assert.equal(replay.filter(item => item.duplicate).length, 1);
  assert.match((await board(lead, taskId, "retire_member", { eventId: "stale", runVersion: 2, memberId: "helper" }, true)).error, /VERSION_CONFLICT/);
  assert.equal((await receipt(draft, taskId, "draft")).result.version, 4);
  assert.deepEqual((await board(lead, taskId, "status")).run.readySteps, ["review"]);
  assert.equal((await receipt(reviewer, taskId, "review")).result.version, 5);
  assert.deepEqual((await board(helper, taskId, "status")).run.readySteps, ["third"]);
  const reassign = await board(lead, taskId, "reassign_track", { eventId: "move", runVersion: 5,
    stepId: "third", stepVersion: 1, memberId: "reviewer" });
  assert.equal(reassign.version, 6);
  assert.match((await receipt(helper, taskId, "third", 1, {}, true)).error, /does not own/);
  assert.equal((await receipt(reviewer, taskId, "third", 1)).result.staleForTransition, true);
  const retired = await board(lead, taskId, "retire_member", { eventId: "retire-helper", runVersion: 6, memberId: "helper" });
  assert.equal(retired.version, 7);
  assert.match((await board(helper, taskId, "status", {}, true)).error, /unavailable/i);
  const privateMessage = await draft.call("send_message", { taskId, runId: taskId, eventId: "lead-private",
    toMemberId: "@coordinator", content: "For the original lead only" });
  const pending = await board(draft, taskId, "post", { eventId: "lead-handoff", text: "Decision needed on integrated part",
    toMemberIds: ["@coordinator"] });
  const handoff = { eventId: "change-lead", runVersion: 7, memberId: "reviewer", conversationId: "reviewer" };
  assert.equal((await board(lead, taskId, "handoff_lead", handoff)).version, 8);
  assert.equal((await board(lead, taskId, "handoff_lead", handoff)).duplicate, true);
  assert.match((await board(lead, taskId, "status", {}, true)).error, /unavailable/i);
  const state = await board(reviewer, taskId, "status");
  assert.equal(state.isLead, true);
  assert.equal(state.run.steps.find(step => step.stepId === "draft").receipt.receiptId, "draft-v1");
  const newInbox = (await reviewer.call("read_messages", { runId: taskId, unreadOnly: true, markAsRead: false })).messages;
  assert.ok(newInbox.some(message => message.metadata?.boardSeq === pending.seq));
  assert.ok(!newInbox.some(message => message.id === privateMessage.message.id));
  await receipt(reviewer, taskId, "third", 2);
  const evidence = [{ requirementId: "delivery", stepId: "third", stepVersion: 2, receiptId: "third-v2", evidenceRefs: ["artifact:third-v2"] }];
  await lead.call("accept_task_delivery", { taskId, runId: taskId, eventId: "wrong-acceptor", runVersion: 9,
    requirementEvidence: evidence }, true);
  const accepted = await reviewer.call("accept_task_delivery", { taskId, runId: taskId, eventId: "accepted", runVersion: 9,
    requirementEvidence: evidence });
  assert.equal(accepted.result.status, "completed");
});

test("Boost binds workers in waves, gates dynamic tracks on retest and checks current matched evidence", async t => {
  const { cwd, connect } = workspace(t);
  const lead = connect("lead", "lead");
  const author = connect("author");
  const reviewer = connect("reviewer");
  const taskId = "lazy-boost";
  await createTask(lead, cwd, taskId, "lead", { prompt: "/boost Investigate variance. Use fair comparisons of the candidate and baseline." });
  const comparisonProtocol = { purpose: "design", dimensions: { dataset: ["active"] }, matchFields: ["budget"] };
  await createTask(lead, cwd, "candidate-task", "author");
  await author.call("claim_task", { taskId: "candidate-task", collaborationTaskId: taskId });
  const started = await lead.call("collaborate", { taskId, eventId: "start", action: "start", specification: { comparisonProtocol },
    bindings: { candidate: { taskId: "candidate-task" } } });
  const [{ reviewStepId }] = started.run.collaboration.boostPairs;
  const { finalStepId } = started.run.collaboration;
  assert.deepEqual(started.run.readySteps, ["candidate"]);
  assert.equal(started.nextAction.resumeTargets[0].reason, "no_route");
  assert.equal(started.run.steps.find(step => step.stepId === reviewStepId).taskId, null);
  assert.match((await receipt(reviewer, taskId, reviewStepId, 1, {}, true)).error, /does not own/);
  await receipt(author, taskId, "candidate");
  const updated = await board(lead, taskId, "status");
  assert.deepEqual(updated.run.readySteps, []);
  assert.deepEqual(updated.run.bindingNeededSteps, [reviewStepId]);
  assert.equal(updated.run.status, "active");
  const need = await board(lead, taskId, "wait", { since: 0, waitMs: 0 });
  assert.ok(need.entries.some(entry => entry.type === "binding_needed" && entry.stepId === reviewStepId));

  await createTask(lead, cwd, "review-task", "reviewer");
  const reviewerMemberId = updated.run.steps.find(step => step.stepId === reviewStepId).memberId;
  const bind = { action: "bind", taskId, memberId: reviewerMemberId, memberTaskId: "review-task", runVersion: updated.run.version };
  const unauthenticated = await lead.call("collaborate", { ...bind, eventId: "guess-binding" }, true);
  assert.match(unauthenticated.error, /bootstrap|attest/i);
  await reviewer.call("claim_task", { taskId: "review-task", collaborationTaskId: taskId });
  const bound = await lead.call("collaborate", { ...bind, eventId: "bind-challenger" });
  assert.deepEqual(bound.run.readySteps, [reviewStepId]);
  const inbox = await reviewer.call("read_messages", { runId: taskId, markAsRead: false });
  assert.equal(inbox.messages.filter(message => message.metadata?.stepId === reviewStepId).length, 1);
  await receipt(reviewer, taskId, reviewStepId);
  let state = (await board(lead, taskId, "status")).run;
  assert.deepEqual(state.readySteps, [finalStepId]);

  const track = { stepId: "replicate", memberId: "candidate", description: "Replicate the decisive comparison",
    dependsOn: [reviewStepId] };
  const incomplete = await board(lead, taskId, "add_track", { eventId: "no-check", runVersion: state.version, track }, true);
  assert.match(incomplete.error, /reviewer binding/i);
  const added = await board(lead, taskId, "add_track", { eventId: "with-check", runVersion: state.version,
    track: { ...track, boost: { reviewerMemberId } } });
  const [, retest] = added.addedStepIds;
  state = (await board(lead, taskId, "status")).run;
  assert.deepEqual(state.readySteps, [track.stepId]);
  assert.ok(state.steps.find(step => step.stepId === finalStepId).dependsOn.includes(retest));
  await receipt(author, taskId, track.stepId);
  const challenge = await receipt(reviewer, taskId, retest, 1, { receiptId: "mismatched-budget", outcome: "counterexample",
    counterexample: { stepId: track.stepId, description: "The two arms used different budgets", evidenceRefs: ["artifact:budget-mismatch"] } });
  assert.deepEqual(challenge.result.readySteps, [track.stepId]);
  await receipt(author, taskId, track.stepId, 2);
  await receipt(reviewer, taskId, retest, 2);
  state = (await board(lead, taskId, "status")).run;
  const finalVersion = state.steps.find(step => step.stepId === finalStepId).version;
  await receipt(lead, taskId, finalStepId, finalVersion);
  const accept = async (eventId, error = false) => {
    const current = (await board(lead, taskId, "status")).run;
    const audit = current.steps.find(step => step.stepId === finalStepId);
    return lead.call("accept_task_delivery", { taskId, runId: taskId, eventId, runVersion: current.version,
      requirementEvidence: current.requirements.map(item => ({ requirementId: item.requirementId, stepId: finalStepId,
        stepVersion: audit.version, receiptId: audit.receipt.receiptId, evidenceRefs: audit.receipt.evidenceRefs })) }, error);
  };
  assert.match((await accept("unverified", true)).error, /comparisonEvidence/i);
  await receipt(lead, taskId, finalStepId, finalVersion, { receiptId: "reopen-fair-audit", outcome: "revise",
    summary: "Attach the matched evidence matrix", sourceRefs: ["artifact:reviewed-grid"] });
  const planned = { settings: { budget: 5 }, evidenceRefs: ["artifact:reviewed-grid"] };
  await receipt(lead, taskId, finalStepId, finalVersion + 1, { evidenceRefs: planned.evidenceRefs,
    comparisonEvidence: { scope: "listed", cells: [{ at: { dataset: "active" }, status: "planned", candidate: planned, baseline: planned }] } });
  assert.equal((await accept("verified")).result.status, "completed");
  state = (await board(lead, taskId, "status")).run;
  assert.equal(state.acceptance.comparisons.counts.planned, 1);
});

test("a parallel blueprint queues extra roles until an execution slot becomes available", async t => {
  const { cwd, connect } = workspace(t);
  const lead = connect("lead", "lead");
  const first = connect("first");
  const taskId = "one-slot-swarm";
  await createTask(lead, cwd, taskId, "lead", { prompt: "/swarm Inspect three independent report sections" });
  const tracks = ["data", "methods", "claims"].map(id => ({ id, title: `Review ${id}`, objective: `Inspect ${id}`,
    deliverable: `Evidence for ${id}`, acceptance: `Cite source and reproduction for ${id}` }));
  const started = await lead.call("collaborate", { taskId, eventId: "swarm-start", action: "start", specification: { tracks, maxParallel: 1 } });
  assert.deepEqual(started.run.bindingNeededSteps, ["track-data"]);
  assert.deepEqual(started.run.queuedSteps, ["track-methods", "track-claims"]);
  const stage = started.run.steps.find(step => step.stepId === "track-data");
  await createTask(lead, cwd, "data-task", "first");
  await first.call("claim_task", { taskId: "data-task", collaborationTaskId: taskId });
  const bound = await lead.call("collaborate", { taskId, action: "bind", eventId: "bind-data", runVersion: started.run.version,
    memberId: stage.memberId, memberTaskId: "data-task" });
  assert.deepEqual(bound.run.readySteps, [stage.stepId]);
  assert.deepEqual(bound.run.bindingNeededSteps, []);
  const delivered = await receipt(first, taskId, stage.stepId);
  assert.deepEqual(delivered.result.bindingNeededSteps, ["track-methods"]);
  assert.deepEqual(delivered.result.queuedSteps, ["track-claims"]);
  assert.equal(delivered.result.status, "active");
});

test("isolated branches cannot read or publish to the shared board while evidence is sealed", async t => {
  const { cwd, connect } = workspace(t);
  const lead = connect("lead", "lead");
  const independent = connect("left");
  const taskId = "sealed-board";
  const ids = ["left", "right", "synthesis"];
  for (const id of ids) await createTask(lead, cwd, id, id);
  const packet = { entries: [
    { kind: "definition", ref: "definition:approved", content: "Reproduce the reported effect." },
    { kind: "evidence", ref: "artifact:approved", content: "Use the approved observations." },
  ] };
  await createTask(lead, cwd, taskId, "lead", { workMode: "investigate", workPlan: {
    members: ids.map(memberId => ({ memberId, agent: "codex", taskId: memberId, conversationId: memberId })),
    steps: [
      ...["left", "right"].map(stepId => ({ stepId, memberId: stepId, kind: "independent", inputPacket: packet })),
      { stepId: "synthesis", memberId: "synthesis", kind: "synthesis", dependsOn: ["left", "right"] },
    ],
  } });
  assert.match((await board(independent, taskId, "status", {}, true)).error, /unavailable/i);
  assert.match((await board(independent, taskId, "post", { eventId: "leak", text: "Premature result" }, true)).error, /unavailable/i);
  assert.match((await board(lead, taskId, "read", {}, true)).error, /unlocked/i);
  const other = connect("synthesis");
  const overview = await other.call("get_task_overview", { taskId });
  assert.equal(overview.workRun.steps.find(step => step.stepId === "left").inputPacket, undefined);
});

test("authorized exact wakeup reports host acceptance, inbox consumption, pause and native warm-worker repair separately", async t => {
  const { cwd, connect } = workspace(t);
  const lead = connect("wake-lead", "lead");
  const author = connect("wake-author");
  const reviewer = connect("wake-reviewer");
  for (const peer of [lead, author, reviewer]) {
    peer.db._scheduleWakeupForMessage = () => {};
    peer.db.engine.isWakeupGuarded = () => false;
  }
  const opening = { action: "open", eventId: "opt-in-root", objective: "/boost Explain the change in a trace",
    cwd, autoWakeup: true, wakeupDriver: "host_poll" };
  const opened = await lead.call("collaborate", opening);
  const taskId = opened.taskId;
  assert.equal(opened.wakeupRoute.target_session_id, "wake-lead");
  assert.equal((await lead.call("collaborate", opening)).taskId, taskId);
  await createTask(lead, cwd, "opt-in-author", "wake-author");
  await createTask(lead, cwd, "blocked-reviewer", "wake-reviewer");
  const rejected = await reviewer.call("claim_task", { taskId: "opt-in-author", collaborationTaskId: taskId,
    autoWakeup: true, wakeupDriver: "host_poll" }, true);
  assert.match(rejected.error, /host session/i);
  const authorRequest = { taskId: "opt-in-author", collaborationTaskId: taskId, autoWakeup: true, wakeupDriver: "host_poll" };
  const firstClaim = await author.call("claim_task", authorRequest);
  const duplicateClaim = await author.call("claim_task", authorRequest);
  assert.equal(firstClaim.wakeupRoute.target_session_id, "wake-author");
  assert.deepEqual(duplicateClaim.wakeupRoute, firstClaim.wakeupRoute);
  await lead.call("configure_wakeup_route", { taskId: "blocked-reviewer", toAgent: "codex", targetSessionId: "prior-unrelated-session",
    driver: "manual", enabled: true });
  const reviewerClaim = await reviewer.call("claim_task", { ...authorRequest, taskId: "blocked-reviewer" });
  assert.equal(reviewerClaim.wakeupRoute, undefined);
  assert.equal(lead.db.getWakeupRoute("blocked-reviewer", "codex").target_session_id, "prior-unrelated-session");
  const status = () => lead.call("collaborate", { action: "resume", taskId });
  const started = await lead.call("collaborate", { action: "start", eventId: "start", taskId,
    bindings: { candidate: { taskId: "opt-in-author" } } });
  assert.equal(started.nextAction.readySteps[0].handoff.state, "queued");
  assert.equal(started.nextAction.readySteps[0].handoff.sessionId, "wake-author");
  const transport = lead.db.engine.claimPendingWakeup("opt-in-author", { toAgent: "codex" });
  assert.equal(transport.claimed, true);
  assert.equal(transport.messages[0].content, "Read the message from the bound session.");
  assert.equal((await status()).nextAction.readySteps[0].handoff.state, "dispatching");
  lead.db.engine.completeWakeupDelivery("opt-in-author", transport.messageIds, { toAgent: "codex", delivered: true,
    receipt: { accepted: true, targetSessionId: "wake-author", turnId: "controlled-test-host-turn" } });
  assert.equal((await status()).nextAction.readySteps[0].handoff.state, "host_accepted");
  const consumed = await author.call("read_messages", { runId: taskId, consumeTurnId: "controlled-test-host-turn", unreadOnly: true });
  assert.equal(consumed.messages[0].metadata.stepVersion, 1);
  assert.equal((await status()).nextAction.readySteps[0].handoff.state, "consumed");

  await receipt(author, taskId, "candidate");
  const state = await status();
  const { reviewStepId } = state.run.collaboration.boostPairs[0];
  const reviewerMemberId = state.run.steps.find(step => step.stepId === reviewStepId).memberId;
  const bound = await lead.call("collaborate", { taskId, action: "bind", eventId: "bind-review", runVersion: state.run.version,
    memberId: reviewerMemberId, memberTaskId: "blocked-reviewer", autoWakeup: true, wakeupDriver: "host_poll" });
  assert.equal(bound.nextAction.action, "resume_bound_workers");
  assert.equal(bound.nextAction.resumeTargets[0].reason, "route_session_mismatch");
  assert.equal(bound.nextAction.resumeTargets[0].sessionId, "wake-reviewer");
  await author.call("claim_task", { taskId: "opt-in-author", collaborationTaskId: taskId, autoWakeup: false });
  lead.db.engine.setControlState({ paused: true });
  await receipt(reviewer, taskId, reviewStepId, 1, { receiptId: "challenge-wake", outcome: "counterexample",
    counterexample: { stepId: "candidate", description: "Reproduce the trace under the revised control", evidenceRefs: ["trace:revised"] } });
  assert.equal((await status()).nextAction.action, "wait_for_unpause");
  lead.db.engine.setControlState({ paused: false });
  const warm = (await status()).nextAction;
  assert.equal(warm.action, "resume_bound_workers");
  const [target] = warm.resumeTargets;
  assert.deepEqual([target.taskId, target.sessionId, target.stepId, target.stepVersion, target.reason],
    ["opt-in-author", "wake-author", "candidate", 2, "wakeup_disabled"]);
  const repairedInbox = await author.call("read_messages", { runId: taskId, unreadOnly: true });
  assert.equal(repairedInbox.messages.length, 1);
  assert.equal(repairedInbox.messages[0].metadata.stepVersion, 2);
  assert.equal((await status()).nextAction.readySteps[0].handoff.state, "consumed");
  await receipt(author, taskId, "candidate", 2);
  assert.equal((await status()).nextAction.resumeTargets[0].stepVersion, 2);
});
