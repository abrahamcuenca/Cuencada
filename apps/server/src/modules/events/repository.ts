/**
 * Event data access (WP-5.3). Every query that returns an event to a member
 * filters with `eventVisibleSql(viewer)` in the same statement that looks the
 * event up, so a missing and an invisible event take the same path (404).
 */
import { type EventListWhen, EventRole, EventStatus, type EventVisibility } from "@cuencada/types";
import { and, asc, desc, eq, inArray, isNotNull, ne, type SQL, sql } from "drizzle-orm";
import { chatRooms, eventAlbums, eventParticipants, events, mediaItems, profiles, users } from "../../db/schema/index.js";
import type { DbOrTx, Transaction } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { memberVisibleSql } from "../media/service.js";
import { type EventViewer, eventVisibleSql, isEventAdmin } from "./access.js";
import { eventNotFound } from "./errors.js";

/** An `events` row. */
export type EventRow = typeof events.$inferSelect;

/** A visible event plus the caller's relation to it. */
export interface VisibleEvent {
  row: EventRow;
  /** The caller's role, `null` when not a participant. */
  viewerRole: EventRole | null;
  participantCount: number;
}

const viewerRoleSql = (viewer: EventViewer): SQL<EventRole | null> =>
  sql<EventRole | null>`(select ${eventParticipants.role} from ${eventParticipants}
    where ${eventParticipants.eventId} = ${events.id} and ${eventParticipants.userId} = ${viewer.id}::uuid)`;

const participantCountSql = sql<number>`(select count(*)::int from ${eventParticipants} where ${eventParticipants.eventId} = ${events.id})`.mapWith(
  Number
);

/**
 * Load an event the viewer may see, or throw 404 `EVENT_NOT_FOUND` [SEC].
 * One statement decides existence and visibility together.
 *
 * @param where - Identifies the event (`id`, or `year` + `slug`).
 */
export async function loadVisibleEvent(db: DbOrTx, viewer: EventViewer, where: SQL | undefined): Promise<VisibleEvent> {
  const [found] = await db
    .select({ row: events, viewerRole: viewerRoleSql(viewer), participantCount: participantCountSql })
    .from(events)
    .where(and(where, eventVisibleSql(viewer)))
    .limit(1);
  if (found === undefined) throw eventNotFound();
  return found;
}

/**
 * Lock the event row (`FOR UPDATE`) for a write, then load it if visible.
 * Both statements always run, so an unknown and an invisible id take the
 * same path. Serializes participant, album, cover and status changes of one
 * event (the last-organizer guard and the participant cap rely on it).
 */
export async function lockVisibleEvent(tx: Transaction, viewer: EventViewer, eventId: string): Promise<VisibleEvent> {
  await tx.execute(sql`select 1 from ${events} where ${events.id} = ${eventId}::uuid for update`);
  return loadVisibleEvent(tx, viewer, eq(events.id, eventId));
}

/** A participant row with what the event page may show. */
export interface ParticipantRecord {
  userId: string;
  role: EventRole;
  joinedAt: Date;
  displayName: string;
  userStatus: string;
  listedInDirectory: boolean;
  avatarKey: string | null;
}

/** Organizers first, then by join time (at most `limit`). */
export async function listParticipants(db: DbOrTx, eventId: string, limit: number): Promise<ParticipantRecord[]> {
  return db
    .select({
      userId: eventParticipants.userId,
      role: eventParticipants.role,
      joinedAt: eventParticipants.joinedAt,
      displayName: users.displayName,
      userStatus: users.status,
      listedInDirectory: sql<boolean>`coalesce(${profiles.listedInDirectory}, false)`,
      avatarKey: profiles.avatarKey
    })
    .from(eventParticipants)
    .innerJoin(users, eq(users.id, eventParticipants.userId))
    .leftJoin(profiles, eq(profiles.userId, eventParticipants.userId))
    .where(eq(eventParticipants.eventId, eventId))
    .orderBy(sql`(${eventParticipants.role} = 'organizer') desc`, asc(eventParticipants.joinedAt), asc(eventParticipants.userId))
    .limit(limit);
}

/** How many organizers the event has. */
export async function countOrganizers(db: DbOrTx, eventId: string): Promise<number> {
  const [row] = await db
    .select({ value: sql<number>`count(*)::int`.mapWith(Number) })
    .from(eventParticipants)
    .where(and(eq(eventParticipants.eventId, eventId), eq(eventParticipants.role, EventRole.Organizer)));
  return row?.value ?? 0;
}

/** An album with the caller's visible media count and newest visible image thumbnail key. */
export interface AlbumRecord {
  id: string;
  eventId: string;
  title: string;
  sortOrder: number;
  createdAt: Date;
  mediaCount: number;
  coverThumbKey: string | null;
}

/** Columns of {@link AlbumRecord}; counts follow the gallery's member visibility for `viewerId`. */
function albumColumns(viewerId: string) {
  return {
    id: eventAlbums.id,
    eventId: eventAlbums.eventId,
    title: eventAlbums.title,
    sortOrder: eventAlbums.sortOrder,
    createdAt: eventAlbums.createdAt,
    mediaCount: sql<number>`(select count(*)::int from ${mediaItems}
      where ${mediaItems.albumId} = ${eventAlbums.id} and ${memberVisibleSql(viewerId)})`.mapWith(Number),
    coverThumbKey: sql<string | null>`(select ${mediaItems.thumbKey} from ${mediaItems}
      where ${mediaItems.albumId} = ${eventAlbums.id} and ${memberVisibleSql(viewerId)}
        and ${mediaItems.kind} = 'image' and ${mediaItems.uploadStatus} = 'ready' and ${mediaItems.thumbKey} is not null
      order by ${mediaItems.createdAt} desc, ${mediaItems.id} desc limit 1)`
  };
}

/** The event's albums (sort order, then creation), with per-caller counts. */
export async function listAlbums(db: DbOrTx, eventId: string, viewerId: string): Promise<AlbumRecord[]> {
  return db
    .select(albumColumns(viewerId))
    .from(eventAlbums)
    .where(eq(eventAlbums.eventId, eventId))
    .orderBy(asc(eventAlbums.sortOrder), asc(eventAlbums.createdAt), asc(eventAlbums.id));
}

/** One album of the event, or `null`. */
export async function findAlbum(db: DbOrTx, eventId: string, albumId: string, viewerId: string): Promise<AlbumRecord | null> {
  const [row] = await db
    .select(albumColumns(viewerId))
    .from(eventAlbums)
    .where(and(eq(eventAlbums.eventId, eventId), eq(eventAlbums.id, albumId)))
    .limit(1);
  return row ?? null;
}

/** True when any media row (soft-deleted included) is in one of the event's albums. */
export async function eventHasMedia(db: DbOrTx, eventId: string): Promise<boolean> {
  const [row] = await db.execute<{ found: boolean }>(sql`
    select exists (
      select 1 from ${mediaItems} m inner join ${eventAlbums} a on a.id = m.album_id where a.event_id = ${eventId}::uuid
    ) as found
  `);
  return row?.found === true;
}

/** The event's chat room id, if any. */
export async function findEventRoomId(db: DbOrTx, eventId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: chatRooms.id })
    .from(chatRooms)
    .where(and(eq(chatRooms.kind, "event"), eq(chatRooms.eventId, eventId)))
    .limit(1);
  return row?.id ?? null;
}

/* -------------------------------------------------------------------------- */
/* Lists                                                                       */
/* -------------------------------------------------------------------------- */

/** Keyset position of `GET /api/events` (see {@link listEventSummaries}). */
export interface EventListCursor {
  year: number;
  /** `starts_at is null` (upcoming) or `starts_at is not null` (past). */
  flag: boolean;
  /** `starts_at` as epoch microseconds, `0` when undated. */
  micros: string;
  id: string;
}

/** `starts_at` as epoch microseconds (`0` when undated), a stable keyset column. */
const startsMicrosSql = sql<string>`coalesce((extract(epoch from ${events.startsAt}) * 1000000)::bigint, 0)::text`;

/** SQL: the event is over (same rule as `isPastEvent` and WP-5.1's editions). */
export function pastEventSql(now: Date): SQL {
  const at = sql`${now.toISOString()}::timestamptz`;
  return sql`((${events.endsAt} is not null and ${events.endsAt} < ${at})
    or (${events.endsAt} is null and ${events.year} < extract(year from (${at} at time zone ${events.timezone}))::int))`;
}

/** A row of the member list. */
export interface EventListRecord {
  row: EventRow;
  viewerRole: EventRole | null;
  participantCount: number;
  startsMicros: string;
}

/** Options of {@link listEventSummaries}. */
export interface EventListOptions {
  viewer: EventViewer;
  when: EventListWhen;
  year?: number | undefined;
  mine?: boolean | undefined;
  cursor: EventListCursor | null;
  limit: number;
  now: Date;
}

/**
 * The events the viewer may see (never `hidden`, admins included: they use
 * the admin list), keyset paged. Upcoming: `year, starts_at nulls last, id`
 * ascending; past: the same keys descending with undated events last.
 */
export async function listEventSummaries(db: DbOrTx, options: EventListOptions): Promise<EventListRecord[]> {
  const { viewer, cursor } = options;
  const upcoming = options.when === "upcoming";
  const flag = upcoming ? sql`(${events.startsAt} is null)` : sql`(${events.startsAt} is not null)`;
  const micros = sql`coalesce((extract(epoch from ${events.startsAt}) * 1000000)::bigint, 0)`;
  const keyset =
    cursor === null
      ? undefined
      : upcoming
        ? sql`(${events.year}, ${flag}, ${micros}, ${events.id}) > (${cursor.year}::int, ${cursor.flag}::boolean, ${cursor.micros}::bigint, ${cursor.id}::uuid)`
        : sql`(${events.year}, ${flag}, ${micros}, ${events.id}) < (${cursor.year}::int, ${cursor.flag}::boolean, ${cursor.micros}::bigint, ${cursor.id}::uuid)`;
  const direction = upcoming ? asc : desc;
  return db
    .select({
      row: events,
      viewerRole: viewerRoleSql(viewer),
      participantCount: participantCountSql,
      startsMicros: startsMicrosSql
    })
    .from(events)
    .where(
      and(
        eventVisibleSql(viewer),
        ne(events.status, EventStatus.Hidden),
        upcoming ? sql`not ${pastEventSql(options.now)}` : pastEventSql(options.now),
        options.year === undefined ? undefined : eq(events.year, options.year),
        options.mine === true
          ? sql`exists (select 1 from ${eventParticipants} where ${eventParticipants.eventId} = ${events.id} and ${eventParticipants.userId} = ${viewer.id}::uuid)`
          : undefined,
        keyset
      )
    )
    .orderBy(direction(events.year), direction(flag), direction(micros), direction(events.id))
    .limit(options.limit + 1);
}

/** A row of the admin list. */
export interface AdminEventRecord extends EventListRecord {
  createdByName: string | null;
  mediaCount: number;
  createdMicros: string;
}

/** Options of {@link listAdminEvents}. */
export interface AdminEventListOptions {
  viewer: EventViewer;
  status?: EventStatus | undefined;
  visibility?: EventVisibility | undefined;
  year?: number | undefined;
  cursor: { micros: string; id: string } | null;
  limit: number;
}

/** Every event (hidden and drafts included), newest `created_at` first. Admins only. */
export async function listAdminEvents(db: DbOrTx, options: AdminEventListOptions): Promise<AdminEventRecord[]> {
  if (!isEventAdmin(options.viewer)) throw new AppError("FORBIDDEN");
  const createdMicros = sql<string>`(extract(epoch from ${events.createdAt}) * 1000000)::bigint::text`;
  const { cursor } = options;
  return db
    .select({
      row: events,
      viewerRole: viewerRoleSql(options.viewer),
      participantCount: participantCountSql,
      startsMicros: startsMicrosSql,
      createdByName: users.displayName,
      mediaCount: sql<number>`(select count(*)::int from ${mediaItems} m inner join ${eventAlbums} a on a.id = m.album_id
        where a.event_id = ${events.id} and m.deleted_at is null)`.mapWith(Number),
      createdMicros
    })
    .from(events)
    .leftJoin(users, eq(users.id, events.createdByUserId))
    .where(
      and(
        options.status === undefined ? undefined : eq(events.status, options.status),
        options.visibility === undefined ? undefined : eq(events.visibility, options.visibility),
        options.year === undefined ? undefined : eq(events.year, options.year),
        cursor === null
          ? undefined
          : sql`(${events.createdAt}, ${events.id}) < (to_timestamp(0) + ${cursor.micros}::bigint * interval '1 microsecond', ${cursor.id}::uuid)`
      )
    )
    .orderBy(desc(events.createdAt), desc(events.id))
    .limit(options.limit + 1);
}

/* -------------------------------------------------------------------------- */
/* Participants                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Of `userIds`, the accounts that may be added [SEC]: active and verified;
 * for a non-admin organizer also listed in the directory (the set the
 * directory shows), so the picker cannot reach hidden members.
 */
export async function eligibleParticipantIds(
  db: DbOrTx,
  userIds: readonly string[],
  requireListed: boolean
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .leftJoin(profiles, eq(profiles.userId, users.id))
    .where(
      and(
        inArray(users.id, [...userIds]),
        eq(users.status, "active"),
        isNotNull(users.emailVerifiedAt),
        requireListed ? eq(profiles.listedInDirectory, true) : undefined
      )
    );
  return new Set(rows.map((row) => row.id));
}

/** Current participants among `userIds`. */
export async function existingParticipantIds(db: DbOrTx, eventId: string, userIds: readonly string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await db
    .select({ userId: eventParticipants.userId })
    .from(eventParticipants)
    .where(and(eq(eventParticipants.eventId, eventId), inArray(eventParticipants.userId, [...userIds])));
  return new Set(rows.map((row) => row.userId));
}
