import { Later } from "../store/effects-queue.mjs";

/**
 * Worker concurrency slot scheduler with `maxWorkers` normal slots PLUS `+1` reserved
 * `human_priority` slot for `userInitiated: true` interactions.
 *
 * When background tasks saturate all normal slots:
 * - Normal dispatches throw `Later` and wait cleanly as `working/queued`.
 * - User-initiated dispatches immediately acquire the `+1` human-priority slot (and preempt
 *   normal slots if queued behind another human-priority turn).
 */
export class SlotScheduler {
  /**
   * @param {object} [options]
   * @param {number} [options.maxWorkers]
   * @param {number} [options.deferDelayMs]
   * @param {() => number} [options.clock]
   */
  constructor({
    maxWorkers = Number(process.env.BRIDGE_MAX_WORKERS || 3),
    deferDelayMs = 1500,
    clock = () => Date.now(),
  } = {}) {
    this.maxWorkers = Math.max(1, Math.floor(Number(maxWorkers) || 3));
    this.deferDelayMs = Math.max(100, Math.floor(Number(deferDelayMs) || 1500));
    this.clock = clock;
    this._normalSlots = new Map(); // slotId -> { key, acquiredAt, userInitiated }
    this._humanSlot = null; // { slotId, key, acquiredAt, userInitiated: true } | null
    this._pendingHumanDemand = 0;
    this._counter = 0;
  }

  /**
   * Acquire an execution slot or throw `Later` if capacity is currently saturated.
   * @param {string} key
   * @param {{ userInitiated?: boolean }} [options]
   */
  acquire(key, { userInitiated = false } = {}) {
    const slotId = `slot_${++this._counter}`;
    const now = this.clock();

    if (userInitiated) {
      // Prefer a free normal slot if available, else immediately use the +1 reserved human slot
      if (this._normalSlots.size < this.maxWorkers) {
        const entry = {
          slotId,
          pool: "normal",
          key,
          userInitiated: true,
          acquiredAt: now,
        };
        this._normalSlots.set(slotId, entry);
        return this._makeLease(entry);
      }

      if (!this._humanSlot) {
        const entry = {
          slotId,
          pool: "human_priority",
          key,
          userInitiated: true,
          acquiredAt: now,
        };
        this._humanSlot = entry;
        return this._makeLease(entry);
      }

      // Both normal pool and +1 human slot are currently occupied by active turns:
      // Signal pending human demand so normal tasks yield as soon as a slot frees up
      this._pendingHumanDemand += 1;
      throw new Later(
        Math.min(500, this.deferDelayMs),
        "human_priority_slot_busy"
      );
    }

    // Normal background dispatch: yield if human-priority demand is waiting or normal pool is full
    if (this._pendingHumanDemand > 0) {
      throw new Later(this.deferDelayMs, "yielding_to_human_priority");
    }
    if (this._normalSlots.size >= this.maxWorkers) {
      throw new Later(this.deferDelayMs, "worker_slots_full");
    }

    const entry = {
      slotId,
      pool: "normal",
      key,
      userInitiated: false,
      acquiredAt: now,
    };
    this._normalSlots.set(slotId, entry);
    return this._makeLease(entry);
  }

  _makeLease(entry) {
    let released = false;
    return {
      ...entry,
      release: () => {
        if (released) return false;
        released = true;
        if (entry.userInitiated && this._pendingHumanDemand > 0) {
          this._pendingHumanDemand = Math.max(0, this._pendingHumanDemand - 1);
        }
        if (entry.pool === "human_priority") {
          if (this._humanSlot?.slotId === entry.slotId) {
            this._humanSlot = null;
          }
        } else {
          this._normalSlots.delete(entry.slotId);
        }
        return true;
      },
    };
  }

  /**
   * Execute `fn` inside an acquired slot, releasing deterministically on completion or error.
   */
  async runWithSlot(key, { userInitiated = false } = {}, fn) {
    const lease = this.acquire(key, { userInitiated });
    if (userInitiated && this._pendingHumanDemand > 0) {
      this._pendingHumanDemand = Math.max(0, this._pendingHumanDemand - 1);
    }
    try {
      return await fn(lease);
    } finally {
      lease.release();
    }
  }

  status() {
    return {
      maxWorkers: this.maxWorkers,
      humanReservedSlots: 1,
      normalInUse: this._normalSlots.size,
      humanPriorityInUse: this._humanSlot ? 1 : 0,
      totalInUse: this._normalSlots.size + (this._humanSlot ? 1 : 0),
      pendingHumanDemand: this._pendingHumanDemand,
      activeKeys: [
        ...[...this._normalSlots.values()].map((s) => s.key),
        ...(this._humanSlot ? [this._humanSlot.key] : []),
      ],
    };
  }
}
