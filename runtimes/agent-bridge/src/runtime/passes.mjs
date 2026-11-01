/**
 * Coalesced Serial Passes Pump (modeled on dsh-superagent-prototype `passes.ts`).
 *
 * Runs registered passes sequentially on a periodic tick (default 2000ms) AND on-demand
 * via `kick()` (e.g. from SQLite `afterCommit` or `fs.watch`). Concurrent `kick()` calls
 * while a pass is already running coalesce into a single immediate `pumpAgain` turn.
 */
export class PassesPump {
  /**
   * @param {object} options
   * @param {Array<{ name: string, run: () => Promise<unknown> | unknown }>} [options.passes]
   * @param {number} [options.intervalMs]
   * @param {(passName: string, err: unknown) => void} [options.onError]
   */
  constructor({
    passes = [],
    intervalMs = 2000,
    onError = null,
  } = {}) {
    this.passes = [...passes];
    this.intervalMs = Math.max(100, Math.floor(Number(intervalMs) || 2000));
    this.onError = onError;
    this._running = false;
    this._pumpAgain = false;
    this._stopped = false;
    this._timer = null;
    this._activePromise = null;
  }

  addPass(name, run) {
    this.passes.push({ name, run });
  }

  start() {
    this._stopped = false;
    if (!this._timer) {
      this._timer = setInterval(() => {
        this.kick();
      }, this.intervalMs);
      if (typeof this._timer.unref === "function") {
        this._timer.unref();
      }
    }
    return this.kick();
  }

  kick() {
    if (this._stopped) return Promise.resolve();
    if (this._running) {
      this._pumpAgain = true;
      return this._activePromise || Promise.resolve();
    }
    this._activePromise = this._drainLoop();
    return this._activePromise;
  }

  async _drainLoop() {
    this._running = true;
    try {
      do {
        this._pumpAgain = false;
        for (const pass of this.passes) {
          if (this._stopped) break;
          try {
            await pass.run();
          } catch (err) {
            if (typeof this.onError === "function") {
              try {
                this.onError(pass.name, err);
              } catch {
                // ignore
              }
            }
          }
        }
      } while (this._pumpAgain && !this._stopped);
    } finally {
      this._running = false;
      this._activePromise = null;
    }
  }

  async stop() {
    this._stopped = true;
    this._pumpAgain = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (this._activePromise) {
      try {
        await this._activePromise;
      } catch {
        // ignore
      }
    }
  }
}
