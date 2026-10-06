/**
 * Media module (T4): private gallery uploads, processing, moderation.
 * Registered under `/api` by `app.ts`.
 *
 * Lifecycle:
 * - `onReady`: for items a previous process left in `processing` (confirmed
 *   before this module started), re-queue the ones that never started and
 *   fail the started ones as `interrupted` (no poison-pill crash loop); then
 *   start the cleanup timer.
 * - `onClose`: stop the timer and wait for a running cleanup pass (the job
 *   queue itself is closed by the app).
 */
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import adminMediaRoutes from "./adminRoutes.js";
import { CLEANUP_INTERVAL_MS } from "./constants.js";
import { runMediaCleanup } from "./jobs/mediaCleanup.js";
import { recoverProcessingOnStart } from "./jobs/mediaProcess.js";
import mediaRoutes from "./routes.js";
import { jobDeps } from "./shared.js";

export { countVisibleMediaByCuencada } from "./service.js";

/** Media routes under `/api` plus the module's background work. */
const mediaModule: FastifyPluginAsyncZod = async (app) => {
  await app.register(mediaRoutes);
  await app.register(adminMediaRoutes);

  const deps = jobDeps(app);
  // Items confirmed before this instant belong to a previous process (see recoverProcessingOnStart).
  const moduleStartedAt = app.clock.now();
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;

  const runCleanup = (): void => {
    if (running !== null) return;
    running = runMediaCleanup(deps)
      .then(() => undefined)
      .catch((error: unknown) => {
        app.log.error({ errorName: error instanceof Error ? error.name : "unknown" }, "media cleanup failed");
      })
      .finally(() => {
        running = null;
      });
  };

  let startupCheck: Promise<void> | null = null;

  app.addHook("onReady", async () => {
    // In the background: a slow or down database must not block (or fail) boot.
    startupCheck = recoverProcessingOnStart(deps, moduleStartedAt)
      .then(() => undefined)
      .catch((error: unknown) => {
        app.log.error({ errorName: error instanceof Error ? error.name : "unknown" }, "media interrupted-item check failed");
      });
    timer = setInterval(runCleanup, CLEANUP_INTERVAL_MS);
    timer.unref();
  });

  app.addHook("onClose", async () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
    if (startupCheck !== null) await startupCheck;
    if (running !== null) await running;
  });
};

export default mediaModule;
