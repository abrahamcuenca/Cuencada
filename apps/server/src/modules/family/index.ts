/**
 * Family module (T6, WP-4.1). Registered under `/api` by `app.ts`:
 * - `/family/*` (verified members): search, person card, tree, self edit,
 *   and own-family editing (create with `relateTo`, edit, delete own additions).
 * - `/family/people/:id/photo*` (verified members; WP-4.3): tree photos.
 * - `/admin/people*`, `/admin/relationships*` (admins): people CRUD,
 *   account linking and relationships with cycle prevention.
 * - `/admin/people/:id/revisions*`, `/admin/revisions/:id/revert`,
 *   `/admin/family/activity` (admins): history, undo, purge, activity feed.
 *
 * Lifecycle: `onReady` starts the revision retention timer (unref'd, one
 * year); `onClose` clears it and waits for a running pass.
 */
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import adminFamilyRoutes from "./admin-routes.js";
import memberFamilyRoutes from "./member-routes.js";
import personPhotoRoutes from "./photo-routes.js";
import revisionRoutes from "./revision-routes.js";
import { REVISION_CLEANUP_INTERVAL_MS, purgeExpiredRevisions } from "./revisions.js";

/** Family routes under `/api` plus the revision retention timer. */
const familyModule: FastifyPluginAsyncZod = async (app) => {
  await app.register(memberFamilyRoutes);
  await app.register(adminFamilyRoutes);
  await app.register(personPhotoRoutes);
  await app.register(revisionRoutes);

  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;

  const runCleanup = (): void => {
    if (running !== null) return;
    running = purgeExpiredRevisions(app.db, app.clock.now())
      .then((deleted) => {
        if (deleted > 0) app.log.info({ event: "family.revisions.cleanup", deleted }, "purged expired family revisions");
      })
      .catch((error: unknown) => {
        app.log.error({ errorName: error instanceof Error ? error.name : "unknown" }, "family revision cleanup failed");
      })
      .finally(() => {
        running = null;
      });
  };

  app.addHook("onReady", async () => {
    if (timer !== null) return;
    timer = setInterval(runCleanup, REVISION_CLEANUP_INTERVAL_MS);
    timer.unref();
  });

  app.addHook("onClose", async () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
    if (running !== null) await running;
  });
};

export default familyModule;
