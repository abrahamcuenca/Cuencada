/**
 * Notifications module (WP-6.1): the bell's routes under `/api` plus the
 * retention job. Writers for other modules live in `notify.ts`
 * (`recordNotification`, `retractNotification`, `markNotificationSeen`,
 * `pushNotifications`). Rules: ADR 0001 §8; routes: `docs/coordination/WP-6.0.md`.
 *
 * Lifecycle: `onReady` starts the daily retention timer (unref'd; deletes
 * rows older than `NOTIFICATION_RETENTION_DAYS` in batches); `onClose`
 * clears it and waits for a running pass. The per-user cap of
 * `NOTIFICATIONS_PER_USER_MAX` is enforced on every write instead.
 */
import { NOTIFICATION_RETENTION_DAYS } from "@cuencada/types";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { purgeExpiredNotifications } from "./repository.js";
import notificationRoutes from "./routes.js";

/** How often the retention pass runs. */
export const NOTIFICATION_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Notification routes under `/api` plus the retention timer. */
const notificationsModule: FastifyPluginAsyncZod = async (app) => {
  await app.register(notificationRoutes);

  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;

  const runCleanup = (): void => {
    if (running !== null) return;
    running = purgeExpiredNotifications(app.db, app.clock.now(), NOTIFICATION_RETENTION_DAYS)
      .then((deleted) => {
        if (deleted > 0) app.log.info({ event: "notifications.cleanup", deleted }, "purged expired notifications");
      })
      .catch((error: unknown) => {
        app.log.error({ errorName: error instanceof Error ? error.name : "unknown" }, "notification cleanup failed");
      })
      .finally(() => {
        running = null;
      });
  };

  app.addHook("onReady", async () => {
    if (timer !== null) return;
    timer = setInterval(runCleanup, NOTIFICATION_CLEANUP_INTERVAL_MS);
    timer.unref();
  });

  app.addHook("onClose", async () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
    if (running !== null) await running;
  });
};

export default notificationsModule;
