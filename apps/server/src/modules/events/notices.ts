/**
 * Consent notices for events (Security requirement 3, WP-5.3) [SEC]: "X te
 * agregó a un evento", with a one-tap "Salir"
 * (`DELETE /api/events/:id/participants/me`).
 *
 * Deliberately isolated: the notice is derived from the caller's own
 * `event_participants` row (`added_by_user_id` set to someone else) plus the
 * `notice_seen_at` dismissal column (migration 0009). WP-6 replaces this
 * with a general `notifications` table; only this file, its two routes and
 * the column need to move.
 */
import { EVENT_NOTICES_MAX, type EventNotice, EventRole } from "@cuencada/types";
import { and, desc, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";
import { eventParticipants, events, users } from "../../db/schema/index.js";
import { type EventViewer, eventVisibleSql } from "./access.js";
import { loadVisibleEvent } from "./repository.js";

const adder = alias(users, "adder");

/**
 * The caller's undismissed "you were added" notices (Security requirement
 * 3): their participations added by **someone else**, in events they can
 * see, newest first.
 */
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
      addedAt: eventParticipants.joinedAt,
      addedByName: adder.displayName,
      organizerCount
    })
    .from(eventParticipants)
    .innerJoin(events, eq(events.id, eventParticipants.eventId))
    .leftJoin(adder, eq(adder.id, eventParticipants.addedByUserId))
    .where(
      and(
        eq(eventParticipants.userId, viewer.id),
        isNotNull(eventParticipants.addedByUserId),
        ne(eventParticipants.addedByUserId, viewer.id),
        isNull(eventParticipants.noticeSeenAt),
        eventVisibleSql(viewer)
      )
    )
    .orderBy(desc(eventParticipants.joinedAt), desc(events.id))
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
  await app.db
    .update(eventParticipants)
    .set({ noticeSeenAt: app.clock.now() })
    .where(
      and(
        eq(eventParticipants.eventId, eventId),
        eq(eventParticipants.userId, viewer.id),
        isNull(eventParticipants.noticeSeenAt)
      )
    );
}
