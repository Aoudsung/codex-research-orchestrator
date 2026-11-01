import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

/**
 * Resolve active `controls.md` path for a project:
 * 1) `config.controls` declared in `.research-memory/memory.sqlite3` (e.g. `references/project/controls.md`)
 * 2) `<projectRoot>/controls.md`
 * 3) `<projectRoot>/.research-memory/controls.md`
 */
export function resolveProjectControlsPath(projectRoot) {
  if (!projectRoot) return null;
  const root = path.resolve(projectRoot);
  const withinRoot = (candidate) => {
    const resolved = path.resolve(root, candidate);
    return resolved !== root && resolved.startsWith(root + path.sep) ? resolved : null;
  };
  try {
    const memFile = path.join(root, ".research-memory", "memory.sqlite3");
    if (fs.existsSync(memFile) && fs.statSync(memFile).isFile()) {
      const db = new DatabaseSync(memFile, { readOnly: true });
      try {
        db.exec("PRAGMA query_only = ON");
        const row = db.prepare("SELECT value FROM config WHERE key = 'controls'").get();
        const list = row?.value ? JSON.parse(row.value) : [];
        if (Array.isArray(list)) {
          for (const rel of list) {
            if (typeof rel !== "string" || !rel || path.isAbsolute(rel)) continue;
            const target = withinRoot(rel);
            if (target && fs.existsSync(target) && fs.statSync(target).isFile()) {
              return target;
            }
          }
        }
      } finally {
        db.close();
      }
    }
  } catch {
    // Fall through to standard file locations
  }
  for (const rel of ["controls.md", path.join(".research-memory", "controls.md")]) {
    const target = withinRoot(rel);
    if (target && fs.existsSync(target) && fs.statSync(target).isFile()) {
      return target;
    }
  }
  return path.join(root, "controls.md");
}

/**
 * Discover `.research-memory` project root without creating or mutating directories.
 */
export function resolveResearchProjectRoot({
  explicitRoot = null,
  dbPath = null,
} = {}) {
  const candidates = [];
  if (explicitRoot) candidates.push(path.resolve(explicitRoot));
  if (process.env.RESEARCH_PROJECT_ROOT) {
    candidates.push(path.resolve(process.env.RESEARCH_PROJECT_ROOT));
  }

  if (dbPath) {
    let cur = path.dirname(path.resolve(dbPath));
    for (let depth = 0; depth < 5; depth++) {
      candidates.push(cur);
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }

  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, ".research-memory"))) {
        return dir;
      }
      // Check workspace layout `<workspace>/project/<repo>/.research-memory`
      const projectDir = path.join(dir, "project");
      if (fs.existsSync(projectDir) && fs.statSync(projectDir).isDirectory()) {
        const matches = fs
          .readdirSync(projectDir)
          .map((name) => path.join(projectDir, name))
          .filter((sub) => {
            try {
              return fs.existsSync(path.join(sub, ".research-memory"));
            } catch {
              return false;
            }
          });
        if (matches.length === 1) {
          return matches[0];
        }
      }
    } catch {
      // ignore
    }
  }
  return explicitRoot ? path.resolve(explicitRoot) : null;
}

/**
 * Research Router Runtime Service.
 * Watches `.research-memory/controls.md` & `bridge_control.router_mode`,
 * atomically synchronizing `control_version` and emitting non-destructive `control_notice` effects.
 */
export class RouterService {
  /**
   * @param {object} options
   * @param {import('../domain/engine.mjs').BridgeEngine} options.engine
   * @param {import('./health-board.mjs').HealthBoard | null} [options.healthBoard]
   * @param {string | null} [options.projectRoot]
   * @param {string | null} [options.dbPath]
   */
  constructor({
    engine,
    healthBoard = null,
    projectRoot = null,
    dbPath = null,
  }) {
    this.engine = engine;
    this.projectRoot = resolveResearchProjectRoot({
      explicitRoot: projectRoot,
      dbPath,
    });
    this.controlsPath = resolveProjectControlsPath(this.projectRoot);
    this.health = healthBoard
      ? healthBoard.claim("router", { initialState: "starting" })
      : null;
    this._lastControlsMtimeMs = -1;
    this._lastSyncedVersion = "";
  }

  syncOnce({ force = false } = {}) {
    try {
      const ctrlState = this.engine.getControlState();
      if (ctrlState.paused) {
        this.health?.paused(ctrlState.reason || "Bridge paused");
        return { synced: false, paused: true, control: ctrlState };
      }

      let controlsText = null;
      if (this.controlsPath && fs.existsSync(this.controlsPath)) {
        const st = fs.statSync(this.controlsPath);
        if (force || st.mtimeMs !== this._lastControlsMtimeMs) {
          controlsText = fs.readFileSync(this.controlsPath, "utf8");
          this._lastControlsMtimeMs = st.mtimeMs;
        }
      } else if (force && this._lastControlsMtimeMs === -1) {
        controlsText = "";
        this._lastControlsMtimeMs = 0;
      }

      let outcome = {
        changed: false,
        control: ctrlState,
        notices: [],
      };
      if (controlsText !== null) {
        outcome = this.engine.syncPolicy({ controlsText });
      }

      this._lastSyncedVersion = outcome.control.controlVersion;
      this.health?.ready(
        `mode=${outcome.control.routerMode} version=${outcome.control.controlVersion}`
      );
      return {
        synced: true,
        ...outcome,
      };
    } catch (err) {
      this.health?.error(err?.message || String(err), 1);
      throw err;
    }
  }

  stop() {
    this.health?.release();
  }
}
