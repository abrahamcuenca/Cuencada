/**
 * Notification routes (WP-6.1) under `/api` [SEC]. Every route is
 * `auth: "user"` + `requireVerifiedEmail: true` and reads or writes only the
 * caller's own rows; targets are filtered for visibility at read time
 * (`repository.ts`). Per-user rate limits on top of the global one.
 */
import {
  apiErrorSchema,
  markNotificationsReadInputSchema,
  notificationListQuerySchema,
  notificationPageSchema,
  unreadCountSchema
} from "@cuencada/types";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { authUser } from "../../plugins/auth.js";
import { decodeCursor, encodeCursor } from "../media/cursor.js";
import { rateLimitByUser } from "../media/shared.js";
import { countUnread, listNotificationRecords, markRead, type NotificationViewer, toNotifications } from "./repository.js";

/** Reads (feed and badge) per user. */
export const NOTIFICATION_READ_LIMIT = { max: 240, timeWindow: "1 minute" } as const;
/** "Marcar como leído" per user. */
export const NOTIFICATION_MARK_LIMIT = { max: 120, timeWindow: "1 minute" } as const;

const errorResponses = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  429: apiErrorSchema
} as const;

/** Member notification routes. */
const notificationRoutes: FastifyPluginAsyncZod = async (app) => {
  const member = { auth: "user", requireVerifiedEmail: true } as const;
  const viewerOf = (user: { id: string; role: NotificationViewer["role"] }): NotificationViewer => ({ id: user.id, role: user.role });

  /** `GET /api/notifications`: the caller's visible notifications, newest first (keyset). */
  app.get(
    "/notifications",
    {
      config: { ...member, rateLimit: rateLimitByUser("notifications-read", NOTIFICATION_READ_LIMIT) },
      schema: { querystring: notificationListQuerySchema, response: { 200: notificationPageSchema, ...errorResponses } }
    },
    async (request) => {
      const viewer = viewerOf(authUser(request));
      const { query } = request;
      const { records, hasMore } = await listNotificationRecords(app.db, viewer, {
        cursor: query.cursor === undefined ? null : decodeCursor(query.cursor),
        limit: query.limit,
        unreadOnly: query.unread === true
      });
      const last = records.at(-1);
      return {
        items: await toNotifications(app, records),
        nextCursor: hasMore && last !== undefined ? encodeCursor({ micros: last.cursorMicros, id: last.id }) : null
      };
    }
  );

  /** `GET /api/notifications/unread-count`: the badge (visible targets only, capped). */
  app.get(
    "/notifications/unread-count",
    {
      config: { ...member, rateLimit: rateLimitByUser("notifications-count", NOTIFICATION_READ_LIMIT) },
      schema: { response: { 200: unreadCountSchema, ...errorResponses } }
    },
    async (request) => ({ count: await countUnread(app.db, viewerOf(authUser(request))) })
  );

  /** `POST /api/notifications/read`: mark some (`ids`, own only; others ignored) or `all` read. */
  app.post(
    "/notifications/read",
    {
      config: { ...member, rateLimit: rateLimitByUser("notifications-mark", NOTIFICATION_MARK_LIMIT) },
      schema: { body: markNotificationsReadInputSchema, response: { 200: unreadCountSchema, ...errorResponses } }
    },
    async (request) => {
      const viewer = viewerOf(authUser(request));
      const { body } = request;
      await markRead(app.db, viewer, "all" in body ? "all" : body.ids);
      return { count: await countUnread(app.db, viewer) };
    }
  );
};

export default notificationRoutes;
