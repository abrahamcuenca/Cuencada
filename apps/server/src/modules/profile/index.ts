/**
 * Profile module (T5): own profile and avatar. Registered under `/api` by
 * `app.ts`.
 *
 * Lifecycle: `onReady` starts the avatar-upload cleanup timer (unref'd);
 * `onClose` clears it and waits for a running pass. Passes never overlap.
 *
 * Exports `avatarUrlFor(app, key, size?)` for other tracks (T3/T6/T7): the
 * only supported way to turn `profiles.avatar_key` into a URL.
 */
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { cleanupAvatarUploads } from "./avatarCleanup.js";
import avatarRoutes from "./avatarRoutes.js";
import { AVATAR_CLEANUP_INTERVAL_MS } from "./constants.js";
import profileRoutes from "./routes.js";
import { errorName } from "./shared.js";

export { type AvatarUrlDeps, avatarUrlFor } from "./avatar.js";
export { AvatarSize } from "./constants.js";

/** Profile routes under `/api` plus the avatar cleanup timer. */
const profileModule: FastifyPluginAsyncZod = async (app) => {
  await app.register(profileRoutes);
  await app.register(avatarRoutes);

  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;

  const runCleanup = (): void => {
    if (running !== null) return;
    running = cleanupAvatarUploads({
      db: app.db,
      storage: app.storage,
      clock: app.clock,
      log: app.log
    })
      .then(() => undefined)
      .catch((error: unknown) => {
        app.log.error({ errorName: errorName(error) }, "avatar cleanup failed");
      })
      .finally(() => {
        running = null;
      });
  };

  app.addHook("onReady", async () => {
    if (timer !== null) return;
    timer = setInterval(runCleanup, AVATAR_CLEANUP_INTERVAL_MS);
    timer.unref();
  });

  app.addHook("onClose", async () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
    if (running !== null) await running;
  });
};

export default profileModule;
