import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from './process-runner.mjs';

const DESKTOP_EXE = '/Applications/Antigravity.app/Contents/Resources/bin/language_server';
const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

function privateEntry(file, directory = false) {
  const stat = fs.lstatSync(file);
  if ((directory ? !stat.isDirectory() : !stat.isFile()) || stat.isSymbolicLink() ||
      stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    throw Error('Antigravity discovery must be private and owned by the current user.');
  }
}

// The desktop already publishes a private, live host discovery record. This
// connects the configured project queue without installing another receiver.
export function resolveAntigravityDesktopHost({ home = os.homedir(), env = process.env } = {}) {
  if (env.ANTIGRAVITY_LS_ADDRESS || env.ANTIGRAVITY_CSRF_TOKEN) {
    if (!env.ANTIGRAVITY_LS_ADDRESS || !env.ANTIGRAVITY_CSRF_TOKEN || !env.ANTIGRAVITY_AGENTAPI_EXE) {
      throw Error('Incomplete Antigravity app-managed host environment.');
    }
    if (!/^127\.0\.0\.1:\d+$/.test(env.ANTIGRAVITY_LS_ADDRESS)) {
      throw Error('Antigravity native host must use IPv4 loopback.');
    }
    return { address: env.ANTIGRAVITY_LS_ADDRESS, csrf: env.ANTIGRAVITY_CSRF_TOKEN,
      executable: env.ANTIGRAVITY_AGENTAPI_EXE, dataDir: env.ANTIGRAVITY_EXECUTABLE_DATA_DIR };
  }
  const dataDir = path.join(home, '.gemini', 'antigravity');
  const daemonDir = path.join(dataDir, 'daemon');
  privateEntry(daemonDir, true);
  const live = [];
  for (const name of fs.readdirSync(daemonDir).filter(name => /^hub_\d+\.json$/.test(name))) {
    const file = path.join(daemonDir, name);
    privateEntry(file);
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Number.isInteger(record.pid) || record.pid <= 0 || !Number.isInteger(record.httpPort) ||
        record.httpPort < 1 || record.httpPort > 65535 || typeof record.csrfToken !== 'string' || !record.csrfToken) {
      throw Error('Invalid Antigravity native discovery record.');
    }
    try { process.kill(record.pid, 0); } catch (error) {
      if (error.code === 'ESRCH') continue;
      throw Error('Cannot verify the Antigravity native host process.');
    }
    live.push({ address: `127.0.0.1:${record.httpPort}`, csrf: record.csrfToken,
      executable: DESKTOP_EXE, dataDir });
  }
  if (live.length !== 1) throw Error('Exactly one live Antigravity desktop host is required.');
  return live[0];
}

async function agentApi(host, args, projectId) {
  const run = await runCommand({ command: host.executable, args: ['agentapi', ...args], timeoutMs: 20000,
    env: { ANTIGRAVITY_LS_ADDRESS: host.address, ANTIGRAVITY_CSRF_TOKEN: host.csrf,
      ...(host.dataDir ? { ANTIGRAVITY_EXECUTABLE_DATA_DIR: host.dataDir } : {}),
      ...(projectId ? { ANTIGRAVITY_PROJECT_ID: projectId } : {}) } });
  // Never copy native stderr: it may contain host credentials or prompt text.
  if (!run.ok) throw Error(`Antigravity agentapi failed (exit ${run.exitCode}, timeout ${run.timedOut}).`);
  let result;
  try { result = JSON.parse(run.stdout); } catch { throw Error('Antigravity agentapi returned invalid JSON.'); }
  if (result.error || !result.response) throw Error('Antigravity agentapi did not return an acceptance response.');
  return result.response;
}

export async function deliverViaAntigravityDesktop({ targetSessionId, prompt, notificationId = null,
  model = null, effort = null, cwd = null }) {
  if (!ID.test(targetSessionId || '')) throw Error('An existing Antigravity conversation UUID is required.');
  if (!prompt?.trim()) throw Error('A non-empty desktop message is required.');
  if (effort) throw Error('The native desktop transport preserves its existing effort and cannot verify an effort override.');
  const host = resolveAntigravityDesktopHost();
  const metadata = (await agentApi(host, ['get-conversation-metadata', targetSessionId])).conversationMetadata?.metadata;
  if (!metadata?.projectId || (metadata.rootConversationId && metadata.rootConversationId !== targetSessionId)) {
    throw Error('Antigravity metadata does not identify the requested root conversation and project.');
  }
  if (cwd) {
    const roots = [...(metadata.workspaceUris || []), ...(metadata.workspaces || []).map(w => w.workspaceFolderAbsoluteUri)];
    if (!roots.some(uri => {
      try { return fs.realpathSync(fileURLToPath(uri)) === fs.realpathSync(cwd); } catch { return false; }
    })) throw Error('The Antigravity conversation workspace differs from the configured route.');
  }
  try {
    const result = (await agentApi(host, ['send-message', targetSessionId, prompt], metadata.projectId)).sendMessage;
    if (result?.recipientId !== targetSessionId || result.content !== prompt) {
      throw Error('Antigravity acceptance does not match the target conversation and message.');
    }
    return { ok: true, delivered: true, driver: 'antigravity_desktop', requestedModel: model, actualModel: null,
      receipt: { accepted: true, targetSessionId, notificationId, evidence: {
        provider: 'antigravity', transport: 'agentapi', status: 'accepted', sessionId: result.recipientId,
        requestedModel: model, model: null, modelEvidence: 'unreported',
        recipientId: result.recipientId, contentMatched: true, projectId: metadata.projectId,
      } } };
  } catch (error) { error.deliveryAttempted = true; throw error; }
}
