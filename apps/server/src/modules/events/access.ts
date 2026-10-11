/**
 * Event authorization predicates (ADR 0001 §7) [SEC]. **The** place that
 * decides who may see an event and who may use its chat and albums; every
 * list, by-slug and by-id route, the chat room rules and the media scope
 * build on these SQL fragments, so there is exactly one rule.
 *
 * - `published` + `members` → every member;
 * - `published` + `participants` → its participants and admins;
 * - `draft` → its organizers and admins;
 * - `hidden` → admins only.
 *
 * Chat and albums: the event must be visible **and** the caller a
 * participant or an admin.
 */
import type { UserRole } from "@cuencada/types";
import { type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { eventParticipants, events } from "../../db/schema/index.js";

/** Who is asking (same shape as the media `Viewer`). */
export interface EventViewer {
  id: string;
  role: UserRole;
}

/** The `events` table or an alias of it (subqueries use an alias). */
export interface EventsTable {
  id: AnyPgColumn;
  status: AnyPgColumn;
  visibility: AnyPgColumn;
}

/** True when the viewer is an admin (database role, loaded per request). */
export function isEventAdmin(viewer: EventViewer): boolean {
  return viewer.role === "admin";
}

/**
 * SQL: the viewer takes part in the event `table` (any role).
 *
 * @param viewer - The caller.
 * @param table - `events` or an alias of it.
 */
export function isParticipantSql(viewer: EventViewer, table: EventsTable = events): SQL {
  return sql`exists (select 1 from ${eventParticipants} ep_v
    where ep_v.event_id = ${table.id} and ep_v.user_id = ${viewer.id}::uuid)`;
}

/** SQL: the viewer organizes the event `table`. */
export function isOrganizerSql(viewer: EventViewer, table: EventsTable = events): SQL {
  return sql`exists (select 1 from ${eventParticipants} ep_o
    where ep_o.event_id = ${table.id} and ep_o.user_id = ${viewer.id}::uuid and ep_o.role = 'organizer')`;
}

/**
 * SQL: the viewer may see the event `table` (detail, list, participants,
 * cover). Admins see every event, `hidden` included; lists that must leave
 * hidden events out add their own status filter.
 *
 * @param viewer - The caller.
 * @param table - `events` or an alias of it.
 */
export function eventVisibleSql(viewer: EventViewer, table: EventsTable = events): SQL {
  if (isEventAdmin(viewer)) return sql`true`;
  return sql`((${table.status} = 'published' and (${table.visibility} = 'members' or ${isParticipantSql(viewer, table)}))
    or (${table.status} = 'draft' and ${isOrganizerSql(viewer, table)}))`;
}

/**
 * SQL: the viewer may use the event's chat and albums: the event is visible
 * and the viewer is a participant or an admin.
 */
export function eventMemberAccessSql(viewer: EventViewer, table: EventsTable = events): SQL {
  if (isEventAdmin(viewer)) return sql`true`;
  return sql`(${eventVisibleSql(viewer, table)} and ${isParticipantSql(viewer, table)})`;
}
