import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { registerResearchMemoryTools } from '../src/core/research-memory-tools.mjs';
import { validateToolArguments } from '../src/core/mcp-server.mjs';

const bundledHelper = fileURLToPath(new URL('../../../skills/codex-research-orchestrator/scripts/research_memory.py', import.meta.url));
const siblingProjectDir = fileURLToPath(new URL('../../../project', import.meta.url));
const siblingHelpers = fs.existsSync(siblingProjectDir) && fs.statSync(siblingProjectDir).isDirectory()
  ? fs.readdirSync(siblingProjectDir).map(name => path.join(siblingProjectDir, name, 'packages/codex-research-orchestrator/skills/codex-research-orchestrator/scripts/research_memory.py'))
  : [];
const helper = [bundledHelper, ...siblingHelpers].find(candidate => fs.existsSync(candidate)) || bundledHelper;
const python = process.env.RESEARCH_MEMORY_PYTHON || 'python3';

function fixture(t) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'research-memory-tools-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  fs.writeFileSync(path.join(project, 'controls.md'), 'Synthetic research: no model or experiment execution.\n');
  execFileSync(python, [helper, '--project', project, 'api', 'init'], { input: JSON.stringify({ controls: ['controls.md'] }) });
  const tools = new Map();
  const server = { registerTool(definition, handler) { tools.set(definition.name, { definition, handler }); } };
  assert.equal(registerResearchMemoryTools(server, { projectRoot: project, python, caller: 'test-agent' }), true);
  return { project, tools, call: (name, args) => tools.get(`research_${name}`).handler(args) };
}

test('tools require an explicitly bound project and advertise only the five research operations', t => {
  const tools = new Map();
  assert.equal(registerResearchMemoryTools({ registerTool: x => tools.set(x.name, x) }, { projectRoot: '' }), false);
  assert.equal(tools.size, 0);
  const f = fixture(t);
  assert.deepEqual([...f.tools.keys()], ['research_record', 'research_search', 'research_read', 'research_context', 'research_export']);
  const schema = f.tools.get('research_read').definition.inputSchema;
  assert.equal(validateToolArguments('research_read', schema, { id: 1, projectRoot: '/elsewhere' }).valid, false);
  assert.throws(() => registerResearchMemoryTools({}, { projectRoot: path.join(f.project, 'missing') }), /ENOENT/);
});

test('all five handlers use real SQLite without source documents or provider execution', async t => {
  const f = fixture(t);
  const body = '偏差 Γ 条件推导 $(touch SHOULD_NOT_EXIST)\n' + '完整论证。'.repeat(1500);
  const input = { kind: 'evidence', title: '同信息偏差', summary: '严格条件下的结果', scope: 'Synthetic Gaussian example only', body,
    topic: 'question-1', round: 'round-1', external_key: 'synthetic-message:1', aliases: ['bias'] };
  const saved = await f.call('record', input);
  assert.ok(saved.id > 0);
  assert.equal((await f.call('record', input)).id, saved.id);
  const hits = await f.call('search', { query: '偏差', topic: 'question-1' });
  assert.equal(hits.results[0].id, saved.id);
  const alias = await f.call('search', { query: 'bias' });
  assert.equal(alias.results[0].id, saved.id);
  const first = await f.call('read', { id: saved.id });
  assert.equal(first.author, 'test-agent');
  assert.equal([...first.body].length, 6000);
  const next = await f.call('read', { id: saved.id, offset: first.next_offset, limit: 20000 });
  assert.equal(first.body + next.body, body);
  const context = await f.call('context', { query: '偏差', required: [saved.id], max_chars: 20000 });
  assert.ok(context.text.includes(body));
  const output = await f.call('export', { format: 'jsonl', output: 'records.jsonl' });
  assert.equal(output.path, 'records.jsonl');
  assert.ok(fs.readFileSync(path.join(f.project, output.path), 'utf8').includes('同信息偏差'));
  assert.equal(fs.existsSync(path.join(f.project, 'SHOULD_NOT_EXIST')), false);
  assert.deepEqual(fs.readdirSync(f.project).sort(), ['.research-memory', 'controls.md', 'records.jsonl']);
});

test('handler errors preserve invalid ranges, core failures and unsafe export paths', async t => {
  const f = fixture(t);
  assert.throws(() => f.call('read', { id: 1, limit: 20001 }), /limit must/);
  assert.throws(() => f.call('read', { id: 1, offset: 0.5 }), /offset must/);
  assert.throws(() => f.call('export', { format: 'jsonl' }), /output path/);
  await assert.rejects(f.call('read', { id: 999 }), /Unknown record ID/);
  await assert.rejects(f.call('export', { format: 'jsonl', output: '../escaped.jsonl' }), /Path escapes/);
  const output = await f.call('export', { format: 'markdown', output: 'view.md' });
  assert.equal(output.path, 'view.md');
  await assert.rejects(f.call('export', { format: 'markdown', output: 'view.md' }), /exist/i);
});

test('independent context excludes prior evaluations and fails instead of truncating required material', async t => {
  const f = fixture(t);
  const evidence = await f.call('record', { kind: 'evidence', title: '原始材料', summary: '可公开事实', scope: 'Synthetic', body: 'alpha 原始证据' });
  await f.call('record', { kind: 'evaluation', title: '隐藏评价', summary: '不应传给独立审阅者', scope: 'Synthetic', body: 'SECRET_PRIOR_REVIEW alpha' });
  const proposal = await f.call('record', { kind: 'proposal', title: '待审方案', summary: '完整待审文本', scope: 'Synthetic', body: 'alpha 完整待审方案' });
  const context = await f.call('context', { profile: 'review', query: 'alpha', allow: [evidence.id, proposal.id], target: proposal.id, required: [evidence.id], max_chars: 2000 });
  assert.ok(context.text.includes('完整待审方案'));
  assert.equal(context.text.includes('SECRET_PRIOR_REVIEW'), false);
  await assert.rejects(f.call('context', { profile: 'review', allow: [evidence.id, proposal.id], target: proposal.id, required: [evidence.id], max_chars: 10 }), /exceed/);
});
