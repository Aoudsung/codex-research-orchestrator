import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BridgeDatabase, resolveBridgeDbPath } from '../src/core/bridge-db.mjs';
import { runTaskPreflight, verifyModelMatch } from '../src/core/preflight.mjs';
import { runCommand } from '../src/core/process-runner.mjs';
import { checkPathWithinRoots, validateUnifiedDiff } from '../src/core/patch-validator.mjs';

// These tests use synthetic providers and host receipts, not live Desktop evidence.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bridge-test-'));
const clients = [];
const db = new BridgeDatabase(path.join(tmp, 'shared.sqlite'));
const diff = 'diff --git a/output/file.txt b/output/file.txt\n--- a/output/file.txt\n+++ b/output/file.txt\n@@ -1 +1 @@\n-old\n+new\n';
fs.mkdirSync(path.join(tmp, 'output'));
fs.writeFileSync(path.join(tmp, 'output/file.txt'), 'old\n');

class Client {
  constructor(name, env, serverRoot = root) {
    this.nextId = 0;
    this.pending = new Map();
    this.buffer = '';
    this.stderr = '';
    this.proc = spawn(process.execPath, [path.join(serverRoot, 'src/servers', `${name}-mcp.mjs`)], {
      cwd: tmp,
      env: { ...process.env, HOME: tmp, AGENT_BRIDGE_DB: db.dbPath, MCP_CALLER_AGENT: 'codex',
        CODEX_BIN: path.join(tmp, 'missing-codex'), CLAUDE_BIN: path.join(tmp, 'missing-claude'), AGY_BIN: path.join(tmp, 'missing-agy'),
        BRIDGE_DISABLE_CLI_WAKEUP: '1', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stderr.on('data', b => { this.stderr += b; });
    this.proc.stdout.on('data', b => {
      this.buffer += b;
      let end;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
      }
    });
    this.proc.on('exit', code => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(`Server exited ${code}: ${this.stderr}`)); }
      this.pending.clear();
    });
    clients.push(this);
  }
  request(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP timeout: ${method}`)); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async call(name, args = {}, allowError = false) {
    const result = await this.request('tools/call', { name, arguments: args });
    const data = JSON.parse(result.content[0].text);
    if (!allowError) assert.ok(!result.isError && data.ok !== false, `${name}: ${JSON.stringify(data)}`);
    return data;
  }
  async close() {
    if (this.proc.exitCode !== null) return;
    const exited = new Promise(resolve => this.proc.once('exit', resolve));
    this.proc.kill(); await exited;
  }
}

async function main() {
  assert.equal(db.listTasks().length, 0);
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM wakeup_routes').get().n, 0);
  const savedDb = process.env.AGENT_BRIDGE_DB;
  delete process.env.AGENT_BRIDGE_DB;
  assert.throws(resolveBridgeDbPath, /AGENT_BRIDGE_DB/);
  if (savedDb !== undefined) process.env.AGENT_BRIDGE_DB = savedDb;
  // An allocated cursor cannot become visible before its event commits.
  const heldWriter = path.join(tmp, 'held-writer.mjs');
  const signal = path.join(tmp, 'allocated');
  fs.writeFileSync(heldWriter, `import fs from 'node:fs';
import { BridgeDatabase } from ${JSON.stringify(new URL('../src/core/bridge-db.mjs', import.meta.url).href)};
const db = new BridgeDatabase(process.argv[2]);
const allocate = db.nextSeq.bind(db);
db.nextSeq = () => { const value = allocate(); fs.writeFileSync(process.argv[3], 'ready'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); return value; };
db.sendMessage({fromAgent:'claude-code',toAgent:'codex',taskId:'concurrent',content:'held'});
db.db.close();
`);
  const beforeHeld = db.getCurrentSeq();
  const held = runCommand({ command: process.execPath, args: [heldWriter, db.dbPath, signal], timeoutMs: 5000 });
  for (let i = 0; !fs.existsSync(signal) && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(fs.existsSync(signal), true);
  assert.equal(db.getCurrentSeq(), beforeHeld);
  assert.equal(db.readMessages({ taskId: 'concurrent', toAgent: 'codex', markAsRead: false }).length, 0);
  const competing = await codexFreeWriter();
  assert.equal((await held).ok, true);
  assert.equal(competing.ok, true);
  const concurrent = db.readMessages({ taskId: 'concurrent', toAgent: 'codex', markAsRead: false, limit: 200 });
  assert.equal(concurrent.length, 31);
  assert.equal(new Set(concurrent.map(message => message.seq)).size, 31);
  assert.equal(concurrent.find(message => message.content === 'held').seq, Math.min(...concurrent.map(message => message.seq)));
  const rollbackCursor = db.getCurrentSeq();
  const allocate = db.nextSeq.bind(db);
  db.nextSeq = () => { allocate(); throw new Error('Synthetic failed event'); };
  assert.throws(() => db.sendMessage({ fromAgent: 'claude-code', toAgent: 'codex', content: 'not committed' }), /Synthetic/);
  db.nextSeq = allocate;
  assert.equal(db.getCurrentSeq(), rollbackCursor);

  async function codexFreeWriter() {
    return runCommand({ command: process.execPath, args: ['--input-type=module', '-e', `
      import { BridgeDatabase } from ${JSON.stringify(new URL('../src/core/bridge-db.mjs', import.meta.url).href)};
      const db = new BridgeDatabase(${JSON.stringify(db.dbPath)});
      for (let i=0;i<30;i++) db.sendMessage({fromAgent:'antigravity',toAgent:'codex',taskId:'concurrent',content:'parallel-'+i});
      db.db.close();`], timeoutMs: 5000 });
  }
  assert.equal(checkPathWithinRoots('output/file.txt', []).allowed, false);
  assert.equal(checkPathWithinRoots('../escape', ['.']).allowed, false);
  for (const file of ['a/output/file.txt', 'b/output/file.txt', ' output/file.txt', 'output\\outside.txt', 'dev/null']) {
    assert.equal(checkPathWithinRoots(file, ['output']).allowed, false);
  }
  const doublePrefix = diff.replaceAll('a/output/file.txt', 'a/a/output/file.txt').replaceAll('b/output/file.txt', 'b/a/output/file.txt');
  assert.equal(validateUnifiedDiff(doublePrefix, { writeRoots: ['output'] }).pathScopeValid, false);
  const rename = '\ndiff --git a/secret.txt b/output/secret.txt\nsimilarity index 100%\nrename from secret.txt\nrename to output/secret.txt\n';
  assert.equal(validateUnifiedDiff(diff + rename, { writeRoots: ['output'] }).pathScopeValid, false);
  assert.equal(validateUnifiedDiff(diff, { writeRoots: ['output'] }).valid, true);
  assert.equal(validateUnifiedDiff(diff, { writeRoots: [] }).pathScopeValid, false);
  assert.equal(validateUnifiedDiff('@@ -0,0 +1 @@\n+orphan\n', { writeRoots: ['output'] }).pathScopeValid, false);
  const earlyExit = await runCommand({ command: '/bin/sh', args: ['-c', 'exit 0'], stdinText: 'x'.repeat(4 * 1024 * 1024), timeoutMs: 5000 });
  assert.equal(earlyExit.exitCode, 0);
  assert.equal(earlyExit.ok, false);
  assert.ok(earlyExit.stdinError);
  assert.match(earlyExit.error, /Input delivery failed/);
  assert.equal(runTaskPreflight({ runtime: 'agy-cli', cwd: tmp, permissions: { requestedTools: ['write_file'] } }).ok, false);
  assert.equal(runTaskPreflight({ runtime: 'codex-cli', cwd: tmp, permissions: { writeRoots: ['missing/parent/output'] } }).ok, false);
  assert.equal(runTaskPreflight({ runtime: 'codex-cli', cwd: tmp, permissions: { readRoots: ['missing'] } }).ok, false);
  const patchPreflight = runTaskPreflight({ runtime: 'agy-cli', cwd: tmp, deliveryMode: 'mcp_structured_patch', permissions: { writeRoots: ['missing/parent/output'] } });
  assert.equal(patchPreflight.ok, true);
  assert.equal(patchPreflight.authorityGranted, false);
  assert.equal(runTaskPreflight({ runtime: 'unknown', cwd: tmp }).ok, false);
  assert.equal(runTaskPreflight({ runtime: 'codex-cli', cwd: tmp, deliveryMode: 'read_only', permissions: { writeRoots: ['output'] } }).ok, false);

  const bindingTask = db.createTask({ taskId: 'binding-task', fromAgent: 'codex', assignedTo: 'antigravity', prompt: 'Synthetic task', cwd: tmp, requiredModel: 'synthetic-model', requiredConversationId: 'synthetic-session', permissions: { writeRoots: ['output'] } });
  assert.throws(() => db.createTask({ taskId: bindingTask.id, requiredModel: 'other-model' }), /conflicts/);
  assert.throws(() => db.createTask({ taskId: bindingTask.id, permissions: { writeRoots: [] } }), /conflicts/);
  assert.equal(db.createTask({ taskId: bindingTask.id, prompt: 'Follow-up' }).prompt, 'Synthetic task');
  assert.throws(() => db.verifyAndBindTask({ taskId: bindingTask.id, actualModel: 'synthetic-model' }), /Conversation/);
  assert.throws(() => db.verifyAndBindTask({ taskId: bindingTask.id, actualModel: 'wrong', conversationId: 'synthetic-session' }), /Model mismatch/);
  const declared = db.verifyAndBindTask({ taskId: bindingTask.id, actualModel: 'synthetic-model', conversationId: 'synthetic-session', modelSource: 'cli_flag' });
  assert.equal(declared.binding.actualModel, null);
  assert.equal(declared.binding.modelEvidence, 'unverified');
  const reported = db.verifyAndBindTask({ taskId: bindingTask.id, actualModel: 'synthetic-model', conversationId: 'synthetic-session', modelSource: 'runtime_init_metadata' });
  assert.equal(reported.binding.actualModel, 'synthetic-model');
  assert.equal(reported.binding.modelEvidence, 'runtime_reported');
  db.createTask({ taskId: 'verified-task', fromAgent: 'codex', assignedTo: 'claude-code', prompt: 'Require evidence', requiredModel: 'synthetic-model', metadata: { requireVerifiedModel: true } });
  assert.throws(() => db.verifyAndBindTask({ taskId: 'verified-task', actualModel: 'synthetic-model', modelSource: 'cli_flag' }), /evidence/);
  db.verifyAndBindTask({ taskId: 'verified-task', actualModel: 'synthetic-model', conversationId: 'verified-session', modelSource: 'runtime_init_metadata' });
  assert.equal(db.completeTask({ taskId: 'verified-task', status: 'completed', model: 'synthetic-model', sessionId: 'verified-session' }).status, 'completed');
  assert.equal(verifyModelMatch('model-a', 'model-b').ok, false);

  const patchArgs = { taskId: bindingTask.id, fromAgent: 'antigravity', model: 'synthetic-model', conversationId: 'synthetic-session', rawContent: diff };
  assert.throws(() => db.submitPatch({ ...patchArgs, patchId: 'missing-dep', dependsOn: ['absent'] }), /prerequisite/);
  assert.throws(() => db.submitPatch({ ...patchArgs, patchId: 'cycle', dependsOn: ['cycle'] }), /cycle/);
  assert.throws(() => db.submitPatch({ ...patchArgs, patchId: 'replacement', supersedes: 'absent' }), /Replacement/);
  db.submitPatch({ ...patchArgs, patchId: 'patch-1' });
  assert.throws(() => db.submitPatch({ ...patchArgs, patchId: 'patch-1', rawContent: 'changed' }), /immutable/);
  db.submitPatch({ ...patchArgs, patchId: 'patch-2', supersedes: 'patch-1' });
  assert.deepEqual(db.listPatches({ taskId: bindingTask.id }).activeApplyOrder, ['patch-2']);
  assert.equal(db.getPatch('patch-1').rawContent, diff);
  assert.throws(() => db.submitPatch({ ...patchArgs, patchId: 'stale-dep', dependsOn: ['patch-1'] }), /prerequisite/);
  assert.throws(() => db._computePatchApplyOrder([{ patchId: 'a', dependsOn: ['b'] }, { patchId: 'b', dependsOn: ['a'] }]), /cycle/);

  db.configureWakeupRoute({ taskId: bindingTask.id, toAgent: 'codex', targetSessionId: 'synthetic-host-session', driver: 'manual' });
  const hostMessage = db.sendMessage({ taskId: bindingTask.id, fromAgent: 'antigravity', toAgent: 'codex', content: 'Host contract mock' });
  for (const receipt of [{ turnId: 'mock-turn' }, { accepted: true }, { accepted: true, turnId: 'mock-turn', targetSessionId: 'wrong' }]) {
    assert.equal(db.confirmWakeupDelivery({ taskId: bindingTask.id, messageIds: [hostMessage.id], receipt }).confirmed, false);
  }
  assert.throws(() => db.completeWakeupDelivery(bindingTask.id, [hostMessage.id], { delivered: true }), /Host acceptance/);
  const receipt = { accepted: true, turnId: 'mock-turn', targetSessionId: 'synthetic-host-session' };
  assert.equal(db.confirmWakeupDelivery({ taskId: bindingTask.id, messageIds: [hostMessage.id], receipt }).confirmed, true);
  assert.equal(db.getMessageById(hostMessage.id).processed_at, null);
  const next = db.sendMessage({ taskId: bindingTask.id, fromAgent: 'antigravity', toAgent: 'codex', content: 'Read is not host acceptance' });
  const beforeRead = db.getWakeupRoute(bindingTask.id).last_woken_seq;
  db.readMessages({ toAgent: 'codex', taskId: bindingTask.id, markAsRead: false });
  assert.equal(db.getMessageById(next.id).status, 'unread');
  db.readMessages({ toAgent: 'codex', taskId: bindingTask.id, markAsRead: true });
  assert.equal(db.getWakeupRoute(bindingTask.id).last_woken_seq, beforeRead);

  // Configure a synthetic command without starting any resident receiver.
  db.db.prepare("UPDATE wakeup_routes SET driver = 'custom_command', wakeup_command = 'exit 0' WHERE task_id = ?").run(bindingTask.id);
  const manualStatus = process.env.BRIDGE_DISABLE_CLI_WAKEUP;
  process.env.BRIDGE_DISABLE_CLI_WAKEUP = '1';
  const forwarded = db.sendMessage({ taskId: bindingTask.id, fromAgent: 'antigravity', toAgent: 'codex', content: 'Command RC0 only' });
  db.db.prepare("UPDATE messages SET wakeup_status = 'pending' WHERE id = ?").run(forwarded.id);
  const forwarding = await db.executeWakeupDelivery(bindingTask.id);
  assert.equal(forwarding.delivered, false);
  assert.equal(db.getWakeupRoute(bindingTask.id).last_woken_seq, beforeRead);
  db.db.prepare("UPDATE wakeup_routes SET driver = 'manual' WHERE task_id = ?").run(bindingTask.id);
  if (manualStatus === undefined) delete process.env.BRIDGE_DISABLE_CLI_WAKEUP; else process.env.BRIDGE_DISABLE_CLI_WAKEUP = manualStatus;

  const codex = new Client('codex');
  const claude = new Client('claude-code');
  const antigravity = new Client('antigravity');
  for (const client of [codex, claude, antigravity]) {
    const initialized = await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'synthetic-test', version: '0.2.0' } });
    assert.equal(initialized.serverInfo.version, '0.4.0');
    const listed = await client.request('tools/list');
    assert.ok(listed.tools.some(t => t.name === 'bridge_send_message'));
  }
  // Hot reload may proxy tools/list, but must not start an unconfigured daemon.
  const reloadRoot = path.join(tmp, 'reload-runtime');
  fs.cpSync(path.join(root, 'src'), path.join(reloadRoot, 'src'), { recursive: true });
  const daemonMarker = path.join(tmp, 'unexpected-daemon');
  fs.writeFileSync(path.join(reloadRoot, 'src/core/wakeup-daemon.mjs'), `import fs from 'node:fs'; export function ensureResidentWakeupDaemon(){fs.writeFileSync(${JSON.stringify(daemonMarker)},'started');}`);
  const reloadClient = new Client('codex', {}, reloadRoot);
  await reloadClient.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'reload-test', version: '0.2.0' } });
  const changedAt = new Date(Date.now() + 2000);
  fs.utimesSync(path.join(reloadRoot, 'src/core/preflight.mjs'), changedAt, changedAt);
  assert.ok((await reloadClient.request('tools/list')).tools.length > 0);
  assert.equal(fs.existsSync(daemonMarker), false);
  db.configureWakeupRoute({ taskId: bindingTask.id, toAgent: 'claude-code', targetSessionId: 'synthetic-host-session', driver: 'manual', enabled: false });
  const originalRoute = db.getWakeupRoute(bindingTask.id);
  const inspectedRoute = await codex.call('bridge_configure_wakeup_route', { taskId: bindingTask.id });
  assert.equal(inspectedRoute.route.enabled, originalRoute.enabled);
  await codex.call('bridge_configure_wakeup_route', { taskId: bindingTask.id, confirmReceipt: { accepted: false } });
  assert.deepEqual(db.getWakeupRoute(bindingTask.id), originalRoute);
  await codex.call('bridge_create_task', { taskId: 'stdio-task', assignedTo: 'antigravity', prompt: 'Synthetic implementation', cwd: tmp, writeRoots: ['output'], requiredModel: 'synthetic-model', requiredConversationId: 'synthetic-session', deliveryMode: 'mcp_structured_patch' });
  await codex.call('bridge_create_task', { taskId: 'reuse-tools', assignedTo: 'antigravity', prompt: 'Original scope', cwd: tmp, requestedTools: ['read_file'] });
  const reused = await codex.call('bridge_create_task', { taskId: 'reuse-tools', prompt: 'Follow-up' });
  assert.equal(reused.task.prompt, 'Original scope');
  for (const [sender, fromAgent, recipient, toAgent] of [[claude, 'claude-code', codex, 'codex'], [codex, 'codex', antigravity, 'antigravity'], [antigravity, 'antigravity', claude, 'claude-code']]) {
    const sent = await sender.call('bridge_send_message', { taskId: 'stdio-task', fromAgent, toAgent, content: `Synthetic ${fromAgent} to ${toAgent}` });
    const read = await recipient.call('bridge_read_messages', { taskId: 'stdio-task', toAgent, markAsRead: false });
    assert.ok(read.messages.some(m => m.id === sent.message.id && m.from_agent === fromAgent));
    assert.equal(db.getMessageById(sent.message.id).status, 'unread');
  }
  const cursor = db.getCurrentSeq();
  const submission = await antigravity.call('bridge_submit_patch', { taskId: 'stdio-task', patchId: 'stdio-patch', fromAgent: 'antigravity', toAgent: 'codex', model: 'synthetic-model', conversationId: 'synthetic-session', content: diff });
  assert.equal(submission.binding.requiredModel, 'synthetic-model');
  assert.equal(submission.binding.boundConversationId, 'synthetic-session');
  const partial = await codex.call('bridge_wait_for_delivery', { taskId: 'stdio-task', toAgent: 'codex', afterSeq: cursor, settleMs: 5, timeoutMs: 30 });
  assert.equal(partial.updatesReceived, true);
  assert.equal(partial.artifactDeliveryComplete, false);
  assert.equal(partial.delivered, false);
  assert.equal(partial.wokenUp, false);
  await antigravity.call('bridge_send_message', { taskId: 'stdio-task', fromAgent: 'antigravity', toAgent: 'codex', content: 'Final synthetic receipt', metadata: { delivery: { final: true, revision: 1, patchIds: ['stdio-patch'] } } });
  const delivery = await codex.call('bridge_wait_for_delivery', { taskId: 'stdio-task', toAgent: 'codex', afterSeq: partial.nextCursor, settleMs: 5, timeoutMs: 30 });
  assert.equal(delivery.artifactDeliveryComplete, true);
  assert.ok(delivery.messages.every(m => m.content === undefined));
  const stored = await codex.call('bridge_get_patch', { patchId: 'stdio-patch' });
  assert.equal(stored.patch.rawContent, diff);
  const saveOutside = await codex.call('bridge_get_patch', { patchId: 'stdio-patch', saveToPath: path.join(tmp, 'escape.patch') }, true);
  assert.ok(saveOutside.error || saveOutside.ok === false);
  for (const saveToPath of ['a/output/leak.patch', ' output/leak.patch', 'output\\leak.patch']) {
    const rejected = await codex.call('bridge_get_patch', { patchId: 'stdio-patch', saveToPath }, true);
    assert.equal(rejected.ok, false);
    assert.equal(fs.existsSync(path.join(tmp, saveToPath)), false);
  }
  const validationCursor = db.getCurrentSeq();
  await codex.call('bridge_record_validation', { taskId: 'stdio-task', patchIds: ['stdio-patch'], applied: true, passed: false, summary: 'Synthetic failing check', details: { command: 'synthetic-check', exitCode: 1 } });
  const repairs = db.readMessages({ taskId: 'stdio-task', toAgent: 'antigravity', afterSeq: validationCursor, markAsRead: false });
  assert.equal(repairs.length, 1);
  assert.equal(repairs[0].metadata.deliveryVersion, 1);
  assert.equal(db.getTaskById('stdio-task').phase, 'awaiting_revision');
  const beforeIdle = db.getCurrentSeq();
  const idle = await codex.call('bridge_wait_for_delivery', { taskId: 'stdio-task', toAgent: 'codex', afterSeq: beforeIdle, settleMs: 0, timeoutMs: 20 });
  assert.equal(idle.hasUpdates, false);
  assert.equal(idle.nextCursor, beforeIdle);
  assert.equal(db.getCurrentSeq(), beforeIdle);

  // A later artifact must not advance the cursor beyond a truncated message page.
  const bulkStart = db.getCurrentSeq();
  for (let i = 0; i < 130; i++) db.sendMessage({ taskId: 'stdio-task', fromAgent: 'antigravity', toAgent: 'codex', content: `bulk-${i}` });
  db.submitPatch({ taskId: 'stdio-task', patchId: 'bulk-patch', fromAgent: 'antigravity', model: 'synthetic-model', conversationId: 'synthetic-session', rawContent: diff });
  const page1 = await db.pollUpdates({ taskId: 'stdio-task', toAgent: 'codex', afterSeq: bulkStart });
  const page2 = await db.pollUpdates({ taskId: 'stdio-task', toAgent: 'codex', afterSeq: page1.nextCursor });
  assert.equal(page1.messages.length + page2.messages.length, 131);
  assert.equal(page2.patches[0].patchId, 'bulk-patch');
  db.sendMessage({ taskId: 'stdio-task', fromAgent: 'antigravity', toAgent: 'codex', content: 'x'.repeat(100000) });
  const overview = db.getTaskOverview('stdio-task');
  assert.ok(JSON.stringify(overview).length < 25000);
  assert.ok(overview.recentMessages.every(m => m.content === undefined));

  // Fake executable fixtures exercise real adapter processes without a provider.
  const mock = path.join(tmp, 'synthetic-provider');
  fs.writeFileSync(mock, `#!${process.execPath}\nconst args = process.argv.slice(2);\nconst m = args.includes('--model') ? args[args.indexOf('--model') + 1] : args.includes('-m') ? args[args.indexOf('-m') + 1] : null;\nconst p = args.includes('-p') ? args[args.indexOf('-p') + 1] : '';\nconst output = { type: 'init', model: p.includes('WRONG') ? 'wrong-model' : m, session_id: 'mock-session', conversation_id: 'mock-session', result: 'Synthetic response' };\nconsole.log(JSON.stringify(output));\nprocess.stdin.resume();\n`);
  fs.chmodSync(mock, 0o755);
  const mockCodex = new Client('codex', { CODEX_BIN: mock });
  const mockClaude = new Client('claude-code', { CLAUDE_BIN: mock });
  const mockAgy = new Client('antigravity', { AGY_BIN: mock });
  for (const [client, agent, execute, resume] of [[mockCodex, 'codex', 'codex_exec', 'codex_resume'], [mockClaude, 'claude-code', 'claude_exec', 'claude_resume']]) {
    const taskId = `unready-${agent}`;
    await codex.call('bridge_create_task', { taskId, assignedTo: agent, prompt: 'Unready source', cwd: tmp, readRoots: ['missing-source'], requiredConversationId: 'mock-session' }, true);
    for (const tool of [execute, resume]) {
      const rejected = await client.call(tool, { taskId, prompt: 'Do not run' }, true);
      assert.equal(rejected.ok, false);
      assert.equal(rejected.errorCode, 'PREFLIGHT_FAILED');
      assert.notEqual(db.getTaskById(taskId).phase, 'cli_turn_ended');
    }
    const modeTask = `readonly-${agent}`;
    await codex.call('bridge_create_task', { taskId: modeTask, assignedTo: agent, prompt: 'Read only', cwd: tmp, deliveryMode: 'read_only' });
    assert.equal(db.getTaskById(modeTask).metadata.deliveryMode, 'read_only');
    const conflict = await client.call(execute, { taskId: modeTask, prompt: 'Contradict mode', ...(agent === 'codex' ? { sandbox: 'workspace-write' } : { permissionMode: 'acceptEdits' }) }, true);
    assert.equal(conflict.ok, false);
  }
  for (const [client, tool] of [[mockCodex, 'codex_exec'], [mockClaude, 'claude_exec'], [mockAgy, 'antigravity_exec']]) {
    const result = await client.call(tool, { prompt: 'Synthetic execution', model: 'synthetic-model', cwd: tmp });
    assert.equal(db.getTaskById(result.taskId).status, 'in_progress');
    assert.equal(db.getTaskById(result.taskId).phase, 'cli_turn_ended');
    assert.equal(db.getTaskById(result.taskId).binding.actualModel, 'synthetic-model');
  }
  const wrong = await mockAgy.call('antigravity_exec', { prompt: 'WRONG model fixture', model: 'synthetic-model', cwd: tmp }, true);
  assert.equal(wrong.ok, false);
  // Match the envelopes observed in current real clients, including RC0 tool denials.
  const nativeMock = path.join(tmp, 'native-envelope-provider');
  fs.writeFileSync(nativeMock, `#!${process.execPath}
const args=process.argv.slice(2); let input='';
process.stdin.on('data', chunk => input+=chunk);
process.stdin.on('end', () => {
  if (args[args.indexOf('--effort')+1] !== 'low') process.exit(3);
  const model=args[args.indexOf('--model')+1];
  const denied=(input+' '+args.join(' ')).includes('DENIED');
  if (args[args.indexOf('--output-format')+1] === 'stream-json') {
    console.log(JSON.stringify({event:'init',conversation_id:'native-session',init:{model}}));
    console.log(JSON.stringify({event:'result',result:{conversation_id:'native-session',status:'SUCCESS',response:'Native response',denied_actions:denied?[{action:'mcp'}]:[]}}));
  } else console.log(JSON.stringify({session_id:'native-session',is_error:false,result:'Native response',modelUsage:{[model]:{canonicalModel:model}},permission_denials:denied?[{tool_name:'test-tool'}]:[]}));
});
`);
  fs.chmodSync(nativeMock, 0o755);
  const nativeAgy = new Client('antigravity', { AGY_BIN: nativeMock });
  const nativeClaude = new Client('claude-code', { CLAUDE_BIN: nativeMock });
  for (const [client, tool] of [[nativeAgy, 'antigravity_exec'], [nativeClaude, 'claude_exec']]) {
    const result = await client.call(tool, { prompt: 'Native envelope', model: 'synthetic-model', effort: 'low', cwd: tmp });
    assert.equal(result.response, 'Native response');
    assert.equal(db.getTaskById(result.taskId).binding.actualModel, 'synthetic-model');
    const denied = await client.call(tool, { prompt: 'DENIED', model: 'synthetic-model', effort: 'low', cwd: tmp }, true);
    assert.equal(denied.ok, false);
    assert.equal(denied.errorCode, 'CLI_PERMISSION_DENIED');
    assert.equal(db.getTaskById(denied.taskId).phase, 'awaiting_revision');
  }
  const noFallback = await antigravity.call('antigravity_exec', { prompt: 'Unavailable selected executable', model: 'synthetic-model', cwd: tmp }, true);
  assert.equal(noFallback.ok, false);
  assert.equal(noFallback.errorCode, 'CLI_UNAVAILABLE');
  assert.equal(noFallback.backend, 'cli');
  assert.equal(db.getTaskById(noFallback.taskId).phase, 'awaiting_revision');
  console.log('PASS: core contracts, three-server stdio collaboration, synthetic provider adapters, and mocked receipt evidence. No live provider or Desktop wakeup was tested.');
}

try { await main(); } finally {
  await Promise.all(clients.map(c => c.close()));
  db.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
