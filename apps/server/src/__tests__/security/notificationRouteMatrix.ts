/**
 * Authorization-matrix entries for the notification routes (WP-6.1) [SEC].
 * Spread into `ROUTE_MATRIX` (`routeMatrix.ts`). Every route reads or writes
 * only the caller's own rows (ADR 0001 §8, requirement 7); marking another
 * member's notification read is silently ignored (no error, no change).
 */
import { NotificationKind } from "@cuencada/types";
import { eq } from "drizzle-orm";
import { notifications } from "../../db/schema/index.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { insertEvent } from "../../../test/helpers/events.js";
import type { Actor, BuiltRequest, RouteSpec } from "./routeMatrix.js";

const member = { auth: "user", requireVerifiedEmail: true } as const;
const json = (url: string, payload?: unknown): BuiltRequest => (payload === undefined ? { url } : { url, payload });

/** An unread `event_added` notification of `recipient` (actor: `actor`). */
async function notificationOf(recipient: Actor, actor: Actor): Promise<string> {
  const { event } = await insertEvent({ organizerId: actor.user.id, participantIds: [recipient.user.id] });
  const [row] = await getTestDb()
    .insert(notifications)
    .values({
      userId: recipient.user.id,
      actorUserId: actor.user.id,
      kind: NotificationKind.EventAdded,
      eventId: event.id,
      dedupeKey: `event:${event.id}`
    })
    .returning({ id: notifications.id });
  if (row === undefined) throw new Error("notificationOf: no row");
  return row.id;
}

/** Matrix entries of the notifications module. */
export const NOTIFICATION_ROUTE_SPECS: readonly RouteSpec[] = [
  {
    method: "GET",
    url: "/api/notifications",
    ...member,
    owner: "the caller's own notifications, targets re-checked for visibility",
    build: async () => json("/api/notifications")
  },
  {
    method: "GET",
    url: "/api/notifications/unread-count",
    ...member,
    owner: "the caller's own unread count",
    build: async () => json("/api/notifications/unread-count")
  },
  {
    method: "POST",
    url: "/api/notifications/read",
    ...member,
    owner: "the caller's own notifications; other ids are ignored",
    build: async () => json("/api/notifications/read", { all: true }),
    probes: [
      {
        label: "another member's notification id is ignored (200, unchanged)",
        kind: "idor",
        build: async (ctx) => {
          const id = await notificationOf(ctx.other, ctx.actor);
          return {
            ...json("/api/notifications/read", { ids: [id] }),
            state: async () => getTestDb().select({ seenAt: notifications.seenAt }).from(notifications).where(eq(notifications.id, id))
          };
        },
        expect: "2xx"
      }
    ]
  }
];
