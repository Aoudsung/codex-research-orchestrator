import fs from 'node:fs';
import { fail, numberParam, pageOptions, pageResult, PREVIEW } from './reader.mjs';

export class DemoReader {
  constructor(fixture = new URL('./public/demo-data.json', import.meta.url)) {
    this.data = JSON.parse(fs.readFileSync(fixture, 'utf8'));
    for (const key of ['tasks', 'messages', 'patches', 'validations', 'evidence', 'documents', 'routes']) {
      if (!Array.isArray(this.data[key])) throw new Error(`Invalid demo fixture: ${key} must be an array`);
    }
    this.control = { paused: false, changedAt: null, reason: null, activeOperations: 0 };
  }
  records(resource) {
    if (resource === 'activity') return ['messages', 'patches', 'validations'].flatMap(key => this.data[key].map(r => ({
      id: r.id, seq: r.seq, kind: { messages: 'message', patches: 'patch', validations: 'validation' }[key], taskId: r.taskId,
      actor: r.fromAgent || r.actor, recipient: r.toAgent || null, title: r.subject || r.kind || 'Validation', preview: r.preview || r.summary || '', status: r.status ?? (r.passed == null ? null : r.passed ? 'passed' : 'failed'), createdAt: r.createdAt, source: 'demo' })));
    if (!this.data[resource]) throw fail('NOT_FOUND', 'Unknown resource', 404);
    return this.data[resource];
  }
  list(resource, params = new URLSearchParams()) {
    const { filters: f, cursor, limit, signature } = pageOptions(resource, params);
    const key = r => resource === 'tasks' ? r.createdAt : resource === 'evidence' ? r.id : r.seq;
    const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
    let rows = this.records(resource).filter(r => (!f.taskId || r.taskId === f.taskId) && (!f.phase || r.phase === f.phase) && (!f.kind || r.kind === f.kind) && (!f.state || r.recordState === f.state) && (!f.agent || [r.fromAgent, r.toAgent, r.assignedTo].includes(f.agent)) && (!f.query || [r.title, r.prompt, r.promptPreview, r.subject, r.content, r.preview, r.body, r.summary].join(' ').toLowerCase().includes(f.query.toLowerCase())));
    rows.sort((a, b) => compare(key(b), key(a)) || compare(b.id, a.id));
    if (cursor) rows = rows.filter(r => compare(key(r), cursor.key) < 0 || (compare(key(r), cursor.key) === 0 && compare(r.id, cursor.id) < 0));
    const shown = rows.slice(0, limit);
    return pageResult(shown.map(r => {
      const { prompt, result, error, content, body, text, ...summary } = r;
      if (resource === 'tasks') Object.assign(summary, { promptPreview: (prompt || r.promptPreview || '').slice(0, PREVIEW), resultPreview: (result || r.resultPreview || '').slice(0, PREVIEW) || null, errorPreview: (error || r.errorPreview || '').slice(0, PREVIEW) || null });
      if (resource === 'messages') Object.assign(summary, { preview: (content || r.preview || '').slice(0, PREVIEW), charLength: content?.length ?? r.charLength });
      return summary;
    }), rows.length > limit, shown.length ? { key: key(shown.at(-1)), id: shown.at(-1).id } : null, signature);
  }
  rawTask(id) { const task = this.data.tasks.find(t => t.id === id); if (!task) throw fail('NOT_FOUND', 'Task not found', 404); return task; }
  task(id) {
    const raw = this.rawTask(id);
    const { prompt, result, error, ...task } = raw;
    Object.assign(task, { promptPreview: (prompt || raw.promptPreview || '').slice(0, PREVIEW), resultPreview: (result || raw.resultPreview || '').slice(0, PREVIEW) || null, errorPreview: (error || raw.errorPreview || '').slice(0, PREVIEW) || null });
    const children = {}, limits = {};
    for (const key of ['messages', 'patches', 'validations']) { children[key] = this.list(key, new URLSearchParams({ taskId: id })).items; limits[key] = this.data[key].filter(r => r.taskId === id).length - children[key].length; }
    return { task, ...children, limits, operation: null, route: this.data.routes.find(r => r.taskId === id) || null };
  }
  source(params) {
    const kind = params.get('kind'), id = params.get('id');
    const field = params.get('field') ?? 'prompt';
    if (kind === 'task' && !['prompt', 'result', 'error'].includes(field)) throw fail('INVALID_FIELD', 'Task source field must be prompt, result, or error');
    const spec = { task: ['tasks', field], message: ['messages', 'content'], patch: ['patches', 'content'], memory: ['evidence', 'body'], document: ['documents', 'text'] }[kind];
    if (!spec) throw fail('INVALID_KIND', 'Unknown source kind');
    const row = this.data[spec[0]].find(r => String(r.id) === id);
    if (!row) throw fail('NOT_FOUND', 'Source not found', 404);
    const text = row[spec[1]] || '', offset = numberParam(params.get('offset'), 0, Number.MAX_SAFE_INTEGER), limit = numberParam(params.get('limit'), 16000, 64000);
    const characters = Array.from(text);
    return { text: characters.slice(offset, offset + limit).join(''), offset, totalLength: characters.length, hasMore: offset + limit < characters.length, sourceLabel: `Demo ${kind}:${id}${kind === 'task' ? `:${field}` : ''}` };
  }
  snapshot() {
    const tasks = this.data.tasks, messages = this.data.messages;
    const ids = [...new Set([...tasks.flatMap(t => [t.fromAgent, t.assignedTo]), ...messages.flatMap(m => [m.fromAgent, m.toAgent])])].filter(Boolean);
    const participants = ids.map(id => {
      const own = tasks.filter(t => t.assignedTo === id);
      return { id, label: id, roles: [...new Set(own.map(t => t.role).filter(Boolean))], requiredModels: [...new Set(own.map(t => t.requiredModel).filter(Boolean))], reportedModels: [...new Set(own.map(t => t.actualModel).filter(Boolean))], lastRecordedAt: [...tasks.filter(t => [t.fromAgent,t.assignedTo].includes(id)).map(t => t.updatedAt), ...messages.filter(m => [m.fromAgent,m.toAgent].includes(id)).map(m => m.createdAt)].filter(Boolean).sort().at(-1) || null, taskCount: own.length, activeTaskCount: own.filter(t => ['pending','in_progress'].includes(t.status)).length };
    });
    const exchanges = [];
    for (const m of messages) { let edge = exchanges.find(e => e.from === m.fromAgent && e.to === m.toAgent); if (!edge) exchanges.push(edge = { from: m.fromAgent, to: m.toAgent, count: 0, lastAt: null }); edge.count++; if (!edge.lastAt || edge.lastAt < m.createdAt) edge.lastAt = m.createdAt; }
    const recentTasks = this.list('tasks').items, recentActivity = this.list('activity').items, recentEvidence = this.list('evidence').items;
    return { schemaVersion: 1, mode: 'demo', observedAt: new Date().toISOString(), project: this.data.project,
      sources: Object.fromEntries(['bridge','memory','records'].map(k => [k, { status: 'ready', path: null, detail: 'Fictional in-memory demo fixture' }])), control: { ...this.control }, totals: { tasks: tasks.length, messages: messages.length, patches: this.data.patches.length, validations: this.data.validations.length, memoryRecords: this.data.evidence.length }, participants, exchanges, recentTasks, recentActivity, recentEvidence, operations: [], documents: this.data.documents.map(({ text, ...d }) => d), truncated: { tasks: tasks.length - recentTasks.length, activity: this.records('activity').length - recentActivity.length, evidence: this.data.evidence.length - recentEvidence.length } };
  }
}
