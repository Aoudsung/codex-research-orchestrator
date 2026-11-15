import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpStdioServer } from '../src/core/mcp-server.mjs';
import { registerBridgeTools } from '../src/core/bridge-tools.mjs';
import { BridgeDatabase } from '../src/core/bridge-db.mjs';

test('a project worker can claim its bound task and submit completion through its actual registered tools', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-native-worker-'));
  const bdb = new BridgeDatabase(path.join(root, 'bridge.sqlite'));
  const saved = process.env.MCP_CALLER_AGENT;
  process.env.MCP_CALLER_AGENT = 'antigravity';
  const tools = new Map();
  try {
    registerBridgeTools({ registerTool: (def, handler) => tools.set(def.name, handler),
      registerResource() {}, sendNotification() {} }, bdb, { toolProfile: 'worker' });
    bdb.createTask({ taskId: 'native-worker', fromAgent: 'codex', assignedTo: 'antigravity',
      prompt: 'Complete the authorized native task', protocolVersion: 2, requiredModel: 'gemini-pro-orchestrator',
      boundConversationId: '197ac346-74b5-4748-8567-86bd23917808' });
    const claimed = await tools.get('bridge_claim_task')({ taskId: 'native-worker', agent: 'antigravity',
      conversationId: '197ac346-74b5-4748-8567-86bd23917808', model: 'gemini-pro-orchestrator' });
    assert.equal(claimed.claimed, true);
    const completed = await tools.get('bridge_complete_task')({ taskId: 'native-worker',
      sessionId: '197ac346-74b5-4748-8567-86bd23917808', model: 'gemini-pro-orchestrator', result: 'complete' });
    assert.equal(completed.ok, true);
    assert.equal(completed.businessReceipt.accepted, true);
    assert.equal(completed.task.metadata.workflow.status, 'delivered');
  } finally {
    if (saved === undefined) delete process.env.MCP_CALLER_AGENT; else process.env.MCP_CALLER_AGENT = saved;
    bdb.stopCrossProcessWatcher();
    bdb.db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function withWorker(crash, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-native-reload-'));
  const script = path.join(root, 'worker.mjs');
  const count = path.join(root, 'count.txt');
  fs.writeFileSync(script, `import fs from 'node:fs';
import { McpStdioServer } from ${JSON.stringify(new URL('../src/core/mcp-server.mjs', import.meta.url).href)};
const server = new McpStdioServer({name:'native-reload',version:'test'});
server.registerTool({name:'dispatch',inputSchema:{type:'object',properties:{}}}, async () => {
  fs.appendFileSync(${JSON.stringify(count)},'one\\n');
  ${crash ? 'process.exit(7);' : "await new Promise(resolve=>setTimeout(resolve,40)); return {accepted:true};"}
});
server.start();`);
  const original = process.argv[1];
  process.argv[1] = script;
  try { await run(count); }
  finally { process.argv[1] = original; fs.rmSync(root, { recursive: true, force: true }); }
}

test('hot-reloaded asynchronous native dispatch returns its receipt and runs once', async () => {
  await withWorker(false, async count => {
    const server = new McpStdioServer({ name: 'parent', version: 'test' });
    const response = await server._delegateToFreshWorker({ jsonrpc: '2.0', id: 1,
      method: 'tools/call', params: { name: 'dispatch', arguments: {} } });
    assert.equal(response.id, 1);
    assert.equal(response.error, undefined);
    assert.equal(JSON.parse(response.result.content[0].text).accepted, true);
    assert.equal(fs.readFileSync(count, 'utf8'), 'one\n');
  });
});

test('a worker exit after dispatch reports uncertainty without falling back to stale code', async () => {
  await withWorker(true, async count => {
    const server = new McpStdioServer({ name: 'parent', version: 'test' });
    server._getMaxSourceMtimeMs = () => server.bootMtimeMs + 1;
    const sent = [];
    server._send = value => sent.push(value);
    server.registerTool({ name: 'dispatch', inputSchema: { type: 'object', properties: {} } }, () => {
      fs.appendFileSync(count, 'duplicate\n');
      return { accepted: true };
    });
    await server._dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'dispatch', arguments: {} } });
    assert.match(sent[0].error.message, /not replayed/);
    assert.equal(fs.readFileSync(count, 'utf8'), 'one\n');
  });
});
