import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ProjectReader, BRIDGE_FILE, safePath, fail, normalizeTask, normalizeMessage } from './reader.mjs';
import { DemoReader } from './demo.mjs';
import { callBridgeTool } from './mcp-client.mjs';
import { resolveBinary } from '../core/process-runner.mjs';

const AGENTS = ['codex', 'claude-code', 'antigravity'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const now = () => new Date().toISOString();
const publicDir = fileURLToPath(new URL('./public/', import.meta.url));
const STATIC = { '/': ['index.html','text/html'], '/index.html': ['index.html','text/html'], '/app.js': ['app.js','text/javascript'], '/styles.css': ['styles.css','text/css'] };
const BODY_LIMIT = 128 * 1024;
function validateObject(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('INVALID_BODY', 'Expected a JSON object');
  for (const key of Object.keys(body)) if (!allowed.includes(key)) throw fail('UNKNOWN_FIELD', `Unknown field: ${key}`);
}
function string(body, key, required = false, max = 16000) {
  const value = body[key];
  if (value == null && !required) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw fail('INVALID_FIELD', `${key} must be a nonempty string of at most ${max} characters`);
  return value;
}
function agent(value) { if (!AGENTS.includes(value)) throw fail('INVALID_AGENT', 'Unknown agent'); return value; }
function bodyJSON(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let bytes = 0;
    req.on('data', chunk => { bytes += chunk.length; if (bytes <= BODY_LIMIT) chunks.push(chunk); });
    req.on('error', reject);
    req.on('end', () => {
      if (bytes > BODY_LIMIT) return reject(fail('BODY_TOO_LARGE', 'Request body exceeds 128 KiB', 413));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(fail('INVALID_JSON', 'Malformed JSON body')); }
    });
  });
}

function send(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}
function summarizeOperation(op) {
  return { ...op, result: op.result ? { ok: op.result.ok ?? null, queuedInBridge: op.result.queuedInBridge ?? false, simulated: op.result.simulated ?? false, taskCompleted: op.result.taskCompleted ?? null } : null, error: op.error ? { code: op.error.code, message: op.error.message?.slice(0,1200) } : null };
}
function operationError(error) { return { code: error.code || 'INTERNAL_ERROR', message: error.message, ...(error.details ? { details: error.details } : {}) }; }

export async function createWorkbench({ project, port = 0, demo = false, fixture, toolClient = callBridgeTool } = {}) {
  if (!project) throw fail('PROJECT_REQUIRED', 'Select a project explicitly');
  project = demo ? path.resolve(project) : fs.realpathSync(project);
  if (!demo && !fs.statSync(project).isDirectory()) throw fail('INVALID_PROJECT', 'Project must be a directory');
  const reader = demo ? new DemoReader(fixture) : new ProjectReader(project);
  const token = crypto.randomBytes(32).toString('base64url');
  const operations = new Map();
  const inFlight = new Set();
  let origin;
  function scopedRoots(roots, fallback) {
    if (roots === undefined) roots = fallback;
    if (!Array.isArray(roots) || roots.length > 30) throw fail('INVALID_SCOPE', 'Scope must be an array with at most 30 relative paths');
    for (const root of roots) {
      if (demo) { if (typeof root !== 'string' || !root || path.isAbsolute(root) || path.resolve(project, root) !== project && !path.resolve(project, root).startsWith(project + path.sep)) throw fail('INVALID_SCOPE', 'Scope must remain inside the selected project'); }
      else safePath(project, root);
    }
    return roots;
  }
  function writerPath() { return safePath(project, BRIDGE_FILE); }
  function requireScope(task) {
    if (!task.cwd || fs.realpathSync(task.cwd) !== project) throw fail('TASK_SCOPE_MISMATCH', 'Task cwd does not match the selected project', 409);
    for (const roots of [task.permissions.readRoots || [], task.permissions.writeRoots || []]) {
      for (const root of roots) safePath(project, path.isAbsolute(root) ? path.relative(project, root) || '.' : root);
    }
    return task;
  }
  const providerCall = (provider, tool, args, timeoutMs, caller = 'codex') => toolClient({ project, dbPath: writerPath(), provider, caller, tool, args, timeoutMs });
  async function createTask(body) {
    validateObject(body, ['title','prompt','assignedTo','fromAgent','role','priority','requiredModel','requiredConversationId','readRoots','writeRoots']);
    const title = string(body, 'title', true, 200), prompt = string(body, 'prompt', true, 64000);
    const assignedTo = agent(body.assignedTo), fromAgent = agent(body.fromAgent || 'codex');
    const requiredModel = string(body, 'requiredModel', false, 200), requiredConversationId = string(body, 'requiredConversationId', false, 300), role = string(body, 'role', false, 100);
    const priority = body.priority || 'normal';
    if (!['low','normal','high','urgent'].includes(priority)) throw fail('INVALID_PRIORITY', 'Unknown priority');
    const readRoots = scopedRoots(body.readRoots, ['.']), writeRoots = scopedRoots(body.writeRoots, []);
    if (demo) {
      const task = { id: crypto.randomUUID(), title, prompt, promptPreview: prompt.slice(0,600), fromAgent, assignedTo, role: role || null, priority, status: 'pending', phase: 'ready', phaseLabel: 'Ready', createdAt: now(), updatedAt: now(), completedAt: null, requiredModel: requiredModel || null, actualModel: null, modelSource: null, requiredConversationId: requiredConversationId || null, boundConversationId: null, deliveryVersion: 0, readRoots, writeRoots, resultPreview: null, errorPreview: null };
      reader.data.tasks.push(task);
      return { task: reader.task(task.id).task, preflight: { ok: true, simulated: true, authorityGranted: false, permissionNote: 'Demo only; no provider or filesystem permission was checked' }, simulated: true };
    }
    const result = await providerCall(assignedTo, 'bridge_create_task', { title, prompt, assignedTo, fromAgent, priority, requiredModel, requiredConversationId, readRoots, writeRoots, cwd: project,
      deliveryMode: writeRoots.length ? (assignedTo === 'antigravity' ? 'mcp_structured_patch' : 'direct') : 'read_only', metadata: { role: role || null, origin: 'workbench_user', userInitiated: true } });
    if (!result.task) throw fail(result.errorCode || 'CREATE_FAILED', result.error || 'Task creation failed', 502, result);
    return { task: normalizeTask(result.task), preflight: result.preflight };
  }
  async function message(body) {
    validateObject(body, ['taskId','fromAgent','toAgent','replyTo','subject','content']);
    const taskId = string(body,'taskId',true,300), fromAgent = agent(body.fromAgent), content = string(body,'content',true,64000);
    const toAgent = body.toAgent === undefined ? undefined : agent(body.toAgent), replyTo = string(body,'replyTo',false,300), subject = string(body,'subject',false,300);
    if (!toAgent && !replyTo) throw fail('RECIPIENT_REQUIRED', 'toAgent or replyTo is required');
    if (demo) {
      reader.rawTask(taskId);
      const parent = replyTo ? reader.data.messages.find(m => m.id === replyTo) : null;
      if (replyTo && (!parent || parent.taskId !== taskId || parent.toAgent !== fromAgent)) throw fail('REPLY_BINDING_MISMATCH','Reply does not match this task and sender');
      const recipient = toAgent || parent.fromAgent;
      if (parent && recipient !== parent.fromAgent) throw fail('REPLY_BINDING_MISMATCH','Reply recipient mismatch');
      if (recipient === fromAgent) throw fail('SELF_SEND', 'Sender and recipient must differ');
      const seq = Math.max(0,...reader.records('activity').map(e => e.seq)) + 1;
      const msg = { id: crypto.randomUUID(), seq, taskId, threadId: parent?.threadId || `demo-${taskId}`, fromAgent, toAgent: recipient, subject: subject || '', content, preview: content.slice(0,600), charLength: Array.from(content).length, replyTo: replyTo || null, status: 'unread', createdAt: now(), readAt: null, processedAt: null, wakeupStatus: 'pending', origin: 'workbench_user' };
      reader.data.messages.push(msg);
      return { receipt: { messageId: msg.id, seq, actualFromAgent: fromAgent, actualToAgent: recipient, threadId: msg.threadId, taskId, replyTo: msg.replyTo, simulated: true }, message: reader.list('messages', new URLSearchParams({ taskId })).items.find(m => m.id === msg.id), simulated: true };
    }
    requireScope(reader.rawTask(taskId));
    if (replyTo) reader.database('bridge', db => {
      const parent = db.prepare('SELECT task_id FROM messages WHERE id=?').get(replyTo);
      if (!parent || parent.task_id !== taskId) throw fail('REPLY_BINDING_MISMATCH','Reply must belong to the selected task');
    });
    const result = await providerCall('codex', 'bridge_send_message', { taskId, fromAgent, toAgent, replyTo, subject, content, metadata: { origin: 'workbench_user', userInitiated: true } });
    if (result.ok === false) throw fail(result.errorCode || 'MESSAGE_FAILED', result.error || 'Message could not be saved', 409, result);
    return { receipt: result.receipt, message: normalizeMessage(result.message || result.sentMessage) };
  }
  function dispatch(taskId, body) {
    validateObject(body, ['effort','timeoutSeconds']);
    const effort = body.effort || 'low', timeoutSeconds = body.timeoutSeconds ?? 120;
    if (!EFFORTS.includes(effort)) throw fail('INVALID_EFFORT','Unknown effort');
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600) throw fail('INVALID_TIMEOUT','timeoutSeconds must be between 1 and 600');
    const task = demo ? reader.rawTask(taskId) : requireScope(reader.rawTask(taskId));
    const requiredModel = demo ? task.requiredModel : task.required_model;
    if (!requiredModel?.trim()) throw fail('MODEL_REQUIRED','Record an explicit required model before dispatch',409);
    const control = demo ? reader.control : reader.snapshot().control;
    if (control.paused === null) throw fail('CONTROL_UNAVAILABLE','Bridge control state cannot be read',503);
    if (control.paused) throw fail('BRIDGE_PAUSED','Resume before dispatching new work',409);
    if (inFlight.has(taskId)) throw fail('TASK_ALREADY_DISPATCHING','This task already has an active workbench operation',409);
    const assignedTo = agent(demo ? task.assignedTo : task.assigned_to);
    const op = { id: crypto.randomUUID(), type: 'dispatch', taskId, state: 'pending', createdAt: now(), startedAt: null, finishedAt: null, summary: 'Dispatch requested', result: null, error: null };
    operations.set(op.id, op); inFlight.add(taskId);
    // Retain a bounded history without removing in-flight operations.
    for (const [id, record] of operations) { if (operations.size <= 100) break; if (!['pending','running'].includes(record.state)) operations.delete(id); }
    setImmediate(async () => {
      op.state = 'running'; op.startedAt = now(); op.summary = demo ? 'Simulating dispatch' : 'Provider request in progress';
      try {
        let result;
        if (demo) result = { ok: true, simulated: true, taskCompleted: false, note: 'Fictional demonstration; no model was invoked or task completed' };
        else {
          const args = { taskId, prompt: task.prompt, model: requiredModel, cwd: project, effort, timeoutMs: timeoutSeconds * 1000, completeTaskOnExit: false };
          const tool = { codex: 'codex_exec', 'claude-code': 'claude_exec', antigravity: 'antigravity_exec' }[assignedTo];
          if (assignedTo !== 'claude-code') args.requiredModel = requiredModel;
          if (assignedTo === 'antigravity') args.backend = 'cli';
          result = await providerCall(assignedTo, tool, args, timeoutSeconds * 1000 + 10000, agent(task.from_agent));
        }
        op.result = result;
        op.state = result.ok === false ? 'failed' : 'succeeded';
        op.summary = demo ? 'Simulated request finished; no provider contacted' : result.queuedInBridge ? 'Queued in bridge; execution has not been confirmed' : result.ok === false ? 'Provider reported failure' : 'Provider request finished; inspect result evidence';
        if (result.ok === false) op.error = { code: result.errorCode || result.errorClassification?.category || 'PROVIDER_FAILED', message: result.error || result.errorClassification?.message || result.note || 'Provider reported failure' };
      } catch (error) { op.state = 'failed'; op.error = operationError(error); op.summary = error.message; }
      finally { op.finishedAt = now(); inFlight.delete(taskId); }
    });
    return op;
  }
  async function control(body) {
    validateObject(body, ['paused','reason']);
    if (typeof body.paused !== 'boolean') throw fail('INVALID_CONTROL','paused must be a boolean');
    const reason = string(body,'reason',false,1000) || null;
    if (demo) { reader.control = { ...reader.control, paused: body.paused, reason, changedAt: now() }; return { ...reader.control, activeOperations: inFlight.size, simulated: true }; }
    // Writer construction is confined to this explicit control action.
    const { BridgeDatabase } = await import('../core/bridge-db.mjs');
    const db = new BridgeDatabase(writerPath());
    try { return { ...db.setControlState({ paused: body.paused, reason }), activeOperations: inFlight.size }; }
    finally { db.db.close(); }
  }
  const server = http.createServer(async (req, res) => {
    try {
      if (req.headers.host !== new URL(origin).host) throw fail('INVALID_HOST','Unexpected Host header',403);
      const url = new URL(req.url, origin);
      if (url.origin !== origin) throw fail('INVALID_ORIGIN','Unexpected request target',403);
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' || !Object.hasOwn(STATIC,url.pathname)) throw fail('NOT_FOUND','Resource not found',404);
        const [file, mime] = STATIC[url.pathname];
        res.writeHead(200,{ 'Content-Type': mime + '; charset=utf-8', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'", 'Referrer-Policy':'no-referrer' });
        res.end(fs.readFileSync(path.join(publicDir,file))); return;
      }
      const auth = req.headers.authorization || '';
      const expected = `Bearer ${token}`;
      if (Buffer.byteLength(auth) !== Buffer.byteLength(expected) || !crypto.timingSafeEqual(Buffer.from(auth),Buffer.from(expected))) throw fail('UNAUTHORIZED','A valid workbench token is required',401);
      if (req.method === 'GET') {
        let value;
        if (url.pathname === '/api/snapshot') { value = reader.snapshot(); value.operations = [...operations.values()].reverse().map(summarizeOperation); value.control.activeOperations = inFlight.size; }
        else if (url.pathname === '/api/capabilities') value = { providers: AGENTS.map(id => ({ id, executableAvailable: demo ? false : Boolean(resolveBinary({codex:'codex','claude-code':'claude',antigravity:'agy'}[id],{codex:'CODEX_BIN','claude-code':'CLAUDE_BIN',antigravity:'AGY_BIN'}[id])), authentication: 'not-verified' })), controlsAvailable: true, dispatchAvailable: true, limits: { pageDefault:30, pageMaximum:100, sourceMaximum:64000, bodyBytes:BODY_LIMIT, timeoutSeconds:600 }, ...(demo ? { simulated:true } : {}) };
        else if (url.pathname === '/api/source') value = reader.source(url.searchParams);
        else if (/^\/api\/operations\/[^/]+$/.test(url.pathname)) { value = operations.get(decodeURIComponent(url.pathname.split('/').at(-1))); if (!value) throw fail('NOT_FOUND','Operation not found',404); }
        else if (/^\/api\/tasks\/[^/]+$/.test(url.pathname)) { const id = decodeURIComponent(url.pathname.split('/').at(-1)); value = reader.task(id); const operation = [...operations.values()].reverse().find(o => o.taskId === id); value.operation = operation ? summarizeOperation(operation) : null; }
        else if (/^\/api\/(tasks|messages|patches|validations|evidence|activity)$/.test(url.pathname)) value = reader.list(url.pathname.slice(5),url.searchParams);
        else throw fail('NOT_FOUND','Endpoint not found',404);
        send(res,200,value); return;
      }
      if (req.method !== 'POST') throw fail('METHOD_NOT_ALLOWED','Method not allowed',405);
      if (req.headers.origin !== origin) throw fail('INVALID_ORIGIN','Writes require the exact workbench Origin',403);
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) throw fail('JSON_REQUIRED','Writes require application/json',415);
      const body = await bodyJSON(req);
      if (url.pathname === '/api/tasks') send(res,201,await createTask(body));
      else if (url.pathname === '/api/messages') send(res,201,await message(body));
      else if (url.pathname === '/api/control') send(res,200,await control(body));
      else if (/^\/api\/tasks\/[^/]+\/dispatch$/.test(url.pathname)) send(res,202,dispatch(decodeURIComponent(url.pathname.split('/')[3]),body));
      else throw fail('NOT_FOUND','Endpoint not found',404);
    } catch (error) { if (!res.headersSent) send(res,error.status || 500,{ error: operationError(error) }); else res.destroy(); }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(port,'127.0.0.1',resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, origin, token, url: `${origin}/#token=${token}`, reader, operations, close: () => new Promise((resolve,reject) => server.close(error => error ? reject(error) : resolve())) };
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24+ is required');
  const args = process.argv.slice(2), options = { port:8765 };
  for (let i=0;i<args.length;i++) {
    if (args[i] === '--project') options.project = args[++i];
    else if (args[i] === '--port') { options.port = Number(args[++i]); if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error('Invalid port'); }
    else if (args[i] === '--demo') options.demo = true;
    else if (args[i] === '--open') options.open = true;
    else throw new Error(`Unknown option: ${args[i]}`);
  }
  const app = await createWorkbench(options);
  process.stdout.write(`Research workbench (${options.demo ? 'fictional demo' : 'live, selected project only'}): ${app.url}\n`);
  if (options.open) {
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
    const child = spawn(command,[app.url],{ stdio:'ignore',shell:false });
    child.on('error',error => process.stderr.write(`Browser could not open: ${error.message}\n`));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode=1; });
