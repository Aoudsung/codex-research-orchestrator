import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { resolveAntigravityDesktopHost, deliverViaAntigravityDesktop } from '../src/core/antigravity-desktop-wakeup.mjs';
import { executeTaskWakeupDriver } from '../src/runtime/drivers.mjs';
import { BridgeEngine } from '../src/domain/engine.mjs';
import { MemoryRepositories } from '../src/domain/memory-repos.mjs';

const SESSION = '00000000-0000-4000-8000-000000000102';
const MODEL = 'gemini-pro-orchestrator-argon';

test('project process resolves the existing private desktop host without a sidecar', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-host-'));
  try {
    const dir = path.join(root, '.gemini', 'antigravity', 'daemon');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, 'hub_1234.json');
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, httpPort: 1234, csrfToken: 'test-only' }), { mode: 0o600 });
    const host = resolveAntigravityDesktopHost({ home: root, env: {} });
    assert.equal(host.address, '127.0.0.1:1234');
    assert.equal(host.executable, '/Applications/Antigravity.app/Contents/Resources/bin/language_server');
    fs.chmodSync(file, 0o644);
    assert.throws(() => resolveAntigravityDesktopHost({ home: root, env: {} }), /private/);
    assert.throws(() => resolveAntigravityDesktopHost({ home: root,
      env: { ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:1234' } }), /Incomplete/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

async function nativeFixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-agentapi-'));
  const sent = path.join(root, 'sent.jsonl');
  const executable = path.join(root, 'agentapi-host');
  fs.writeFileSync(executable, `#!${process.execPath}
import fs from 'node:fs';
const [, , subcommand, command, recipient, content] = process.argv;
if (subcommand !== 'agentapi') process.exit(2);
if (command === 'get-conversation-metadata') {
  console.log(JSON.stringify({response:{conversationMetadata:{metadata:{rootConversationId:recipient,
    projectId:'native-project',workspaceUris:[${JSON.stringify(pathToFileURL(root).href)}]}}}}));
} else if (command === 'send-message') {
  fs.appendFileSync(${JSON.stringify(sent)}, JSON.stringify({recipient,content,projectId:process.env.ANTIGRAVITY_PROJECT_ID})+'\\n');
  console.log(JSON.stringify({response:{sendMessage:{recipientId:recipient,
    content:process.env.NATIVE_TEST_UNCONFIRMED ? 'wrong echo' : content}}}));
} else process.exit(3);
`, { mode: 0o700 });
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryExecutorMetadatas');
    assert.equal(req.headers['x-codeium-csrf-token'], 'test-only');
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ executorMetadata: [{ cascadeConfig: { plannerConfig: { modelName: MODEL } } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const values = { ANTIGRAVITY_LS_ADDRESS: `127.0.0.1:${server.address().port}`,
    ANTIGRAVITY_CSRF_TOKEN: 'test-only', ANTIGRAVITY_AGENTAPI_EXE: executable,
    ANTIGRAVITY_EXECUTABLE_DATA_DIR: root, BRIDGE_DESKTOP_SESSION_ID: undefined,
    NATIVE_TEST_UNCONFIRMED: undefined };
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  try { await run({ root, sent }); }
  finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function queued(root) {
  const repos = new MemoryRepositories();
  const engine = new BridgeEngine({ repos });
  engine.createTask({ taskId: 'native-delivery', fromAgent: 'codex', assignedTo: 'antigravity',
    prompt: 'Original dispatch', requiredModel: MODEL, boundConversationId: SESSION });
  engine.configureWakeupRoute({ taskId: 'native-delivery', toAgent: 'antigravity',
    targetSessionId: SESSION, driver: 'antigravity_desktop', cwd: root, model: MODEL });
  for (const content of ['Original dispatch', 'Read current contract v2 before acting']) {
    engine.sendMessage({ taskId: 'native-delivery', fromAgent: 'codex', toAgent: 'antigravity', content });
  }
  return { engine, repos };
}

test('native delivery preserves model/project, coalesces latest messages and needs actual consumption', async () => {
  await nativeFixture(async ({ root, sent }) => {
    const { engine, repos } = queued(root);
    const delivered = await executeTaskWakeupDriver(engine, 'native-delivery', { toAgent: 'antigravity' });
    assert.equal(delivered.delivered, true);
    assert.equal(delivered.actualModel, null);
    const calls = fs.readFileSync(sent, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].recipient, SESSION);
    assert.equal(calls[0].projectId, 'native-project');
    assert.match(calls[0].content, /current contract v2/);
    assert.match(calls[0].content, /bridge_claim_task\(taskId="native-delivery", agent="antigravity"/);
    assert.match(calls[0].content, /Requested model: gemini-pro-orchestrator-argon/);
    assert.match(calls[0].content, /global bridge connections have separate queues/);
    assert.equal(repos.queryMessages({ taskId: 'native-delivery', toAgent: 'antigravity' })
      .every(message => !message.consumed_at), true);
    assert.equal((await executeTaskWakeupDriver(engine, 'native-delivery', { toAgent: 'antigravity' })).claimed, false);
    assert.equal(fs.readFileSync(sent, 'utf8').trim().split('\n').length, 1);
  });
});

test('effort override or mismatched workspace cannot send a native message', async () => {
  await nativeFixture(async ({ root, sent }) => {
    await assert.rejects(deliverViaAntigravityDesktop({ targetSessionId: SESSION, prompt: 'queued',
      cwd: root, model: MODEL, effort: 'high' }), /effort override/);
    await assert.rejects(deliverViaAntigravityDesktop({ targetSessionId: SESSION, prompt: 'queued',
      cwd: os.tmpdir(), model: MODEL }), /workspace differs/);
    assert.equal(fs.existsSync(sent), false);
  });
});

test('an attempted native send with an unverified echo remains unconfirmed and is never resent', async () => {
  await nativeFixture(async ({ root, sent }) => {
    process.env.NATIVE_TEST_UNCONFIRMED = '1';
    const { engine, repos } = queued(root);
    const result = await executeTaskWakeupDriver(engine, 'native-delivery', { toAgent: 'antigravity' });
    assert.equal(result.delivered, false);
    assert.equal(repos.queryMessages({ taskId: 'native-delivery', toAgent: 'antigravity' })
      .every(message => message.wakeup_status === 'unconfirmed'), true);
    const next = await executeTaskWakeupDriver(engine, 'native-delivery', { toAgent: 'antigravity', includeDispatched: true });
    assert.equal(next.claimed, false);
    assert.equal(fs.readFileSync(sent, 'utf8').trim().split('\n').length, 1);
  });
});
