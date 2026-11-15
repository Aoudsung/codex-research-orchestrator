import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeEngine } from '../src/domain/engine.mjs';
import { MemoryRepositories } from '../src/domain/memory-repos.mjs';
import fs from 'node:fs';
import { McpStdioServer } from '../src/core/mcp-server.mjs';

function fixture({ owner = 'codex', source = 'executor', target = 'lead', lead = 'lead', coordinationOnly = false, staleOwner = false, guarded = false } = {}) {
  const repos = new MemoryRepositories();
  const engine = new BridgeEngine({ repos, isWakeupGuarded: () => guarded });
  engine.createTask({ taskId: 'handoff', fromAgent: 'codex', assignedTo: owner,
    prompt: 'Deliver the authorized result', protocolVersion: 2,
    boundConversationId: staleOwner ? null : source, metadata: { leadThreadId: lead, coordinationOnly } });
  if (staleOwner) {
    engine.claimTask({ taskId: 'handoff', agent: owner, conversationId: source });
    assert.equal(repos.getTask('handoff').metadata.workflow.owner.conversationId, null);
  }
  engine.configureWakeupRoute({ taskId: 'handoff', toAgent: 'codex', targetSessionId: target, driver: 'manual' });
  const receipt = (receiptId, outcome = 'delivered', extra = {}) => engine.submitTaskReceipt({
    taskId: 'handoff', actorAgent: owner, receiptId, attemptId: 'execution', contractVersion: 1,
    ownerEpoch: 1, outcome, summary: 'Same artifacts, new business receipt', artifacts: [], ...extra });
  const messages = () => repos.queryMessages({ taskId: 'handoff', toAgent: 'codex', limit: 100 });
  return { engine, repos, receipt, messages };
}

test('same Codex, distinct sessions: each receipt emits one pending event; replay is idempotent', () => {
  const f = fixture();
  f.receipt('r1');
  assert.equal(f.receipt('r1').duplicate, true);
  f.receipt('r2');
  assert.equal(f.messages().length, 2);
  assert.deepEqual(new Set(f.messages().map(m => m.metadata.deliveryReceiptId)), new Set(['r1', 'r2']));
  for (const m of f.messages()) {
    assert.equal(m.wakeup_status, 'pending');
    assert.equal(m.wakeup_target_session, 'lead');
    assert.equal(m.processed_at, null);
    assert.equal(m.status, 'unread');
  }
  assert.throws(() => f.receipt('r2', 'delivered', { summary: 'changed' }), /TASK_EVENT_CONFLICT/);
  f.engine.acceptTaskDelivery({ taskId: 'handoff', actorAgent: 'codex', eventId: 'accepted',
    contractVersion: 1, ownerEpoch: 1, deliveryReceiptId: 'r2', evidence: ['regression'] });
  assert.equal(f.messages().length, 2, 'lead acceptance must not wake itself');
});

test('old claims use bound_conversation_id when workflow owner session is null', () => {
  const f = fixture({ staleOwner: true });
  f.receipt('r1');
  assert.equal(f.messages().length, 1);
  assert.equal(f.messages()[0].wakeup_status, 'pending');
});

test('same session, lead-owned, coordinationOnly and unknown source never self-notify', () => {
  for (const options of [{ source: 'lead' }, { target: 'executor' }, { coordinationOnly: true },
    { coordinationOnly: true, source: 'lead', target: 'stale-other' }, { source: null }]) {
    const f = fixture(options);
    f.receipt('r1');
    assert.equal(f.messages().length, 0, JSON.stringify(options));
    assert.equal(f.repos.listEffects().filter(e => e.kind === 'wakeup').length, 0);
  }
});

test('blocked and decision notices respect session identity and existing policy', () => {
  for (const outcome of ['blocked', 'waiting_user']) {
    const extra = outcome === 'waiting_user' ? { decision: { id: 'choice', question: 'Select next step' } } : {};
    for (const source of ['executor', 'lead']) {
      const f = fixture({ source });
      f.receipt('r1', outcome, extra);
      f.receipt('r1', outcome, extra);
      assert.equal(f.messages().length, source === 'lead' ? 0 : 1);
      if (source === 'executor') assert.equal(f.messages()[0].wakeup_status, 'pending');
    }
  }
});

test('cross-provider behavior and wakeup guard remain intact', () => {
  const cross = fixture({ owner: 'antigravity' });
  cross.receipt('r1');
  cross.receipt('r1');
  assert.equal(cross.messages().length, 1);
  assert.equal(cross.messages()[0].wakeup_status, 'pending');
  cross.engine.acceptTaskDelivery({ taskId: 'handoff', actorAgent: 'codex', eventId: 'accepted',
    contractVersion: 1, ownerEpoch: 1, deliveryReceiptId: 'r1', evidence: ['regression'] });
  assert.equal(cross.messages().length, 2);
  const guarded = fixture({ guarded: true });
  guarded.receipt('r1');
  assert.equal(guarded.messages()[0].wakeup_status, 'skipped_wakeup_guard');
});

test('ordinary self-routing stays rejected and allowSelfSend alone cannot wake a session', () => {
  const f = fixture();
  const args = { taskId: 'handoff', fromAgent: 'codex', toAgent: 'codex', content: 'ordinary message' };
  assert.throws(() => f.engine.sendMessage(args), /Self-routing blocked/);
  assert.equal(f.engine.sendMessage({ ...args, allowSelfSend: true }).wakeup_status, 'none');
  assert.equal(f.engine.sendMessage({ ...args, allowSelfSend: true, metadata: {
    protocolVersion: 2, workflowNotification: { sourceSessionId: 'forged', targetSessionId: 'lead' }
  } }).wakeup_status, 'none');
});

test('decision answers never self-wake the lead or use a lead route to resume the executor', () => {
  for (const options of [{ source: 'lead' }, { coordinationOnly: true }, {}]) {
    const f = fixture(options);
    f.receipt('r1', 'waiting_user', { decision: { id: 'choice', question: 'Select next step' } });
    const before = f.repos.listEffects().length;
    f.engine.answerTaskDecision({ taskId: 'handoff', actorAgent: 'codex', eventId: 'answer',
      decisionId: 'choice', answer: 'continue' });
    assert.equal(f.repos.listEffects().length, before);
    assert.equal(f.messages().find(m => m.subject === 'Task decision answered').wakeup_status, 'none');
  }
  const f = fixture({ target: 'executor' });
  f.receipt('r1', 'waiting_user', { decision: { id: 'choice', question: 'Select next step' } });
  f.engine.answerTaskDecision({ taskId: 'handoff', actorAgent: 'codex', eventId: 'answer',
    decisionId: 'choice', answer: 'continue' });
  assert.equal(f.repos.listEffects().filter(e => e.kind === 'wakeup').length, 1);
});

test('an already connected MCP server delegates calls after a domain-only edit', async () => {
  const server = new McpStdioServer({ name: 'hot-reload-regression' });
  const file = new URL('../src/domain/task-workflow.mjs', import.meta.url);
  const stat = fs.statSync(file);
  let delegated = 0;
  const sent = [];
  server._delegateToFreshWorker = async msg => { delegated++; return { id: msg.id, result: { fresh: true } }; };
  server._send = msg => sent.push(msg);
  try {
    const changed = new Date(server.bootMtimeMs + 5000);
    fs.utimesSync(file, stat.atime, changed);
    await server._dispatch({ id: 1, method: 'tools/call', params: { name: 'probe' } });
    assert.equal(delegated, 1);
    assert.equal(sent[0].result.fresh, true);
  } finally {
    fs.utimesSync(file, stat.atime, stat.mtime);
  }
});
