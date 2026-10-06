/**
 * A serial job queue reserved for auth emails (magic link, reset, verify,
 * password-changed), separate from `app.jobs`, so a long media job (T4) can
 * never delay a login email. Built with the frozen `createJobQueue`; owned and
 * closed by the auth module.
 */
import type { FastifyInstance } from "fastify";
import { createJobQueue, type JobQueue } from "../../lib/jobs.js";

/**
 * Mail queues keyed by the app's general job queue: every encapsulated child
 * instance inherits the same `app.jobs` object, so it identifies the app.
 */
const queues = new WeakMap<JobQueue, JobQueue>();

/**
 * Create the app's mail queue and close it when the app closes. Call once,
 * from the auth module, before its routes are registered.
 *
 * @param app - The auth module's instance.
 * @returns The new queue.
 */
export function registerMailQueue(app: FastifyInstance): JobQueue {
  const queue = createJobQueue(app.log);
  queues.set(app.jobs, queue);
  app.addHook("onClose", async () => {
    await queue.close();
  });
  return queue;
}

/**
 * The mail queue of `app` (tests: `await mailQueue(app).onIdle()`).
 *
 * @param app - Any instance of the app (root or a child).
 * @throws Error when the auth module has not registered one (a wiring bug).
 */
export function mailQueue(app: Pick<FastifyInstance, "jobs">): JobQueue {
  const queue = queues.get(app.jobs);
  if (queue === undefined) throw new Error("mailQueue: the auth module did not register a mail queue");
  return queue;
}
