import process from "node:process";

const VALID_STATES = new Set(["starting", "ready", "paused", "error"]);

/**
 * Single-writer HealthBoard with in-process ownership handles and cross-process SQLite persistence.
 * Once a handle calls `release()`, further `report()` calls on that stale handle become no-ops.
 */
export class HealthBoard {
  /**
   * @param {object} options
   * @param {import('../domain/memory-repos.mjs').MemoryRepositories} options.repos
   * @param {number} [options.pid]
   * @param {() => Date} [options.clock]
   */
  constructor({ repos, pid = process.pid, clock = () => new Date() }) {
    if (!repos) throw new Error("HealthBoard requires repos");
    this.repos = repos;
    this.pid = Number(pid || 0);
    this.clock = clock;
    this._activeTokens = new Map();
  }

  /**
   * Claim exclusive in-process write ownership for `component`.
   * @param {string} component
   * @param {{ initialState?: 'starting' | 'ready' | 'paused' | 'error', detail?: string }} [options]
   */
  claim(component, { initialState = "starting", detail = "" } = {}) {
    if (!component || typeof component !== "string") {
      throw new Error("HealthBoard.claim requires a non-empty component name");
    }
    const token = Symbol(component);
    this._activeTokens.set(component, token);

    const write = (state, msg = "", consecutiveFailures = 0) => {
      if (this._activeTokens.get(component) !== token) {
        return null;
      }
      const normalizedState = VALID_STATES.has(state) ? state : "error";
      return this.repos.atomic(() =>
        this.repos.putHealth({
          component,
          owner_pid: this.pid,
          state: normalizedState,
          detail: String(msg || ""),
          consecutive_failures: Math.max(0, Number(consecutiveFailures || 0)),
          updated_at: this.clock().toISOString(),
        })
      );
    };

    write(initialState, detail, 0);

    return {
      component,
      report(state, msg = "", consecutiveFailures = 0) {
        return write(state, msg, consecutiveFailures);
      },
      ready(msg = "") {
        return write("ready", msg, 0);
      },
      paused(msg = "") {
        return write("paused", msg, 0);
      },
      error(msg = "", consecutiveFailures = 3) {
        return write("error", msg, consecutiveFailures);
      },
      isActive: () => this._activeTokens.get(component) === token,
      release: () => {
        if (this._activeTokens.get(component) === token) {
          this._activeTokens.delete(component);
          return true;
        }
        return false;
      },
    };
  }

  get(component) {
    return this.repos.getHealth(component);
  }

  snapshot() {
    const components = this.repos.listHealth();
    let overall = "ready";
    if (components.some((c) => c.state === "error")) {
      overall = "error";
    } else if (components.some((c) => c.state === "paused")) {
      overall = "paused";
    } else if (
      components.length === 0 ||
      components.some((c) => c.state === "starting")
    ) {
      overall = components.length === 0 ? "idle" : "starting";
    }
    return {
      overall,
      components,
    };
  }
}
