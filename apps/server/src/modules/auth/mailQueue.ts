/**
 * The auth module's own serial mail queue [SEC], separate from `app.jobs` so a
 * long media job (T4) can never delay a login email. Built with the frozen
 * `createJobQueue`; owned and closed by the auth module.
 *
 * - **Bounded:** at most {@link MAIL_QUEUE_MAX_PENDING} waiting sends; beyond
 *   that a send is dropped with a `mail.queue_full` warning (no PII).
 * - **Retries:** a provider rate limit or server error is retried with
 *   exponential backoff and jitter, up to {@link MAIL_RETRY_ATTEMPTS} attempts.
 *   Validation errors and quota exhaustion are not retried. Every send carries
 *   an idempotency key derived from its row id, so a retry never duplicates.
 * - **Not durable:** jobs live in memory. Sends still queued at shutdown are
 *   dropped; the user simply asks again (the SPA says so on the 202 screen).
 */
import { EmailRenderError } from "@cuencada/emails";
import type { FastifyInstance } from "fastify";
import { isAppError } from "../../lib/errors.js";
import { createJobQueue, type JobQueue } from "../../lib/jobs.js";

/** Most sends allowed to wait in the queue (future config: `MAIL_QUEUE_MAX_PENDING`). */
export const MAIL_QUEUE_MAX_PENDING = 500;
/** Total attempts per send, including the first (future config). */
export const MAIL_RETRY_ATTEMPTS = 3;
/** First backoff delay; doubles per retry, plus up to 50% jitter (future config). */
export const MAIL_RETRY_BASE_MS = 200;

/** Per-app mail state. */
interface MailState {
  queue: JobQueue;
  /** UTC day (`YYYY-MM-DD`) for which `mail.cap_reached` was already logged. */
  capWarnedDay: string | null;
}

/**
 * Mail state keyed by the app's general job queue: every encapsulated child
 * instance inherits the same `app.jobs` object, so it identifies the app.
 */
const states = new WeakMap<object, MailState>();

/**
 * Create the app's mail queue and close it when the app closes. Call once,
 * from the auth module, before its routes are registered.
 *
 * @param app - The auth module's instance.
 * @returns The new queue.
 */
export function registerMailQueue(app: FastifyInstance): JobQueue {
  const queue = createJobQueue(app.log);
  states.set(app.jobs, { queue, capWarnedDay: null });
  app.addHook("onClose", async () => {
    await queue.close();
  });
  return queue;
}

function stateOf(app: Pick<FastifyInstance, "jobs">): MailState {
  const state = states.get(app.jobs);
  if (state === undefined) throw new Error("mailQueue: the auth module did not register a mail queue");
  return state;
}

/**
 * The mail queue of `app` (tests: `await mailQueue(app).onIdle()`).
 *
 * @param app - Any instance of the app (root or a child).
 * @throws Error when the auth module has not registered one (a wiring bug).
 */
export function mailQueue(app: Pick<FastifyInstance, "jobs">): JobQueue {
  return stateOf(app).queue;
}

/**
 * Log `mail.cap_reached` (warn, no PII) at most once per UTC day per app, so
 * ops can alert on it without a log flood.
 *
 * @param app - The app (log, jobs).
 * @param day - UTC day key, `YYYY-MM-DD`.
 * @param details - Non-PII context (tier, count, cap).
 */
export function warnCapReachedOnce(
  app: Pick<FastifyInstance, "jobs" | "log">,
  day: string,
  details: Record<string, string | number>
): void {
  const state = stateOf(app);
  if (state.capWarnedDay === day) return;
  state.capWarnedDay = day;
  app.log.warn({ event: "mail.cap_reached", day, ...details }, "daily email cap reached; user-triggered emails skipped");
}

/** Resend error names (from `ResendMailer`'s cause) worth retrying. */
const RETRYABLE_PROVIDER_ERRORS = /\b(rate_limit_exceeded|application_error|internal_server_error|concurrent_idempotent_requests)\b/;

/**
 * Whether a failed send is worth retrying: a provider rate limit or server
 * error, or a non-application error (network failure). Validation errors,
 * quota exhaustion and template errors are final.
 *
 * @param error - What the send threw.
 */
export function isRetryableMailError(error: unknown): boolean {
  if (isAppError(error)) {
    if (error.code !== "SERVICE_UNAVAILABLE") return false;
    const cause: unknown = error.cause;
    return cause instanceof Error && RETRYABLE_PROVIDER_ERRORS.test(cause.message);
  }
  if (error instanceof EmailRenderError) return false;
  return error instanceof Error;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("mail retry aborted: queue closed"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("mail retry aborted: queue closed"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run `send`, retrying retryable failures with exponential backoff and jitter.
 *
 * @param send - The send (must carry an idempotency key).
 * @param signal - Aborts the wait when the queue closes.
 * @returns After the first success.
 * @throws The last error once attempts are exhausted or the error is final.
 */
export async function sendWithRetry(send: () => Promise<unknown>, signal: AbortSignal): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await send();
      return;
    } catch (error) {
      if (attempt >= MAIL_RETRY_ATTEMPTS || !isRetryableMailError(error)) throw error;
      const base = MAIL_RETRY_BASE_MS * 2 ** (attempt - 1);
      await sleep(base + Math.floor(Math.random() * base * 0.5), signal);
    }
  }
}

/**
 * Queue a send off the request path, so request-for-token endpoints answer
 * the same way whether or not an email goes out (no enumeration). Failures
 * are logged by the queue, never with the body or token.
 *
 * @param app - The app (jobs identifies its mail queue; log).
 * @param name - Job label for logs (no PII, no token).
 * @param send - The send.
 * @returns `false` when the send was dropped (queue full or closed).
 */
export function enqueueMail(
  app: Pick<FastifyInstance, "jobs" | "log">,
  name: string,
  send: () => Promise<unknown>
): boolean {
  const queue = mailQueue(app);
  if (queue.pending >= MAIL_QUEUE_MAX_PENDING) {
    app.log.warn({ event: "mail.queue_full", job: name, pending: queue.pending }, "mail queue full; email dropped");
    return false;
  }
  return queue.enqueue(name, (signal) => sendWithRetry(send, signal));
}
