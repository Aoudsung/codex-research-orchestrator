export const FAILURES_BEFORE_ERROR = 3;
export const MIN_BACKOFF_MS = 2000;
export const MAX_BACKOFF_MS = 60000;

/**
 * Control-flow deferral signal thrown by Effect handlers when execution should be
 * rescheduled (e.g. bridge is paused, quiet window not settled, or normal worker slots are full)
 * WITHOUT incrementing failure `attempts` or degrading component health.
 */
export class Later extends Error {
  /**
   * @param {number} [delayMs]
   * @param {string} [reason]
   */
  constructor(delayMs = 2000, reason = "deferred") {
    super(reason);
    this.name = "Later";
    this.delayMs = Math.max(25, Math.floor(Number(delayMs) || 2000));
    this.reason = reason;
  }
}

/**
 * Compute bounded exponential backoff in `[2000ms, 60000ms]`.
 * @param {number} attempts - 1-based failure attempt count
 */
export function computeBackoffMs(attempts) {
  const exp = Math.max(0, Number(attempts || 1) - 1);
  return Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * Math.pow(2, exp));
}

/**
 * Durable Effects Queue runner backed by `MemoryRepositories` or `SqliteStore`.
 *
 * Key invariants (inspired by dsh-superagent-prototype `effects.ts`):
 * 1. Coalescing by `(kind, effect_key)` increments `generation` and resets `attempts = 0`.
 * 2. Completion deletes ONLY when `(kind, effect_key, seq, generation)` still match—preventing
 *    an finishing attempt from deleting newer coalesced payloads that arrived mid-flight.
 * 3. `Later` reschedules `due_ms` without incrementing `attempts`.
 * 4. Real failures apply `[2s, 60s]` exponential backoff and trip `HealthBoard` `error` only at `FAILURES_BEFORE_ERROR = 3`.
 */
export class EffectsQueue {
  /**
   * @param {object} options
   * @param {import('../domain/memory-repos.mjs').MemoryRepositories} options.repos
   * @param {Record<string, (effect: object) => Promise<unknown> | unknown>} [options.handlers]
   * @param {{ report: (state: string, detail?: string, failures?: number) => void } | null} [options.healthHandle]
   * @param {() => number} [options.clock]
   */
  constructor({
    repos,
    handlers = {},
    healthHandle = null,
    clock = () => Date.now(),
  }) {
    if (!repos) throw new Error("EffectsQueue requires repos");
    this.repos = repos;
    this.handlers = { ...handlers };
    this.healthHandle = healthHandle;
    this.clock = clock;
  }

  registerHandler(kind, handler) {
    this.handlers[kind] = handler;
  }

  enqueue({
    kind,
    effectKey,
    payload = {},
    priority = "normal",
    dueMs = this.clock(),
  }) {
    return this.repos.atomic(() =>
      this.repos.enqueueEffect({
        kind,
        effectKey,
        payload,
        priority,
        dueMs,
        nowIso: new Date(this.clock()).toISOString(),
      })
    );
  }

  listPending({ kind = null, limit = 100 } = {}) {
    return this.repos.listEffects({ kind, limit });
  }

  async drainDue({ limit = 25, nowMs = this.clock() } = {}) {
    const dueEffects = this.repos.listEffects({
      dueBeforeMs: nowMs,
      limit,
    });

    const summary = {
      inspected: dueEffects.length,
      completed: 0,
      deferred: 0,
      failed: 0,
      preservedNewerGeneration: 0,
      outcomes: [],
    };

    for (const effect of dueEffects) {
      const handler = this.handlers[effect.kind];
      if (typeof handler !== "function") {
        continue;
      }

      try {
        await handler(effect);
        const deleted = this.repos.atomic(() =>
          this.repos.completeEffect({
            kind: effect.kind,
            effectKey: effect.effect_key,
            seq: effect.seq,
            generation: effect.generation,
          })
        );
        if (deleted) {
          summary.completed += 1;
        } else {
          summary.preservedNewerGeneration += 1;
        }
        if (this.healthHandle) {
          this.healthHandle.report("ready", "", 0);
        }
        summary.outcomes.push({
          kind: effect.kind,
          effectKey: effect.effect_key,
          status: deleted ? "completed" : "coalesced_newer_generation",
        });
      } catch (err) {
        if (err instanceof Later) {
          const nextDue = this.clock() + err.delayMs;
          this.repos.atomic(() =>
            this.repos.deferEffect({
              kind: effect.kind,
              effectKey: effect.effect_key,
              seq: effect.seq,
              generation: effect.generation,
              dueMs: nextDue,
              incrementAttempts: false,
              lastError: err.reason,
            })
          );
          summary.deferred += 1;
          summary.outcomes.push({
            kind: effect.kind,
            effectKey: effect.effect_key,
            status: "deferred",
            reason: err.reason,
            nextDueMs: nextDue,
          });
          continue;
        }

        const nextAttempts = Number(effect.attempts || 0) + 1;
        const backoffMs = computeBackoffMs(nextAttempts);
        const nextDue = this.clock() + backoffMs;
        const errMsg = err?.message || String(err);

        this.repos.atomic(() =>
          this.repos.deferEffect({
            kind: effect.kind,
            effectKey: effect.effect_key,
            seq: effect.seq,
            generation: effect.generation,
            dueMs: nextDue,
            incrementAttempts: true,
            lastError: errMsg,
          })
        );

        summary.failed += 1;
        if (this.healthHandle && nextAttempts >= FAILURES_BEFORE_ERROR) {
          this.healthHandle.report(
            "error",
            `${effect.kind}(${effect.effect_key}) failed ${nextAttempts}x: ${errMsg}`,
            nextAttempts
          );
        }
        summary.outcomes.push({
          kind: effect.kind,
          effectKey: effect.effect_key,
          status: "failed",
          attempts: nextAttempts,
          backoffMs,
          error: errMsg,
        });
      }
    }

    return summary;
  }
}
