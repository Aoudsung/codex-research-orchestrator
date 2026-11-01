import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const string = { type: 'string' };
const ids = { type: 'array', items: { type: 'integer', minimum: 1 } };
const kinds = ['source', 'evidence', 'claim', 'decision', 'evaluation', 'checkpoint', 'proposal', 'question'];
const profiles = { type: 'string', enum: ['resume', 'analysis', 'review'] };
const filters = Object.fromEntries(['topic', 'round', 'author', 'state', 'claim_status', 'object_key'].map(key => [key, string]));
const schemas = {
  record: {
    required: ['kind', 'title', 'summary', 'scope', 'body'],
    properties: {
      kind: { type: 'string', enum: kinds }, title: string, summary: string, scope: string, body: string,
      author: string, topic: string, round: string, origin: string, external_key: string, object_key: string,
      aliases: { type: 'array', items: string }, claim_status: { type: 'string', enum: ['conjecture', 'derived', 'supported', 'refuted'] },
      depends_on: ids, relations: { type: 'array', items: { type: 'object', additionalProperties: false,
        required: ['type', 'target'], properties: { type: { type: 'string', enum: ['depends_on', 'supports', 'refutes', 'limits', 'conflicts'] }, target: { type: 'integer', minimum: 1 } } } },
      supersedes: { type: 'integer', minimum: 1 }, expected_revision: { type: 'integer', minimum: 1 }, reason: string,
    },
  },
  search: { properties: { query: string, limit: { type: 'integer', minimum: 1, maximum: 100 },
    kind: { type: 'string', enum: kinds }, ...filters, include_history: { type: 'boolean' }, profile: profiles, allow: ids, target: { type: 'integer', minimum: 1 } } },
  read: { required: ['id'], properties: { id: { type: 'integer', minimum: 1 }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 20000 } } },
  context: { properties: { query: string, profile: profiles, max_chars: { type: 'integer', minimum: 1, maximum: 100000 }, allow: ids, required: ids, target: { type: 'integer', minimum: 1 } } },
  export: { required: ['format', 'output'], properties: { format: { type: 'string', enum: ['jsonl', 'markdown'] }, ids,
    output: { type: 'string', description: 'New project-relative output path; the response returns its location instead of the exported body.' } } },
};
const descriptions = {
  record: 'Save complete research text directly to the project SQLite database. Keep conditions and sources; revisions require explicit supersession and reason. Reuse external_key when retrying the same result.',
  search: 'Find compact research records, including status, scope and provenance. Chinese short queries and aliases are supported; select historical records explicitly when needed.',
  read: 'Read an exact research record version with provenance, in Unicode character pages. Default page is 6000 characters; request subsequent offsets to read the complete record.',
  context: 'Assemble bounded task context with current controls, complete required evidence, and allowed material. Independent analysis/review requires an explicit allowlist; judgments outside that list stay excluded.',
  export: 'Export project research to a new Markdown or lossless JSONL file. Exported documents are derived views, not a second editable source of truth.',
};

function bounded(value, fallback, minimum, maximum, name) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < minimum || result > maximum) throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  return result;
}

function invoke(python, helper, project, operation, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [helper, '--project', project, 'api', operation], { cwd: project, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', bytes = 0, failure;
    const timer = setTimeout(() => { failure = new Error('Research memory operation timed out after 60 seconds'); child.kill(); }, 60000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 16 * 1024 * 1024) { failure = new Error('Research memory response exceeded 16 MiB; use a bounded read or file export'); child.kill(); }
      else stdout += chunk;
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16000); });
    child.on('error', error => { clearTimeout(timer); reject(new Error(`Cannot launch research memory Python: ${error.message}`)); });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error(`Research memory ${operation} failed (exit ${code}): ${stderr.trim() || stdout.trim()}`));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`Research memory returned invalid JSON: ${stdout.slice(0, 300)}`)); }
    });
    child.stdin.on('error', error => { failure = new Error(`Cannot send research memory input: ${error.message}`); });
    child.stdin.end(JSON.stringify(payload));
  });
}

export function registerResearchMemoryTools(server, {
  projectRoot = process.env.RESEARCH_MEMORY_PROJECT,
  python = process.env.RESEARCH_MEMORY_PYTHON || 'python3',
  caller = process.env.MCP_CALLER_AGENT || 'codex',
} = {}) {
  if (!projectRoot) return false;
  const project = fs.realpathSync(projectRoot);
  if (!fs.statSync(project).isDirectory()) throw new Error('RESEARCH_MEMORY_PROJECT must be an existing directory');
  const installed = path.join(project, '.agents/skills/codex-research-orchestrator/scripts/research_memory.py');
  const workspacePkg = path.join(project, 'packages/codex-research-orchestrator/skills/codex-research-orchestrator/scripts/research_memory.py');
  const bundled = fileURLToPath(new URL('../../../../skills/codex-research-orchestrator/scripts/research_memory.py', import.meta.url));
  const siblingProjectDir = fileURLToPath(new URL('../../../../project', import.meta.url));
  const siblingCandidates = fs.existsSync(siblingProjectDir) && fs.statSync(siblingProjectDir).isDirectory()
    ? fs.readdirSync(siblingProjectDir).map(name => path.join(siblingProjectDir, name, 'packages/codex-research-orchestrator/skills/codex-research-orchestrator/scripts/research_memory.py'))
    : [];
  const helper = [installed, workspacePkg, bundled, ...siblingCandidates].find(candidate => fs.existsSync(candidate)) || bundled;
  if (!fs.existsSync(helper)) throw new Error('Research memory Python helper is missing; install the project skill');
  for (const operation of Object.keys(schemas)) {
    server.registerTool({ name: `research_${operation}`, description: descriptions[operation],
      inputSchema: { type: 'object', additionalProperties: false, ...schemas[operation] } }, args => {
      const payload = { ...args };
      if (operation === 'record' && !payload.author) payload.author = caller;
      if (operation === 'read') {
        payload.offset = bounded(payload.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset');
        payload.limit = bounded(payload.limit, 6000, 1, 20000, 'limit');
      }
      if (operation === 'search') payload.limit = bounded(payload.limit, 10, 1, 100, 'limit');
      if (operation === 'context') payload.max_chars = bounded(payload.max_chars, 12000, 1, 100000, 'max_chars');
      if (operation === 'export' && (typeof payload.output !== 'string' || !payload.output.trim())) throw new Error('A project-relative export output path is required');
      return invoke(python, helper, project, operation, payload);
    });
  }
  return true;
}
