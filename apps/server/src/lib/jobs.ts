/**
 * Tiny in-process job queue with concurrency 1 (e.g. sharp image processing
 * in T4). Jobs run in FIFO order; a failing job is logged and does not stop
 * the queue. Jobs do not survive a restart, so callers must keep durable
 * state (e.g. `upload_status`) and have a cleanup/retry path.
 */
import type { FastifyBaseLogger } from "fastify";

/** A unit of work. Receives an abort signal that fires when the queue closes. */
export type Job = (signal: AbortSignal) => Promise<void>;

/** Serial job queue. */
export interface JobQueue {
  /**
   * Queue a job.
   *
   * @param name - Short label for logs, e.g. `media.process`. Never include tokens or PII.
   * @param job - The work.
   * @returns `false` when the queue is closed and the job was dropped.
   */
  enqueue(name: string, job: Job): boolean;
  /** Number of jobs waiting (not counting the running one). */
  readonly pending: number;
  /** Resolves when the queue is empty and nothing is running. */
  onIdle(): Promise<void>;
  /** Stop accepting jobs, abort the running one's signal and wait for it to settle. Pending jobs are dropped. */
  close(): Promise<void>;
}

interface QueuedJob {
  name: string;
  job: Job;
}

/**
 * Create a serial job queue.
 *
 * @param log - Logger for job failures.
 */
export function createJobQueue(log: FastifyBaseLogger): JobQueue {
  const queue: QueuedJob[] = [];
  const controller = new AbortController();
  let running: Promise<void> | null = null;
  let closed = false;
  let idleWaiters: Array<() => void> = [];

  function notifyIdle(): void {
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  async function drain(): Promise<void> {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      if (closed) break;
      const startedAt = Date.now();
      try {
        await next.job(controller.signal);
        log.debug({ job: next.name, ms: Date.now() - startedAt }, "job finished");
      } catch (error) {
        log.error({ err: error, job: next.name }, "job failed");
      }
    }
    running = null;
    notifyIdle();
  }

  return {
    enqueue(name, job) {
      if (closed) {
        log.warn({ job: name }, "job dropped: queue closed");
        return false;
      }
      queue.push({ name, job });
      // Start on a microtask so `running` is assigned before drain() can finish and reset it.
      running ??= Promise.resolve().then(drain);
      return true;
    },
    get pending() {
      return queue.length;
    },
    onIdle() {
      if (running === null) return Promise.resolve();
      return new Promise((resolve) => {
        idleWaiters.push(resolve);
      });
    },
    async close() {
      closed = true;
      const dropped = queue.length;
      queue.length = 0;
      if (dropped > 0) log.warn({ dropped }, "job queue closed with pending jobs");
      controller.abort();
      if (running !== null) await running;
    }
  };
}
