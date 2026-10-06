/**
 * A tiny in-process counting semaphore. Used to cap how many avatars sharp
 * decodes at once, so a burst of confirms cannot pin every libuv thread and
 * a lot of memory (each decode may hold up to the pixel limit).
 */

/** Counting semaphore with FIFO waiters. */
export class Semaphore {
  readonly #limit: number;
  #active = 0;
  readonly #waiters: Array<() => void> = [];

  /**
   * @param limit - Maximum concurrent holders (integer ≥ 1).
   * @throws RangeError for a non-positive or non-integer limit.
   */
  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Semaphore limit must be a positive integer");
    this.#limit = limit;
  }

  /** Holders right now (tests and diagnostics). */
  get active(): number {
    return this.#active;
  }

  /** Callers waiting for a slot (tests and diagnostics). */
  get waiting(): number {
    return this.#waiters.length;
  }

  /**
   * Run `task` once a slot is free; the slot is released when it settles
   * (resolve or reject), and the next waiter (FIFO) takes it.
   *
   * @param task - Work to run under the limit.
   */
  async run<TResult>(task: () => Promise<TResult>): Promise<TResult> {
    await this.#acquire();
    try {
      return await task();
    } finally {
      this.#release();
    }
  }

  #acquire(): Promise<void> {
    if (this.#active < this.#limit) {
      this.#active += 1;
      return Promise.resolve();
    }
    // The slot is handed over directly by #release (active stays the same).
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  #release(): void {
    const next = this.#waiters.shift();
    if (next === undefined) {
      this.#active -= 1;
      return;
    }
    next();
  }
}
