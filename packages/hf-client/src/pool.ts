/**
 * A concurrency semaphore.
 *
 * Higgsfield accepts generations above the account's concurrency limit and
 * queues them, but the queue has its own limit and a full queue rejects the
 * request with 429. Keeping our own pool small keeps the queue short.
 */

export class Semaphore {
  #capacity: number;
  #inUse = 0;
  #waiters: Array<() => void> = [];

  constructor(capacity: number) {
    this.#capacity = Math.max(1, capacity);
  }

  get capacity(): number {
    return this.#capacity;
  }

  get inUse(): number {
    return this.#inUse;
  }

  get waiting(): number {
    return this.#waiters.length;
  }

  async acquire(): Promise<() => void> {
    if (this.#inUse < this.#capacity) {
      this.#inUse++;
      return this.#release();
    }
    await new Promise<void>((resolve) => this.#waiters.push(resolve));
    this.#inUse++;
    return this.#release();
  }

  #release(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#inUse--;
      const next = this.#waiters.shift();
      if (next) next();
    };
  }

  /** Run `fn` while holding a slot. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
