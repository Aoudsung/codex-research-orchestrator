import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const BRIDGE_FILE = '.agent-bridge/bridge.sqlite';
export const MEMORY_FILE = '.research-memory/memory.sqlite3';
export const PREVIEW = 600;
export function fail(code, message, status = 400, details) {
  return Object.assign(new Error(message), { code, status, details });
}
export function safePath(project, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\0')) throw fail('INVALID_PATH', 'A project-relative path is required');
  const target = path.resolve(project, relative);
  const within = p => p === project || p.startsWith(project + path.sep);
  if (!within(target)) throw fail('PATH_ESCAPE', 'Path escapes the selected project', 403);
  let ancestor = target;
  while (!fs.existsSync(ancestor)) {
    // A broken symlink must not be treated as a missing directory.
    try { if (fs.lstatSync(ancestor).isSymbolicLink()) throw fail('UNSAFE_SYMLINK', 'Broken symlink cannot be used', 403); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    ancestor = path.dirname(ancestor);
  }
  if (!within(fs.realpathSync(ancestor))) throw fail('PATH_ESCAPE', 'Symlink escapes the selected project', 403);
  return target;
}
export function parseJSON(value, fallback = {}) { return value == null ? fallback : JSON.parse(value); }
export function normalizeTask(row) {
  const metadata = row.metadata || parseJSON(row.metadata_json);
  const permissions = row.permissions || parseJSON(row.permissions_json);
  const runtimeSources = ['runtime_init_metadata', 'runtime_event_metadata', 'claude_json_output', 'python_sdk_runtime'];
  const observed = metadata.lastModelObservation;
  const modelSource = row.actual_model && runtimeSources.includes(observed?.source) && observed.reportedModel === row.actual_model
    ? observed.source : row.actual_model && runtimeSources.includes(metadata.modelSource) ? metadata.modelSource : null;
  return { id: row.id, title: row.title, promptPreview: (row.prompt || '').slice(0, PREVIEW), fromAgent: row.from_agent,
    assignedTo: row.assigned_to, role: metadata.role || null, priority: row.priority, status: row.status,
    phase: row.phase, phaseLabel: row.phase_label, createdAt: row.created_at, updatedAt: row.updated_at,
    completedAt: row.completed_at, requiredModel: row.required_model, actualModel: row.actual_model,
    modelSource, requiredConversationId: row.required_conversation_id, boundConversationId: row.bound_conversation_id,
    deliveryVersion: row.delivery_version, readRoots: permissions.readRoots || [], writeRoots: permissions.writeRoots || [],
    resultPreview: row.result?.slice(0, PREVIEW) || null, errorPreview: row.error?.slice(0, PREVIEW) || null };
}
export function normalizeMessage(r) {
  return { id: r.id, seq: r.seq, taskId: r.task_id, threadId: r.thread_id, fromAgent: r.from_agent, toAgent: r.to_agent,
    subject: r.subject, preview: (r.content || '').slice(0, PREVIEW), charLength: r.char_length ?? r.content?.length ?? 0,
    replyTo: r.reply_to, status: r.status, createdAt: r.created_at, readAt: r.read_at, processedAt: r.processed_at,
    wakeupStatus: r.wakeup_status, origin: (r.metadata || parseJSON(r.metadata_json)).origin || null };
}
const normalizePatch = r => ({ id: r.patch_id, seq: r.seq, taskId: r.task_id, fromAgent: r.from_agent, kind: r.artifact_kind,
  summary: r.summary?.slice(0, PREVIEW), status: r.status, targetFiles: parseJSON(r.target_files_json, []),
  dependsOn: parseJSON(r.depends_on_json, []), supersedes: r.supersedes, supersededBy: r.superseded_by, createdAt: r.created_at, charLength: r.char_length });
const normalizeValidation = r => ({ id: r.id, seq: r.seq, taskId: r.task_id, actor: r.validator_agent,
  passed: r.passed == null ? null : Boolean(r.passed), applied: Boolean(r.applied), summary: r.summary?.slice(0, PREVIEW), createdAt: r.created_at });
const normalizeEvidence = r => ({ id: r.id, kind: r.kind, title: r.title, summary: r.summary, source: r.source, scope: r.scope,
  claimStatus: r.claim_status, recordState: r.state, updatedAt: r.updated_at, dependsOn: parseJSON(r.depends_on, []) });
const SPECS = {
  tasks: { source: 'bridge', table: 'tasks', id: 'id', key: 'created_at', select: `id, title, substr(prompt,1,600) prompt, from_agent, assigned_to, priority, status, phase, phase_label, created_at, updated_at, completed_at, required_model, actual_model, required_conversation_id, bound_conversation_id, delivery_version, permissions_json, metadata_json, substr(result,1,600) result, substr(error,1,600) error`, normalize: normalizeTask },
  messages: { source: 'bridge', table: 'messages', id: 'id', key: 'seq', select: `id, seq, task_id, thread_id, from_agent, to_agent, subject, substr(content,1,600) content, length(content) char_length, reply_to, status, created_at, read_at, processed_at, wakeup_status, metadata_json`, normalize: normalizeMessage },
  patches: { source: 'bridge', table: 'patches', id: 'patch_id', key: 'seq', select: `patch_id, seq, task_id, from_agent, artifact_kind, substr(summary,1,600) summary, status, target_files_json, depends_on_json, supersedes, superseded_by, created_at, length(raw_content) char_length`, normalize: normalizePatch },
  validations: { source: 'bridge', table: 'task_validations', id: 'id', key: 'seq', select: `id, seq, task_id, validator_agent, passed, applied, substr(summary,1,600) summary, created_at`, normalize: normalizeValidation },
  evidence: { source: 'memory', table: 'records', id: 'id', key: 'id', select: `id, kind, title, summary, source, scope, claim_status, state, updated_at, (SELECT json_group_array(dependency_id) FROM dependencies WHERE record_id = records.id) depends_on`, normalize: normalizeEvidence },
  activity: { source: 'bridge', table: `(SELECT id,seq,'message' kind,task_id,from_agent actor,to_agent recipient,subject title,substr(content,1,600) preview,status,created_at FROM messages UNION ALL SELECT patch_id,seq,'patch',task_id,from_agent,to_agent,artifact_kind,substr(summary,1,600),status,created_at FROM patches UNION ALL SELECT id,seq,'validation',task_id,validator_agent,NULL,'Validation',substr(summary,1,600),CASE WHEN passed=1 THEN 'passed' WHEN passed=0 THEN 'failed' ELSE NULL END,created_at FROM task_validations)`, id: 'id', key: 'seq', select: '*', normalize: r => ({ id: r.id, seq: r.seq, kind: r.kind, taskId: r.task_id, actor: r.actor, recipient: r.recipient, title: r.title, preview: r.preview, status: r.status, createdAt: r.created_at, source: 'bridge' }) },
};
export function numberParam(value, fallback, max) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > max) throw fail('INVALID_RANGE', `Expected an integer between 0 and ${max}`);
  return number;
}
export function pageOptions(resource, params) {
  const filters = Object.fromEntries(['query', 'phase', 'agent', 'taskId', 'kind', 'state'].map(k => [k, params.get(k) || '']));
  const signature = JSON.stringify([resource, filters]);
  const limit = numberParam(params.get('limit'), 30, 100);
  if (!limit) throw fail('INVALID_RANGE', 'Page limit must be positive');
  let cursor = null;
  if (params.get('cursor')) {
    try { cursor = JSON.parse(Buffer.from(params.get('cursor'), 'base64url').toString()); } catch { throw fail('INVALID_CURSOR', 'Invalid page cursor'); }
    if (cursor.signature !== signature || !['string', 'number'].includes(typeof cursor.key) || !['string', 'number'].includes(typeof cursor.id)) throw fail('INVALID_CURSOR', 'Cursor does not match this query');
  }
  return { filters, signature, limit, cursor };
}
export function pageResult(items, hasMore, last, signature) {
  return { items, hasMore, nextCursor: hasMore ? Buffer.from(JSON.stringify({ signature, ...last })).toString('base64url') : null };
}

export class ProjectReader {
  constructor(project) { this.project = fs.realpathSync(project); }
  database(source, work) {
    let db;
    const relative = source === 'bridge' ? BRIDGE_FILE : MEMORY_FILE;
    try {
      const file = safePath(this.project, relative);
      if (!fs.existsSync(file)) throw fail('SOURCE_MISSING', `${source} source is missing`, 404);
      db = new DatabaseSync(file, { readOnly: true });
      db.exec('PRAGMA query_only = ON');
      if (source === 'memory') {
        const config = Object.fromEntries(db.prepare('SELECT key,value FROM config').all().map(r => [r.key, r.value]));
        if (config.version !== '1' || config.project !== this.project) throw fail('SOURCE_UNSUPPORTED', 'Memory schema or project identity does not match', 409);
      }
      return work(db);
    } catch (error) {
      if (error.status) throw error;
      throw fail('SOURCE_ERROR', `${source}: ${error.message}`, 503);
    } finally { db?.close(); }
  }
  list(resource, params = new URLSearchParams()) {
    const spec = SPECS[resource];
    if (!spec) throw fail('NOT_FOUND', 'Unknown resource', 404);
    const { filters: f, limit, cursor, signature } = pageOptions(resource, params);
    return this.database(spec.source, db => {
      const where = [], args = [];
      if (cursor) { where.push(`(${spec.key} < ? OR (${spec.key} = ? AND ${spec.id} < ?))`); args.push(cursor.key, cursor.key, cursor.id); }
      if (f.taskId && ['messages', 'patches', 'validations', 'activity'].includes(resource)) { where.push('task_id = ?'); args.push(f.taskId); }
      if (f.phase && resource === 'tasks') { where.push('phase = ?'); args.push(f.phase); }
      if (f.state && resource === 'evidence') { where.push('state = ?'); args.push(f.state); }
      if (f.kind && ['evidence', 'activity'].includes(resource)) { where.push('kind = ?'); args.push(f.kind); }
      if (f.agent && ['tasks', 'messages'].includes(resource)) { where.push(resource === 'tasks' ? '(from_agent = ? OR assigned_to = ?)' : '(from_agent = ? OR to_agent = ?)'); args.push(f.agent, f.agent); }
      if (f.query) {
        const columns = { tasks: ['title', 'prompt'], messages: ['subject', 'content'], evidence: ['title', 'summary', 'body'] }[resource];
        if (columns) { where.push('(' + columns.map(c => `instr(lower(${c}),lower(?)) > 0`).join(' OR ') + ')'); args.push(...columns.map(() => f.query)); }
      }
      const rows = db.prepare(`SELECT ${spec.select} FROM ${spec.table} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${spec.key} DESC, ${spec.id} DESC LIMIT ?`).all(...args, limit + 1);
      const shown = rows.slice(0, limit), last = shown.at(-1);
      return pageResult(shown.map(spec.normalize), rows.length > limit, last && { key: last[spec.key], id: last[spec.id] }, signature);
    });
  }
  task(id) {
    return this.database('bridge', db => {
      const raw = db.prepare(`SELECT ${SPECS.tasks.select} FROM tasks WHERE id = ?`).get(id);
      if (!raw) throw fail('NOT_FOUND', 'Task not found', 404);
      const children = {}, limits = {};
      for (const resource of ['messages', 'patches', 'validations']) {
        const spec = SPECS[resource];
        children[resource] = db.prepare(`SELECT ${spec.select} FROM ${spec.table} WHERE task_id = ? ORDER BY seq DESC LIMIT 30`).all(id).map(spec.normalize);
        limits[resource] = db.prepare(`SELECT count(*) n FROM ${spec.table} WHERE task_id = ?`).get(id).n - children[resource].length;
      }
      const r = db.prepare('SELECT * FROM wakeup_routes WHERE task_id = ?').get(id);
      const route = r ? { taskId: r.task_id, toAgent: r.to_agent, targetSessionId: r.target_session_id, driver: r.driver,
        enabled: Boolean(r.enabled), lastDispatchAt: r.last_dispatched_at, lastDeliveryAt: r.last_delivered_at,
        receipt: parseJSON(r.last_receipt_json, null), lastError: r.last_error } : null;
      return { task: normalizeTask(raw), ...children, route, operation: null, limits };
    });
  }
  rawTask(id) {
    return this.database('bridge', db => {
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
      if (!task) throw fail('NOT_FOUND', 'Task not found', 404);
      return { ...task, metadata: parseJSON(task.metadata_json), permissions: parseJSON(task.permissions_json) };
    });
  }
  documents() {
    const names = new Set(['controls.md', 'charter.md', 'project.md', 'state.md']);
    try { this.database('memory', db => {
      const controls = parseJSON(db.prepare("SELECT value FROM config WHERE key = 'controls'").get()?.value, []);
      for (const name of controls) names.add(name);
      for (const row of db.prepare('SELECT DISTINCT source FROM records ORDER BY source LIMIT 500').all()) names.add(row.source);
    }); } catch { /* Snapshot reports unavailable memory; fixed project documents remain inspectable. */ }
    return [...names].map(name => {
      try { const file = safePath(this.project, name); const stat = fs.existsSync(file) ? fs.statSync(file) : null;
        return { id: name, title: path.basename(name), path: name, exists: stat?.isFile() || false, size: stat?.size ?? null };
      } catch (error) { return { id: name, title: String(name), path: name, exists: false, size: null, error: error.message }; }
    });
  }
  source(params) {
    const kind = params.get('kind'), id = params.get('id');
    const field = params.get('field') ?? 'prompt';
    if (kind === 'task' && !['prompt', 'result', 'error'].includes(field)) throw fail('INVALID_FIELD', 'Task source field must be prompt, result, or error');
    const offset = numberParam(params.get('offset'), 0, Number.MAX_SAFE_INTEGER);
    const limit = numberParam(params.get('limit'), 16000, 64000);
    let value;
    if (kind === 'document') {
      const declared = ['controls.md', 'charter.md', 'project.md', 'state.md'].includes(id) || this.database('memory', db => {
        const controls = parseJSON(db.prepare("SELECT value FROM config WHERE key = 'controls'").get()?.value, []);
        return controls.includes(id) || Boolean(db.prepare('SELECT 1 FROM records WHERE source = ? LIMIT 1').get(id));
      });
      if (!declared) throw fail('SOURCE_NOT_ALLOWED', 'Document is not a declared project source', 403);
      const file = safePath(this.project, id);
      if (!fs.existsSync(file)) throw fail('SOURCE_MISSING', 'Document is missing', 404);
      if (!fs.statSync(file).isFile() || fs.statSync(file).size > 8 * 1024 * 1024) throw fail('SOURCE_TOO_LARGE', 'Document must be a text file of at most 8 MiB', 413);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file));
      const characters = Array.from(text);
      value = { text: characters.slice(offset, offset + limit).join(''), totalLength: characters.length };
    } else {
      const spec = { task: ['bridge', 'tasks', 'id', field], message: ['bridge', 'messages', 'id', 'content'], patch: ['bridge', 'patches', 'patch_id', 'raw_content'], memory: ['memory', 'records', 'id', 'body'] }[kind];
      if (!spec) throw fail('INVALID_KIND', 'Unknown source kind');
      value = this.database(spec[0], db => db.prepare(`SELECT substr(coalesce(${spec[3]},''),?,?) text, length(coalesce(${spec[3]},'')) totalLength FROM ${spec[1]} WHERE ${spec[2]} = ?`).get(offset + 1, limit, id));
      if (!value) throw fail('NOT_FOUND', 'Source not found', 404);
    }
    return { ...value, offset, hasMore: offset + limit < value.totalLength, sourceLabel: `${kind}:${id}${kind === 'task' ? `:${field}` : ''}` };
  }
  snapshot() {
    const sources = {}, totals = { tasks: null, messages: null, patches: null, validations: null, memoryRecords: null };
    const data = { recentTasks: [], recentActivity: [], recentEvidence: [], participants: [], exchanges: [], control: { paused: null, changedAt: null, reason: null, activeOperations: 0 } };
    for (const source of ['bridge', 'memory']) {
      const sourcePath = path.join(this.project, source === 'bridge' ? BRIDGE_FILE : MEMORY_FILE);
      try {
        this.database(source, db => {
          if (source === 'memory') totals.memoryRecords = db.prepare('SELECT count(*) n FROM records').get().n;
          else {
            for (const [key, table] of Object.entries({ tasks: 'tasks', messages: 'messages', patches: 'patches', validations: 'task_validations' })) totals[key] = db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
            const hasControl = db.prepare("SELECT 1 FROM sqlite_master WHERE name='bridge_control'").get();
            const c = hasControl ? db.prepare('SELECT * FROM bridge_control WHERE id=1').get() : null;
            data.control = { paused: c ? Boolean(c.paused) : false, changedAt: c?.changed_at ?? null, reason: c?.reason ?? null, activeOperations: 0 };
            data.exchanges = db.prepare('SELECT from_agent, to_agent, count(*) n, max(created_at) last_at FROM messages GROUP BY from_agent,to_agent').all().map(r => ({ from: r.from_agent, to: r.to_agent, count: r.n, lastAt: r.last_at }));
            const ids = db.prepare('SELECT from_agent id FROM tasks UNION SELECT assigned_to FROM tasks UNION SELECT from_agent FROM messages UNION SELECT to_agent FROM messages').all();
            data.participants = ids.map(({ id }) => {
              const stats = db.prepare("SELECT count(*) n, sum(CASE WHEN status IN ('pending','in_progress') THEN 1 ELSE 0 END) active FROM tasks WHERE assigned_to = ?").get(id);
              const models = db.prepare('SELECT DISTINCT required_model,actual_model,json_extract(metadata_json,\'$.role\') role FROM tasks WHERE assigned_to = ?').all(id);
              const last = db.prepare('SELECT max(at) at FROM (SELECT updated_at at FROM tasks WHERE assigned_to=? OR from_agent=? UNION ALL SELECT created_at FROM messages WHERE from_agent=? OR to_agent=?)').get(id, id, id, id).at;
              return { id, label: id, roles: [...new Set(models.map(r => r.role).filter(Boolean))], requiredModels: [...new Set(models.map(r => r.required_model).filter(Boolean))], reportedModels: [...new Set(models.map(r => r.actual_model).filter(Boolean))], lastRecordedAt: last, taskCount: stats.n, activeTaskCount: stats.active || 0 };
            });
          }
        });
        if (source === 'bridge') { data.recentTasks = this.list('tasks').items; data.recentActivity = this.list('activity').items; }
        else data.recentEvidence = this.list('evidence').items;
        sources[source] = { status: 'ready', path: sourcePath, detail: null };
      } catch (error) {
        sources[source] = { status: error.code === 'SOURCE_MISSING' ? 'missing' : error.code === 'SOURCE_UNSUPPORTED' ? 'unsupported' : 'error', path: sourcePath, detail: error.message };
        for (const key of source === 'bridge' ? ['tasks','messages','patches','validations'] : ['memoryRecords']) totals[key] = null;
        if (source === 'bridge') { data.recentTasks = []; data.recentActivity = []; data.participants = []; data.exchanges = []; data.control.paused = null; }
      }
    }
    const documents = this.documents();
    const recordFiles = documents.filter(d => ['controls.md','charter.md','project.md','state.md'].includes(d.id));
    sources.records = { status: recordFiles.some(d => d.error) ? 'error' : recordFiles.some(d => d.exists) ? 'ready' : 'missing', path: this.project, detail: recordFiles.filter(d => !d.exists).map(d => `${d.path}: ${d.error || 'missing'}`).join('; ') || null };
    const preview = id => { try { return this.source(new URLSearchParams({ kind: 'document', id, limit: '1200' })).text; } catch { return null; } };
    return { schemaVersion: 1, mode: 'live', observedAt: new Date().toISOString(), project: { name: path.basename(this.project), path: this.project, question: preview('controls.md'), questionSource: recordFiles.find(d => d.id === 'controls.md')?.exists ? 'controls.md' : null, currentStatePreview: preview('state.md') }, sources, ...data, totals, documents, operations: [], truncated: { tasks: totals.tasks == null ? null : totals.tasks - data.recentTasks.length, activity: totals.messages == null ? null : totals.messages + totals.patches + totals.validations - data.recentActivity.length, evidence: totals.memoryRecords == null ? null : totals.memoryRecords - data.recentEvidence.length } };
  }
}
