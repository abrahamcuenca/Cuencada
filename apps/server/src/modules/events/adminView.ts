/**
 * The `event.admin_viewed` audit (ADR 0001 §7, Security requirement 5)
 * [SEC]. An admin who is **not** a participant and opens a `participants`
 * event's detail, chat or media is recorded at most once per admin, event
 * and hour (the first surface in the window).
 *
 * - **Before the data:** callers await this before building the response;
 *   any failure propagates and the read answers 500 (fail closed).
 * - **Race-free dedupe:** an insert-on-conflict into `event_admin_views`
 *   keyed `(admin, event, hour bucket)`; the audit row is written in the same
 *   transaction only when that insert inserted, so concurrent views record
 *   exactly one row and a failed audit write rolls the key back.
 */
import { AuditAction, AuditEntityType } from "@cuencada/types";
import { and, eq, lt, sql } from "drizzle-orm";
import type { Database } from "../../db/client.js";
import { eventAdminViews, events } from "../../db/schema/index.js";
import { recordAudit } from "../../lib/audit.js";
import { type EventViewer, isEventAdmin, isParticipantSql } from "./access.js";

/** Where the admin looked (`metadata.surface`). */
export const AdminViewSurface = {
  Detail: "detail",
  Chat: "chat",
  Media: "media"
} as const;
export type AdminViewSurface = (typeof AdminViewSurface)[keyof typeof AdminViewSurface];

const HOUR_MS = 60 * 60 * 1000;

/** `date_trunc('hour', at)` in UTC. */
export function hourBucketOf(at: Date): Date {
  return new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS);
}

/** Input of {@link auditAdminEventView}. */
export interface AdminViewInput {
  viewer: EventViewer;
  eventId: string;
  surface: AdminViewSurface;
  ip: string;
  now: Date;
}

/**
 * Record an admin's view of a `participants` event when they are not a
 * participant (deduped per hour). A no-op for non-admins, participants and
 * `members` events.
 *
 * @param db - The root client (runs its own transaction).
 * @returns `true` when an audit row was written.
 * @throws Whatever the database throws: callers must let it fail the read.
 */
export async function auditAdminEventView(db: Database, input: AdminViewInput): Promise<boolean> {
  const { viewer } = input;
  if (!isEventAdmin(viewer)) return false;
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select({ id: events.id })
      .from(events)
      .where(
        and(eq(events.id, input.eventId), eq(events.visibility, "participants"), sql`not ${isParticipantSql(viewer)}`)
      )
      .limit(1);
    if (target === undefined) return false;
    const bucket = hourBucketOf(input.now);
    const inserted = await tx
      .insert(eventAdminViews)
      .values({ adminUserId: viewer.id, eventId: target.id, hourBucket: bucket })
      .onConflictDoNothing()
      .returning({ eventId: eventAdminViews.eventId });
    if (inserted.length === 0) return false;
    await recordAudit(tx, {
      actorUserId: viewer.id,
      action: AuditAction.EventAdminViewed,
      entityType: AuditEntityType.Event,
      entityId: target.id,
      metadata: { surface: input.surface },
      ip: input.ip
    });
    // Keep the dedupe table small: this admin's keys from earlier windows are no longer needed.
    await tx
      .delete(eventAdminViews)
      .where(and(eq(eventAdminViews.adminUserId, viewer.id), lt(eventAdminViews.hourBucket, bucket)));
    return true;
  });
}
