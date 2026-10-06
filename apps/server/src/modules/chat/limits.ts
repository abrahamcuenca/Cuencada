/**
 * In-memory, per-process limits for the chat socket: a sliding-window rate
 * limiter (sends) and a throttle (typing). Both take explicit times so tests
 * drive them with `app.clock`.
 */

/** Sends allowed per user per window. */
export const SEND_RATE_LIMIT = { max: 20, windowMs: 10_000 } as const;
/** Frames of any kind per user per window (bounds DB work from `read`/`typing` floods). */
export const FRAME_RATE_LIMIT = { max: 60, windowMs: 10_000 } as const;
/** At most one `typing` broadcast per user and room per this interval. */
export const TYPING_THROTTLE_MS = 3_000;

/** Sliding-window counter keyed by an arbitrary string (a user id). */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number
  ) {}

  /**
   * Record one hit for `key` if the window has room.
   *
   * @returns `true` when allowed, `false` when over the limit (nothing recorded).
   */
  take(key: string, nowMs: number): boolean {
    const recent = (this.hits.get(key) ?? []).filter((at) => at > nowMs - this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(nowMs);
    this.hits.set(key, recent);
    return true;
  }

  /** Forget keys with no hit inside the window. */
  sweep(nowMs: number): void {
    for (const [key, times] of this.hits) {
      if (times.every((at) => at <= nowMs - this.windowMs)) this.hits.delete(key);
    }
  }
}

/** Lets one event per key through per interval. */
export class Throttle {
  private readonly last = new Map<string, number>();

  constructor(private readonly intervalMs: number) {}

  /** @returns `true` if the event may pass now (and records it). */
  allow(key: string, nowMs: number): boolean {
    const previous = this.last.get(key);
    if (previous !== undefined && nowMs - previous < this.intervalMs) return false;
    this.last.set(key, nowMs);
    return true;
  }

  /** Forget keys older than the interval. */
  sweep(nowMs: number): void {
    for (const [key, at] of this.last) {
      if (nowMs - at >= this.intervalMs) this.last.delete(key);
    }
  }
}
