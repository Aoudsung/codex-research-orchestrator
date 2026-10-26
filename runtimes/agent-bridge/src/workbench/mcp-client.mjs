import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fail } from './reader.mjs';

const PROVIDERS = { codex: 'codex', 'claude-code': 'claude-code', antigravity: 'antigravity' };
const TOOLS = new Set(['bridge_create_task', 'bridge_send_message', 'codex_exec', 'claude_exec', 'antigravity_exec']);

// Each explicit HTTP action gets an isolated stdio client. No provider module is imported.
export function callBridgeTool({ project, dbPath, provider = 'codex', caller = 'codex', tool, args, timeoutMs = 30000 }) {
  if (!Object.hasOwn(PROVIDERS, provider) || !Object.hasOwn(PROVIDERS, caller) || !TOOLS.has(tool)) throw fail('TOOL_NOT_ALLOWED', 'Tool is not exposed by the workbench', 403);
  const script = fileURLToPath(new URL(`../servers/${PROVIDERS[provider]}-mcp.mjs`, import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { cwd: project, env: { ...process.env, AGENT_BRIDGE_DB: dbPath,
      MCP_CALLER_AGENT: caller, MCP_ONE_SHOT_WORKER: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', stderr = '', done = false;
    const timer = setTimeout(() => finish(fail('PROVIDER_TIMEOUT', 'Provider MCP request timed out', 504)), timeoutMs);
    function finish(error, value) {
      if (done) return;
      done = true; clearTimeout(timer); child.kill();
      error ? reject(error) : resolve(value);
    }
    child.on('error', error => finish(fail('PROVIDER_UNAVAILABLE', error.message, 503)));
    child.on('exit', code => finish(fail('PROVIDER_EXIT', `Provider MCP exited (${code}): ${stderr.slice(-1200)}`, 502)));
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 8 * 1024 * 1024) return finish(fail('PROVIDER_RESPONSE_TOO_LARGE', 'Provider response exceeded 8 MiB', 502));
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { return finish(fail('PROVIDER_PROTOCOL_ERROR', 'Provider returned invalid JSON', 502)); }
        if (message.id === 1) {
          if (message.error) return finish(fail('PROVIDER_PROTOCOL_ERROR', message.error.message, 502));
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } }) + '\n');
        } else if (message.id === 2) {
          if (message.error) return finish(fail('PROVIDER_PROTOCOL_ERROR', message.error.message, 502));
          let value;
          try { value = JSON.parse(message.result.content.find(c => c.type === 'text').text); }
          catch { return finish(fail('PROVIDER_PROTOCOL_ERROR', 'Provider result was not structured JSON', 502)); }
          if (message.result.isError) return finish(fail(value.errorCode || 'PROVIDER_ERROR', value.error || 'Provider tool failed', value.errorCode === 'BRIDGE_PAUSED' ? 409 : 502, value));
          finish(null, value);
        }
      }
    });
    child.stdin.on('error', error => finish(fail('PROVIDER_PROTOCOL_ERROR', error.message, 502)));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'research-workbench', version: '1' } } }) + '\n');
  });
}
