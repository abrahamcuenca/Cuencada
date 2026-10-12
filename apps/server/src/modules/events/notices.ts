/**
 * **Deprecated** (WP-6.1): the WP-5.3 consent notices, kept as shims over the
 * `event_added` notifications (ADR 0001 §8 "Backward compatibility") until
 * no client calls them. The web reads `/api/notifications` instead.
 *
 * - `GET /api/events/notices`: the caller's **unseen** `event_added`
 *   notifications for events they can see **and still take part in**,
 *   newest first, as `EventNotice`s.
 * - `DELETE /api/events/:id/notice`: marks `event:{id}` seen (and sets the
 *   deprecated `event_participants.notice_seen_at`); 404 when invisible.
 */
import { EVENT_NOTICES_MAX, type EventNotice, EventRole, NotificationKind, notificationDedupeKey } from "@cuencada/types";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";
import { eventParticipants, events, notifications, users } from "../../db/schema/index.js";
import { type EventViewer, eventVisibleSql } from "./access.js";
import { loadVisibleEvent } from "./repository.js";

const adder = alias(users, "adder");

/** The caller's undismissed "you were added" notices (deprecated shim, see the module doc). */
export async function listNotices(app: FastifyInstance, viewer: EventViewer): Promise<EventNotice[]> {
  const organizerCount = sql<number>`(select count(*)::int from ${eventParticipants} o
    where o.event_id = ${events.id} and o.role = 'organizer')`.mapWith(Number);
  const rows = await app.db
    .select({
      id: events.id,
      year: events.year,
      slug: events.slug,
      title: events.title,
      role: eventParticipants.role,
      addedAt: notifications.createdAt,
      addedByName: adder.displayName,
      organizerCount
    })
    .from(notifications)
    .innerJoin(events, eq(events.id, notifications.eventId))
    .innerJoin(eventParticipants, and(eq(eventParticipants.eventId, events.id), eq(eventParticipants.userId, viewer.id)))
    .leftJoin(adder, eq(adder.id, notifications.actorUserId))
    .where(
      and(
        eq(notifications.userId, viewer.id),
        eq(notifications.kind, NotificationKind.EventAdded),
        isNull(notifications.seenAt),
        eventVisibleSql(viewer)
      )
    )
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(EVENT_NOTICES_MAX);
  return rows.map((row) => ({
    event: { id: row.id, year: row.year, slug: row.slug, title: row.title },
    addedByName: row.addedByName,
    role: row.role,
    addedAt: row.addedAt.toISOString(),
    canLeave: !(row.role === EventRole.Organizer && row.organizerCount <= 1)
  }));
}

/** `DELETE /api/events/:id/notice`: dismiss the caller's notice (idempotent; 404 when invisible). */
export async function dismissNotice(app: FastifyInstance, viewer: EventViewer, eventId: string): Promise<void> {
  await loadVisibleEvent(app.db, viewer, eq(events.id, eventId));
  const now = app.clock.now();
  await app.db.transaction(async (tx) => {
    await tx
      .update(notifications)
      .set({ seenAt: now })
      .where(
        and(
          eq(notifications.userId, viewer.id),
          eq(notifications.dedupeKey, notificationDedupeKey.event(eventId)),
          isNull(notifications.seenAt)
        )
      );
    await tx
      .update(eventParticipants)
      .set({ noticeSeenAt: now })
      .where(
        and(
          eq(eventParticipants.eventId, eventId),
          eq(eventParticipants.userId, viewer.id),
          isNull(eventParticipants.noticeSeenAt)
        )
      );
  });
}
