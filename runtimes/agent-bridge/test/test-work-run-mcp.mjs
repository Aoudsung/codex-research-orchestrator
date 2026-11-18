import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BridgeDatabase } from '../src/core/bridge-db.mjs';
import { registerBridgeTools } from '../src/core/bridge-tools.mjs';
import { McpStdioServer } from '../src/core/mcp-server.mjs';
import { attestIndependentWorkRunReceipt } from '../src/domain/work-run.mjs';

function setEnvironment(t, values) {
  const saved = new Map();
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function fixture(t) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-work-run-mcp-'));
  const dbPath = path.join(project, '.agent-bridge', 'bridge.sqlite');
  fs.mkdirSync(path.dirname(dbPath));
  const connections = [];
  t.after(() => {
    for (const db of connections) {
      db.stopCrossProcessWatcher();
      db.db.close();
    }
    fs.rmSync(project, { recursive: true, force: true });
  });
  setEnvironment(t, {
    MCP_CALLER_AGENT: undefined,
    MCP_TARGET_AGENT: undefined,
    MCP_ONE_SHOT_WORKER: '1',
    BRIDGE_DISABLE_CLI_WAKEUP: '1',
    BRIDGE_DISABLE_WAKEUP_DAEMON: '1',
    RESEARCH_MEMORY_PROJECT: undefined,
  });

  function openDatabase() {
    const db = new BridgeDatabase(dbPath);
    connections.push(db);
    return db;
  }

  function connect(callerSessionId, { agent = 'codex', profile = 'lead' } = {}) {
    const db = openDatabase();
    const server = new McpStdioServer({ name: callerSessionId });
    registerBridgeTools(server, db, {
      defaultCaller: agent,
      defaultTarget: 'codex',
      callerSessionId,
      toolProfile: profile,
    });
    let nextId = 0;
    let response;
    server._send = envelope => {
      if (envelope.id !== undefined) response = envelope;
    };
    return async (tool, args, { expectError = false } = {}) => {
      const name = `bridge_${tool}`;
      const id = ++nextId;
      await server._dispatch({
        jsonrpc: '2.0', id, method: 'tools/call',
        params: { name, arguments: args },
      });
      assert.equal(response?.id, id, name);
      assert.equal(response.error, undefined, JSON.stringify(response));
      const output = JSON.parse(response.result.content[0].text);
      if (expectError) {
        assert.equal(output.ok, false, `${name}: ${JSON.stringify(output)}`);
        assert.notEqual(output.errorCode, 'INVALID_TOOL_ARGUMENTS', JSON.stringify(output));
      } else {
        assert.equal(response.result.isError, false, `${name}: ${JSON.stringify(output)}`);
        assert.notEqual(output.ok, false, `${name}: ${JSON.stringify(output)}`);
      }
      return output;
    };
  }
  return { project, connect, openDatabase };
}

async function startRun({ project, connect }, { taskId, steps, requirements, workMode = 'auto' }) {
  const lead = connect('work-lead');
  const workers = {};
  const members = [];
  const create = (args) => lead('create_task', {
    prompt: 'Verify a synthetic work run', cwd: project,
    assignedTo: 'codex', autoWakeup: false, protocolVersion: 2, ...args,
  });
  for (const memberId of new Set(steps.map(step => step.memberId))) {
    const conversationId = `work-${memberId}`;
    const memberTaskId = `${taskId}-${memberId}`;
    await create({ taskId: memberTaskId, requiredConversationId: conversationId });
    workers[memberId] = connect(conversationId, { profile: 'worker' });
    members.push({ memberId, agent: 'codex', taskId: memberTaskId, conversationId });
  }
  await create({
    taskId, workMode, requiredConversationId: 'work-lead',
    workPlan: { members, steps, requirements },
  });
  async function overview(call = lead) {
    return (await call('get_task_overview', { taskId })).workRun;
  }
  function submit(call, args, options) {
    return call('submit_task_receipt', {
      operation: 'work_step', taskId, runId: taskId, stepVersion: 1, ...args,
    }, options);
  }
  return { lead, workers, connect, overview, submit };
}

function stepIn(run, stepId) {
  return run.steps.find(step => step.stepId === stepId);
}

test('named same-channel messages stay with the bound session and are consumed once', async t => {
  const taskId = 'parallel-run';
  const { connect, lead, workers, overview, submit } = await startRun(fixture(t), {
    taskId,
    steps: [{ stepId: 'draft', memberId: 'author' }, { stepId: 'check', memberId: 'reviewer' }],
    requirements: [{ requirementId: 'trace', description: 'Provide a verified trace', stepIds: ['check'] }],
  });
  const { author, reviewer } = workers;
  const stranger = connect('unbound-codex', { profile: 'worker' });
  const initial = await overview();
  assert.equal(initial.workMode, 'parallel');
  assert.deepEqual(initial.readySteps, ['draft', 'check']);

  const directed = {
    taskId, runId: taskId, toMemberId: 'reviewer', eventId: 'send-trace',
    content: 'Private trace for the bound reviewer',
  };
  const { message } = await author('send_message', directed);
  assert.equal(message.toMemberId, 'reviewer');
  assert.equal(message.recipientTaskId, `${taskId}-reviewer`);
  const inspect = () => author('read_messages', { receiptForMessageId: message.id }).then(value => value.receipt);
  assert.equal((await inspect()).consumedAt, null);

  for (const peer of [author, stranger, lead]) {
    const inbox = await peer('read_messages', { runId: taskId });
    assert.equal(inbox.messages.some(item => item.id === message.id), false);
  }
  const genericInbox = await stranger('read_messages', { taskId: `${taskId}-reviewer` });
  assert.equal(genericInbox.messages.some(item => item.id === message.id), false);
  assert.equal((await inspect()).consumedAt, null);
  const denied = await stranger('send_message', { replyTo: message.id, eventId: 'forged-reply', content: 'Wrong session' }, { expectError: true });
  assert.match(denied.error, /unavailable/i);

  const peek = await reviewer('read_messages', { runId: taskId, markAsRead: false });
  assert.equal(peek.messages.find(item => item.id === message.id).content, directed.content);
  assert.equal((await inspect()).consumedAt, null);
  const read = await reviewer('read_messages', { runId: taskId, unreadOnly: true, consumeTurnId: 'review-turn' });
  assert.equal(read.messages.filter(item => item.id === message.id).length, 1);
  const consumed = await inspect();
  assert.equal(consumed.status, 'read');
  assert.ok(consumed.consumedAt);
  assert.equal(consumed.consumedTurnId, 'review-turn');

  const replay = (await author('send_message', directed)).message;
  assert.equal(replay.id, message.id);
  assert.equal(replay.seq, message.seq);
  assert.equal(replay.duplicate, true);
  const reconnected = connect('work-reviewer', { profile: 'worker' });
  assert.equal((await reconnected('read_messages', { runId: taskId, unreadOnly: true })).messages.length, 0);
  assert.deepEqual(await inspect(), consumed);
  assert.equal((await overview()).version, initial.version);

  const { message: reply } = await reviewer('send_message', {
    replyTo: message.id, eventId: 'reviewer-reply', content: 'Trace received and checked',
  });
  const authorInbox = await author('read_messages', { runId: taskId });
  assert.equal(authorInbox.messages.find(item => item.id === reply.id).toMemberId, 'author');

  const delivery = {
    stepId: 'check', receiptId: 'trace-check', outcome: 'delivered',
    summary: 'Checked the trace', evidenceRefs: ['artifact:trace-check'],
  };
  assert.equal((await submit(reviewer, delivery)).result.version, initial.version + 1);
  assert.equal((await submit(reviewer, delivery)).result.duplicate, true);
  assert.equal((await overview()).version, initial.version + 1);
});

test('independent evidence stays sealed, revisions reopen downstream, and acceptance needs current evidence for every requirement', async t => {
  const taskId = 'investigation-run';
  const workspace = fixture(t);
  const inputPacket = {
    entries: [
      { kind: 'definition', ref: 'definition:study', content: 'Compare two candidate explanations.' },
      { kind: 'evidence', ref: 'source:primary-trace', content: 'The control trace reports a rate of 2.' },
    ],
  };
  const { lead, workers, overview, submit } = await startRun(workspace, {
    taskId,
    workMode: 'investigate',
    steps: [
      { stepId: 'left', memberId: 'left', kind: 'independent', inputPacket },
      { stepId: 'right', memberId: 'right', kind: 'independent', inputPacket },
      { stepId: 'merge', memberId: 'synthesizer', kind: 'synthesis', dependsOn: ['left', 'right'] },
      { stepId: 'report', memberId: 'publisher', dependsOn: ['merge'] },
    ],
    requirements: [
      { requirementId: 'branches', description: 'Synthesize findings from both branches', stepIds: ['merge'] },
      { requirementId: 'report', description: 'Preserve the reviewed joint report', stepIds: ['report'] },
    ],
  });
  const { left, right, synthesizer, publisher } = workers;
  const deliver = (call, stepId, stepVersion, receiptId, summary = `Verified ${receiptId}`) => submit(call, {
    stepId, stepVersion, receiptId, summary, outcome: 'delivered', evidenceRefs: [`artifact:${receiptId}`],
  });
  const secret = 'First independent analysis reports a discriminating trace';
  const initial = await overview();
  const forgedReceipt = await submit(left, {
    stepId: 'left', receiptId: 'left-unattested', outcome: 'delivered', summary: secret,
    evidenceRefs: ['source:primary-trace'],
  }, { expectError: true });
  assert.match(forgedReceipt.error, /requires a receipt from the isolated executor/);
  assert.deepEqual(await overview(), initial);

  // The offline fixture enters at the attestation boundary used by the PI worker.
  const executor = workspace.openDatabase();
  const independentReceipt = (stepId, stepVersion, receiptId, summary = `Verified ${receiptId}`) => ({
    taskId, runId: taskId, stepId, stepVersion, receiptId, summary,
    actorAgent: 'codex', actorSessionId: `work-${stepId}`,
    packetDigest: stepIn(initial, stepId).inputPacket.digest,
    evidenceRefs: ['source:primary-trace'],
  });
  const recordIndependent = args => attestIndependentWorkRunReceipt(executor.engine, args);
  const first = independentReceipt('left', 1, 'left-v1', secret);
  assert.throws(() => recordIndependent({ ...first, packetDigest: 'wrong-digest' }), /approved independent input packet/);
  assert.equal(recordIndependent(first).accepted, true);
  for (const observer of [right, synthesizer, lead]) {
    const sealed = await overview(observer);
    assert.equal(sealed.evidenceUnlocked, false);
    assert.equal(stepIn(sealed, 'merge').status, 'waiting');
    assert.equal(stepIn(sealed, 'left').receipt.summary, undefined);
    assert.equal(stepIn(sealed, 'left').receipt.evidenceRefs, undefined);
    assert.equal(JSON.stringify(sealed).includes(secret), false);
  }
  assert.equal(recordIndependent(independentReceipt('right', 1, 'right-v1')).accepted, true);
  const released = await overview(synthesizer);
  assert.equal(released.evidenceUnlocked, true);
  assert.equal(stepIn(released, 'left').receipt.summary, secret);
  assert.deepEqual(stepIn(released, 'left').receipt.evidenceRefs, ['source:primary-trace']);
  assert.deepEqual(released.readySteps, ['merge']);

  await deliver(synthesizer, 'merge', 1, 'merge-v1');
  await deliver(publisher, 'report', 1, 'report-v1');
  const ready = await overview();
  assert.equal(ready.status, 'awaiting_acceptance');
  await submit(lead, {
    stepId: 'left', receiptId: 'revise-left', outcome: 'revise',
    summary: 'Recheck the first analysis against revised primary evidence',
    sourceRefs: ['source:updated-primary-trace'],
  });
  const revised = await overview();
  assert.deepEqual(revised.readySteps, ['left']);
  assert.deepEqual(stepIn(revised, 'right').receipt, { receiptId: 'right-v1', stepVersion: 1 });
  for (const stepId of ['left', 'merge', 'report']) {
    assert.equal(stepIn(revised, stepId).version, 2);
    assert.equal(stepIn(revised, stepId).receipt, null);
  }
  const stale = await deliver(synthesizer, 'merge', 1, 'stale-merge');
  assert.equal(stale.result.staleForTransition, true);
  assert.deepEqual(await overview(), revised);

  assert.equal(recordIndependent(independentReceipt('left', 2, 'left-v2')).accepted, true);
  assert.equal(stepIn(await overview(), 'right').receipt.summary, 'Verified right-v1');
  await deliver(synthesizer, 'merge', 2, 'merge-v2');
  await deliver(publisher, 'report', 2, 'report-v2');
  const current = await overview();
  const evidence = (requirementId, stepId, receiptId, stepVersion = 2) => ({
    requirementId, stepId, stepVersion, receiptId, evidenceRefs: [`artifact:${receiptId}`],
  });
  const mergeEvidence = evidence('branches', 'merge', 'merge-v2');
  const reportEvidence = evidence('report', 'report', 'report-v2');
  const accept = (eventId, requirementEvidence, options = {}, runVersion = current.version) =>
    lead('accept_task_delivery', { taskId, runId: taskId, eventId, runVersion, requirementEvidence }, options);
  const expectError = { expectError: true };
  const oldRun = await accept('reject-stale-run', [mergeEvidence, reportEvidence], expectError, ready.version);
  assert.match(oldRun.error, /WORK_RUN_VERSION_CONFLICT/);
  const oldEvidence = await accept('reject-stale-evidence', [evidence('branches', 'merge', 'merge-v1', 1), reportEvidence], expectError);
  assert.match(oldEvidence.error, /current step receipt/);
  const forged = await accept('reject-forged-evidence', [
    { ...mergeEvidence, evidenceRefs: ['artifact:outside-receipt'] }, reportEvidence,
  ], expectError);
  assert.match(forged.error, /evidence absent from the cited receipt/);
  const partial = await accept('reject-partial', [mergeEvidence], expectError);
  assert.match(partial.error, /missing evidence for report/);
  assert.deepEqual(await overview(), current);

  await accept('accept-all', [mergeEvidence, reportEvidence]);
  const accepted = await overview();
  assert.equal(accepted.status, 'completed');
  assert.deepEqual(accepted.acceptance.requirementEvidence, [mergeEvidence, reportEvidence].map(item => ({...item, assessment: 'supported'})));
  assert.equal((await lead('get_task_overview', { taskId })).status, 'completed');
  assert.equal((await publisher('get_task_overview', { taskId: `${taskId}-publisher` })).status, 'completed');
});

test('parallel, public challenge, and milestone runs advance independently in one project', async t => {
  const workspace = fixture(t);
  const starts = [
    ['parallel', [{ stepId: 'review', memberId: 'reviewer' }], ['draft', 'review']],
    ['investigate', [{ stepId: 'review', memberId: 'reviewer', kind: 'challenge', dependsOn: ['draft'] }], ['draft']],
    ['milestone', [{ stepId: 'review', memberId: 'reviewer', kind: 'milestone', dependsOn: ['draft'] }], ['draft']],
  ];
  const runs = new Map();
  for (const [mode, extraSteps, readySteps] of starts) {
    const run = await startRun(workspace, {
      taskId: `mixed-${mode}`, steps: [{ stepId: 'draft', memberId: 'author' }, ...extraSteps],
    });
    const overview = await run.overview();
    assert.equal(overview.requestedMode, 'auto');
    assert.equal(overview.workMode, mode);
    assert.deepEqual(overview.readySteps, readySteps);
    runs.set(mode, run);
  }
  const [parallel, investigation, milestone] = runs.values();
  const deliver = (run, member, stepId) => run.submit(run.workers[member], {
    stepId, receiptId: 'same-receipt-id', outcome: 'delivered',
    summary: 'Verified primary evidence', evidenceRefs: ['source:mixed-trace'],
  });
  await deliver(parallel, 'reviewer', 'review');
  assert.deepEqual((await parallel.overview()).readySteps, ['draft']);
  assert.deepEqual((await investigation.overview()).readySteps, ['draft']);
  assert.deepEqual((await milestone.overview()).readySteps, ['draft']);

  await deliver(investigation, 'author', 'draft');
  assert.deepEqual((await investigation.overview()).readySteps, ['review']);
  assert.deepEqual((await milestone.overview()).readySteps, ['draft']);
  await investigation.submit(investigation.workers.reviewer, {
    stepId: 'review', receiptId: 'counterexample', outcome: 'counterexample',
    counterexample: { stepId: 'draft', description: 'Counterexample contradicts the upstream claim', evidenceRefs: ['source:counterexample'] },
  });

  await deliver(milestone, 'author', 'draft');
  const challenged = await investigation.overview();
  assert.deepEqual(challenged.readySteps, ['draft']);
  assert.equal(stepIn(challenged, 'draft').version, 2);
  assert.equal(stepIn(challenged, 'draft').rejection.receiptId, 'counterexample');
  assert.equal(stepIn(await parallel.overview(), 'review').receipt.receiptId, 'same-receipt-id');
  assert.deepEqual((await milestone.overview()).readySteps, ['review']);
});

test('existing v2 task receipts and delivery acceptance survive work-run registration', async t => {
  const { project, connect, openDatabase } = fixture(t);
  const lead = connect('lead-v2');
  const owner = connect('owner-v2', { agent: 'antigravity', profile: 'worker' });
  const taskId = 'legacy-v2';
  await lead('create_task', {
    taskId, prompt: 'Deliver an independently verifiable v2 result', cwd: project,
    assignedTo: 'antigravity', requiredConversationId: 'owner-v2', autoWakeup: false,
    protocolVersion: 2, contract: { deliveryCriteria: ['Report with trace'] },
  });
  const receipt = {
    taskId, receiptId: 'v2-delivered', attemptId: 'attempt-1',
    contractVersion: 1, ownerEpoch: 1, outcome: 'delivered', summary: 'Report with trace',
  };
  // The old server persisted this shape before connection-level work-run identity existed.
  assert.equal(openDatabase().submitTaskReceipt({ ...receipt, actorAgent: 'antigravity' }).status, 'delivered');
  assert.equal((await owner('submit_task_receipt', receipt)).result.duplicate, true);

  const accepted = await lead('accept_task_delivery', {
    taskId, eventId: 'v2-accepted', contractVersion: 1, ownerEpoch: 1,
    deliveryReceiptId: receipt.receiptId, evidence: ['artifact:v2-trace'],
  });
  assert.equal(accepted.result.status, 'completed');
  assert.deepEqual((await lead('get_task_overview', { taskId })).workflow.acceptance.evidence, ['artifact:v2-trace']);
});

test('dispatch uses the 6.2 defaults and admits an explicit project model', async t => {
  const { project, connect } = fixture(t);
  const judgeModule = path.join(project, 'judge.mjs');
  fs.writeFileSync(judgeModule, [
    "export const catalogProvider = async () => ['low', 'medium', 'high'];",
    "export const judgeRunner = async ({ targetModel }) => ({ effort: 'medium', reason: 'Synthetic judgment for ' + targetModel });",
  ].join('\n'));
  setEnvironment(t, {
    AGENT_BRIDGE_ALLOW_TEST_RUNNER: '1',
    BRIDGE_TEST_JUDGE_MODULE: judgeModule,
  });
  const lead = connect('catalog-lead');
  const plan = (workload, options = {}, callOptions) => lead('plan_dispatch', {
    objective: 'Verify a synthetic collaboration contract',
    workload, cwd: project, ...options,
  }, callOptions);
  const blind = await plan('blind_review');
  assert.equal(blind.selectedModel, 'gpt-6.2-astra');
  assert.equal(blind.selectedEffort, 'medium');
  assert.equal((await plan('coupled_core_impl')).selectedModel, 'gpt-6.2-sol');

  const modelCatalog = {
    'gpt-6-astra': { channels: ['codex'], capabilities: ['blind_review'] },
    'gpt-6.2-astra': { channels: ['codex'], capabilities: ['blind_review'] },
  };
  await lead('sync_collaborators', { projectRoot: project, action: 'update', policy: { modelCatalog } });
  assert.deepEqual((await lead('sync_collaborators', { projectRoot: project, action: 'read' })).policy.modelCatalog, modelCatalog);
  assert.equal((await plan('blind_review')).selectedModel, 'gpt-6-astra');
  const explicit = await plan('blind_review', { explicitModel: 'gpt-6.2-astra', explicitEffort: 'high' });
  assert.equal(explicit.selectedModel, 'gpt-6.2-astra');
  assert.equal(explicit.selectedEffort, 'high');
  assert.equal(explicit.selectedChannel, 'codex');
  const outside = await plan('blind_review', { explicitModel: 'gpt-6.2-sol' }, { expectError: true });
  assert.match(outside.error, /outside the authorized model catalog/);
});

test('budget-limited acceptance preserves open requirements and stops pending work', async t => {
  const run = await startRun(fixture(t), {
    taskId: 'budget-stop', steps: [{stepId: 'proof', memberId: 'analyst'}],
    requirements: [{requirementId:'theorem', description:'Bound the estimator'}],
  });
  const before = await run.overview();
  const request = {taskId:'budget-stop', runId:'budget-stop', eventId:'budget-event', runVersion:before.version,
    disposition:'partial', summary:'The existing evidence does not cover the boundary.',
    openQuestions:['Does the bound hold at the endpoint?'],
    requirementEvidence:[{requirementId:'theorem', assessment:'insufficient', explanation:'No boundary argument was delivered.'}]};
  await run.lead('accept_task_delivery', request);
  const after = await run.overview();
  assert.equal(after.acceptance.disposition, 'partial');
  assert.equal(after.acceptance.requirementEvidence[0].assessment, 'insufficient');
  assert.deepEqual(after.readySteps, []);
  assert.equal((await run.lead('accept_task_delivery', request)).result.duplicate, true);
});
