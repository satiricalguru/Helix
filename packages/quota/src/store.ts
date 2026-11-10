/**
 * Quota primitives.
 *
 * Two independent controls, deliberately separate:
 *   - a token bucket for request rate (RPM)
 *   - a spend budget with reserve/settle semantics
 *
 * The budget is reserved at admission and settled on completion so that N
 * concurrent requests cannot each individually pass the check and jointly
 * exceed the cap. Worst-case overshoot is bounded by
 * `concurrency x per-request reservation` rather than unbounded.
 */

export interface TokenBucketResult {
  allowed: boolean;
  remaining: number;
  capacity: number;
  /** Seconds until the bucket is fully replenished. */
  resetSeconds: number;
}

export interface SpendResult {
  allowed: boolean;
  /** Amount still available after the operation. */
  remaining: number;
  limit: number;
}

/** Storage backend for quota state. */
export interface QuotaStore {
  /** Take one token from a bucket that refills continuously. */
  takeToken(
    key: string,
    opts: { capacity: number; refillPerSecond: number },
  ): Promise<TokenBucketResult>;

  /** Return a token to a bucket (used when a later check rejects the request). */
  refundToken(
    key: string,
    opts: { capacity: number; refillPerSecond: number },
  ): Promise<void>;

  /** Hold `amount` against a budget. Returns false if it does not fit. */
  reserve(key: string, amount: number, limit: number): Promise<SpendResult>;

  /** Replace a reservation with the actual spend. */
  settle(key: string, reserved: number, actual: number, limit: number): Promise<SpendResult>;

  /** Release a reservation without spending it. */
  release(key: string, amount: number): Promise<void>;

  /** Current spend against a budget. */
  spend(key: string): Promise<number>;
}

/* --------------------------------------------------------- in-memory */

interface BucketState {
  tokens: number;
  lastRefill: number;
}

interface SpendState {
  /** Amount currently held in reservations. */
  held: number;
  /** Amount actually spent. */
  spent: number;
}

/**
 * In-memory store. Used by the test suite and by single-node development
 * runs where Redis is not worth the operational cost.
 *
 * Not safe across processes: every process sees its own counters.
 */
export class InMemoryQuotaStore implements QuotaStore {
  #buckets = new Map<string, BucketState>();
  #spends = new Map<string, SpendState>();
  #now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.#now = opts.now ?? (() => Date.now());
  }

  async takeToken(
    key: string,
    opts: { capacity: number; refillPerSecond: number },
  ): Promise<TokenBucketResult> {
    const now = this.#now();
    let state = this.#buckets.get(key);
    if (!state) {
      state = { tokens: opts.capacity, lastRefill: now };
      this.#buckets.set(key, state);
    }
    const elapsedSeconds = Math.max(0, (now - state.lastRefill) / 1000);
    state.tokens = Math.min(opts.capacity, state.tokens + elapsedSeconds * opts.refillPerSecond);
    state.lastRefill = now;

    const allowed = state.tokens >= 1;
    if (allowed) state.tokens -= 1;

    const deficit = Math.max(0, opts.capacity - state.tokens);
    const resetSeconds =
      opts.refillPerSecond > 0 ? Math.ceil(deficit / opts.refillPerSecond) : 0;

    return {
      allowed,
      remaining: Math.max(0, Math.floor(state.tokens)),
      capacity: opts.capacity,
      resetSeconds,
    };
  }

  async refundToken(
    key: string,
    opts: { capacity: number; refillPerSecond: number },
  ): Promise<void> {
    const now = this.#now();
    const state = this.#buckets.get(key);
    if (!state) return;
    const elapsedSeconds = Math.max(0, (now - state.lastRefill) / 1000);
    state.tokens = Math.min(
      opts.capacity,
      state.tokens + elapsedSeconds * opts.refillPerSecond + 1,
    );
    state.lastRefill = now;
  }

  async reserve(key: string, amount: number, limit: number): Promise<SpendResult> {
    const state = this.#spendState(key);
    const total = state.spent + state.held + amount;
    if (total > limit) {
      return { allowed: false, remaining: Math.max(0, limit - state.spent - state.held), limit };
    }
    state.held += amount;
    return { allowed: true, remaining: limit - total, limit };
  }
  async settle(key: string, reserved: number, actual: number, limit: number): Promise<SpendResult> {
    const state = this.#spendState(key);
    state.held = Math.max(0, state.held - reserved);
    state.spent += actual;
    return { allowed: true, remaining: Math.max(0, limit - state.spent - state.held), limit };
  }

  async release(key: string, amount: number): Promise<void> {
    const state = this.#spendState(key);
    state.held = Math.max(0, state.held - amount);
  }

  async spend(key: string): Promise<number> {
    const state = this.#spends.get(key);
    if (!state) return 0;
    return state.spent + state.held;
  }

  #spendState(key: string): SpendState {
    let state = this.#spends.get(key);
    if (!state) {
      state = { held: 0, spent: 0 };
      this.#spends.set(key, state);
    }
    return state;
  }
}
