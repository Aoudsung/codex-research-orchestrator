import fs from 'node:fs';
import path from 'node:path';

/** Project defaults only apply to newly created tasks; existing task contracts remain immutable. */
export function projectWorkflowDefaults(cwd) {
  let root = path.resolve(cwd);
  while (true) {
    const file = path.join(root, '.research-orchestrator', 'workflow.json');
    if (fs.existsSync(file)) {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (value.version !== 1 || !Array.isArray(value.forbiddenOperations || [])) throw new Error('Invalid project workflow defaults');
      return { contract: value.contract || {}, forbiddenOperations: value.forbiddenOperations || [], source: file };
    }
    const parent = path.dirname(root);
    if (parent === root) return { contract: {}, forbiddenOperations: [], source: null };
    root = parent;
  }
}
