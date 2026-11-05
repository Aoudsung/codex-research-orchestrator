import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';

function directories(root) {
  return fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join(root, e.name));
}

export function resolveClaudeDesktopSession(targetSessionId, home = os.homedir()) {
  if (!/^local_[a-f0-9-]{36}$/.test(targetSessionId || '')) throw Error('Claude Desktop requires its local_ session ID.');
  const root = path.join(home, 'Library/Application Support/Claude/claude-code-sessions');
  const paths = directories(root).flatMap(directories).map(dir => path.join(dir, targetSessionId + '.json')).filter(file => fs.existsSync(file));
  if (paths.length !== 1) throw Error('Cannot uniquely bind the selected Claude Desktop session.');
  const desktop = JSON.parse(fs.readFileSync(paths[0], 'utf8'));
  if (desktop.sessionId !== targetSessionId || desktop.isArchived || !desktop.cliSessionId) throw Error('Claude Desktop session is archived or has no runtime session.');
  const sessionsDir = path.join(home, '.claude/sessions');
  const live = fs.readdirSync(sessionsDir).filter(n => n.endsWith('.json')).map(n => JSON.parse(fs.readFileSync(path.join(sessionsDir, n), 'utf8'))).filter(s => s.sessionId === desktop.cliSessionId && s.entrypoint === 'claude-desktop' && s.messagingSocketPath && fs.existsSync(s.messagingSocketPath));
  if (live.length !== 1) throw Error('The selected Claude Desktop session must be open with one live inbox.');
  const socketPath = live[0].messagingSocketPath;
  const stat = fs.lstatSync(socketPath);
  if (!stat.isSocket() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw Error('Claude inbox must be a private socket owned by this user.');
  const transcripts = directories(path.join(home, '.claude/projects')).map(dir => path.join(dir, desktop.cliSessionId + '.jsonl')).filter(file => fs.existsSync(file));
  if (transcripts.length !== 1) throw Error('Cannot uniquely locate the selected Claude Desktop transcript.');
  return { desktop, runtime: live[0], socketPath, transcriptPath: transcripts[0] };
}

// Socket writes have no mandatory ACK. Only the exact inbound UUID in the GUI transcript confirms acceptance.
export async function deliverViaClaudeDesktopInbox({ targetSessionId, prompt, notificationId = null, model = null, effort = null, timeoutMs = 30000, home = os.homedir() }) {
  const binding = resolveClaudeDesktopSession(targetSessionId, home);
  if ((model && binding.desktop.model !== model) || (effort && binding.desktop.effort !== effort)) throw Error('Claude Desktop model/effort differs from the requested route; no message was sent.');
  if (!prompt?.trim()) throw Error('A non-empty desktop message is required.');
  const messageId = notificationId || crypto.randomUUID();
  if (typeof messageId !== 'string' || !/^[a-zA-Z0-9_-]+(?:-[a-zA-Z0-9_-]+)*$/.test(messageId)) throw Error('A valid notification ID is required.');
  const packet = { type: 'user', msgV: 1, msg_id: messageId, uuid: messageId, session_id: binding.desktop.cliSessionId, priority: 'later', message: { role: 'user', content: prompt } };
  const fd = fs.openSync(binding.transcriptPath, 'r');
  let offset = fs.fstatSync(fd).size, partial = '', socket, timer, poll, settled = false, attempted = false;
  try {
    return await new Promise((resolve, reject) => {
      const finish = (error, result) => {
        if (settled) return;
        settled = true; clearTimeout(timer); clearInterval(poll); socket?.destroy();
        if (error) { error.deliveryAttempted = attempted; error.nativeMessageId = messageId; reject(error); } else resolve(result);
      };
      timer = setTimeout(() => finish(new Error('Native message was submitted, but desktop acceptance is unconfirmed. It will not be resent automatically.')), timeoutMs);
      socket = net.createConnection(binding.socketPath);
      socket.once('error', error => finish(error));
      socket.once('connect', () => { attempted = true; socket.end(JSON.stringify(packet) + '\n'); });
      poll = setInterval(() => {
        try {
          let size = fs.fstatSync(fd).size;
          while (offset < size) {
            const buffer = Buffer.alloc(Math.min(size - offset, 65536));
            const count = fs.readSync(fd, buffer, 0, buffer.length, offset);
            if (!count) break;
            offset += count; partial += buffer.subarray(0, count).toString('utf8');
            let end;
            while ((end = partial.indexOf('\n')) >= 0) {
              const line = partial.slice(0, end); partial = partial.slice(end + 1);
              if (!line.trim()) continue;
              const event = JSON.parse(line);
              if (event.type === 'user' && event.uuid === messageId && event.sessionId === binding.desktop.cliSessionId && event.entrypoint === 'claude-desktop' && event.origin?.kind === 'peer') {
                finish(null, { ok: true, delivered: true, driver: 'claude_desktop', receipt: { accepted: true, targetSessionId, evidence: { provider: 'claude-code', transport: 'desktop_inbox', status: 'accepted', sessionId: binding.desktop.cliSessionId, messageId, model: binding.desktop.model, effort: binding.desktop.effort } } });
                return;
              }
            }
          }
        } catch (error) { finish(error); }
      }, 100);
    });
  } finally { fs.closeSync(fd); }
}
