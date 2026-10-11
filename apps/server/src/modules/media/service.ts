/**
 * Media queries, visibility rules and response mapping (T4, scopes WP-5.3).
 *
 * **Scope** (WP-5.2/5.3, ADR 0001 §7) [SEC]: every row belongs to an edition
 * (`cuencada_id`) or an event album (`album_id`). {@link mediaScopeSql}
 * decides whether the viewer may reach a row's scope at all: edition media
 * as before (every member), album media only for the event's participants
 * and admins while the event is visible to them. Every by-id read and write
 * applies it, so album media outside the caller's scope answer 404.
 *
 * Visibility within a scope (members): a row is visible when it is not
 * deleted and either
 * - `ready` + `approved` (everyone), or
 * - the viewer's own upload in any state except `pending_upload` and `hidden`
 *   (so uploaders see their `processing`, `failed` and `pending_review` items).
 *
 * Admins additionally see every non-deleted, non-`pending_upload` row by id.
 * Responses never contain object keys or bucket names; media URLs are
 * presigned GETs.
 */
import type { AdminMediaItem, EventRef, MediaAlbumRef, MediaItem, MediaReport, UserRole } from "@cuencada/types";
import { and, count, desc, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { cuencadas, eventAlbums, events, mediaItems, mediaReports, users } from "../../db/schema/index.js";
import type { DbOrTx } from "../../lib/audit.js";
import type { StorageService } from "../../lib/storage/types.js";
import { eventMemberAccessSql } from "../events/access.js";
import { VIEW_URL_SECONDS } from "./constants.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import { mediaKeys, storagePrefixOf } from "./files.js";

/** A `media_items` row. */
export type MediaRow = typeof mediaItems.$inferSelect;

/** Who is asking. */
export interface Viewer {
  id: string;
  role: UserRole;
}

/** A row plus the joined fields every response needs. */
export interface MediaRecord {
  item: MediaRow;
  /** The edition year; `null` for album media. */
  year: number | null;
  uploaderName: string | null;
  /** `created_at` as epoch microseconds (keyset cursor). */
  cursorMicros: string;
  /** The event album (album media only). */
  album: MediaAlbumRef | null;
  /** The album's event (album media only). */
  event: EventRef | null;
}

/** {@link MediaRecord} plus the admin-only aggregates. */
export interface AdminMediaRecord extends MediaRecord {
  reportCount: number;
  moderatedByName: string | null;
}

const moderator = alias(users, "moderator");
/**
 * Aliases for the scope subquery (the outer query may join the real tables).
 * A drizzle alias renders as its name only, so the subquery spells
 * `from <table> <alias>` itself.
 */
const scopeAlbum = alias(eventAlbums, "scope_album");
const scopeEvent = alias(events, "scope_event");

const cursorMicrosSql = sql<string>`(extract(epoch from ${mediaItems.createdAt}) * 1000000)::bigint::text`;

const reportCountSql = sql<number>`(select count(*)::int from ${mediaReports} where ${mediaReports.mediaId} = ${mediaItems.id})`;

/** True when the viewer is an admin. */
export function isAdmin(viewer: Viewer): boolean {
  return viewer.role === "admin";
}

/**
 * SQL [SEC]: the viewer may reach the row's scope. Edition media: always
 * (unchanged member rule). Album media: the event is visible to the viewer
 * and the viewer is a participant or an admin (ADR 0001 §7, Security
 * requirement 1). Admins reach every scope.
 */
export function mediaScopeSql(viewer: Viewer): SQL {
  if (isAdmin(viewer)) return sql`true`;
  return sql`(${mediaItems.albumId} is null or exists (
    select 1 from ${eventAlbums} scope_album
    inner join ${events} scope_event on ${scopeEvent.id} = ${scopeAlbum.eventId}
    where ${scopeAlbum.id} = ${mediaItems.albumId} and ${eventMemberAccessSql(viewer, scopeEvent)}
  ))`;
}

/** SQL: rows a member may see within a scope they can reach (see module doc). */
export function memberVisibleSql(viewerId: string): SQL {
  return sql`(${mediaItems.deletedAt} is null and (
    (${mediaItems.uploadStatus} = 'ready' and ${mediaItems.moderationStatus} = 'approved')
    or (${mediaItems.uploadedByUserId} = ${viewerId}
        and ${mediaItems.uploadStatus} <> 'pending_upload'
        and ${mediaItems.moderationStatus} <> 'hidden')
  ))`;
}

/** SQL: rows the viewer may open by id (scope first; admins: any live, confirmed row). */
export function viewableSql(viewer: Viewer): SQL {
  return isAdmin(viewer) ? adminViewableSql() : sql`(${mediaScopeSql(viewer)} and ${memberVisibleSql(viewer.id)})`;
}

/** SQL: rows an admin may open (live and confirmed). */
function adminViewableSql(): SQL {
  return sql`(${mediaItems.deletedAt} is null and ${mediaItems.uploadStatus} <> 'pending_upload')`;
}

/** SQL: rows everyone may see (`ready` + `approved`, live). Callers add the scope. */
export function publicVisibleSql(): SQL {
  return sql`(${mediaItems.deletedAt} is null and ${mediaItems.uploadStatus} = 'ready' and ${mediaItems.moderationStatus} = 'approved')`;
}

function keysetSql(rawCursor: string | undefined): SQL | undefined {
  if (rawCursor === undefined) return undefined;
  const cursor = decodeCursor(rawCursor);
  return sql`(${mediaItems.createdAt}, ${mediaItems.id}) < (to_timestamp(0) + ${cursor.micros}::bigint * interval '1 microsecond', ${cursor.id}::uuid)`;
}

/** Columns shared by member and admin records (left joins: one of the two scopes is null). */
const recordColumns = {
  item: mediaItems,
  year: cuencadas.year,
  uploaderName: users.displayName,
  cursorMicros: cursorMicrosSql,
  albumId: eventAlbums.id,
  albumTitle: eventAlbums.title,
  eventId: events.id,
  eventYear: events.year,
  eventSlug: events.slug,
  eventTitle: events.title
};

type RecordRow = {
  item: MediaRow;
  year: number | null;
  uploaderName: string | null;
  cursorMicros: string;
  albumId: string | null;
  albumTitle: string | null;
  eventId: string | null;
  eventYear: number | null;
  eventSlug: string | null;
  eventTitle: string | null;
};

type RefKeys = "albumId" | "albumTitle" | "eventId" | "eventYear" | "eventSlug" | "eventTitle";

function toRecord<TRow extends RecordRow>(row: TRow): Omit<TRow, RefKeys> & Pick<MediaRecord, "album" | "event"> {
  const { albumId, albumTitle, eventId, eventYear, eventSlug, eventTitle, ...rest } = row;
  const album =
    albumId !== null && albumTitle !== null && eventId !== null ? { id: albumId, title: albumTitle, eventId } : null;
  const event =
    eventId !== null && eventYear !== null && eventSlug !== null && eventTitle !== null
      ? { id: eventId, year: eventYear, slug: eventSlug, title: eventTitle }
      : null;
  return { ...rest, album, event };
}

function selectRecords(db: DbOrTx) {
  return db
    .select(recordColumns)
    .from(mediaItems)
    .leftJoin(cuencadas, eq(cuencadas.id, mediaItems.cuencadaId))
    .leftJoin(eventAlbums, eq(eventAlbums.id, mediaItems.albumId))
    .leftJoin(events, eq(events.id, eventAlbums.eventId))
    .leftJoin(users, eq(users.id, mediaItems.uploadedByUserId));
}

function selectAdminRecords(db: DbOrTx) {
  return db
    .select({ ...recordColumns, reportCount: reportCountSql, moderatedByName: moderator.displayName })
    .from(mediaItems)
    .leftJoin(cuencadas, eq(cuencadas.id, mediaItems.cuencadaId))
    .leftJoin(eventAlbums, eq(eventAlbums.id, mediaItems.albumId))
    .leftJoin(events, eq(events.id, eventAlbums.eventId))
    .leftJoin(users, eq(users.id, mediaItems.uploadedByUserId))
    .leftJoin(moderator, eq(moderator.id, mediaItems.moderatedByUserId));
}

/** A page of records plus the cursor for the next one. */
export interface RecordPage<TRecord> {
  records: TRecord[];
  nextCursor: string | null;
}

function toPage<TRecord extends MediaRecord>(rows: TRecord[], limit: number): RecordPage<TRecord> {
  const records = rows.slice(0, limit);
  const last = records.at(-1);
  const nextCursor =
    rows.length > limit && last !== undefined ? encodeCursor({ micros: last.cursorMicros, id: last.item.id }) : null;
  return { records, nextCursor };
}

/**
 * Load one record by id if the viewer may see it (scope first).
 *
 * @returns The record, or `null` (callers answer 404).
 */
export async function findViewableRecord(db: DbOrTx, id: string, viewer: Viewer): Promise<MediaRecord | null> {
  const [row] = await selectRecords(db)
    .where(and(eq(mediaItems.id, id), viewableSql(viewer)))
    .limit(1);
  return row === undefined ? null : toRecord(row);
}

/**
 * Load a live (not deleted) record by id within the viewer's scope
 * ({@link mediaScopeSql}), regardless of upload/moderation state. Callers
 * must apply their own ownership/role rule before revealing anything.
 */
export async function findLiveRecord(db: DbOrTx, id: string, viewer: Viewer): Promise<MediaRecord | null> {
  const [row] = await selectRecords(db)
    .where(and(eq(mediaItems.id, id), isNull(mediaItems.deletedAt), mediaScopeSql(viewer)))
    .limit(1);
  return row === undefined ? null : toRecord(row);
}

/**
 * Load any record by id (deleted included) within the viewer's scope. For
 * the idempotent delete, which must also find already deleted rows.
 */
export async function findScopedRecord(db: DbOrTx, id: string, viewer: Viewer): Promise<MediaRecord | null> {
  const [row] = await selectRecords(db)
    .where(and(eq(mediaItems.id, id), mediaScopeSql(viewer)))
    .limit(1);
  return row === undefined ? null : toRecord(row);
}

/** Options for {@link listGallery}: exactly one scope. */
export type GalleryListOptions = ({ cuencadaId: string; albumId?: never } | { albumId: string; cuencadaId?: never }) & {
  viewer: Viewer;
  limit: number;
  cursor?: string | undefined;
  kind?: MediaRow["kind"] | undefined;
};

/**
 * Gallery page for one Cuencada or one event album, newest first
 * (`created_at desc, id desc`). Admins get the member view here (plus their
 * own items); the moderation queue is `listAdmin`. Callers check that the
 * viewer may reach the scope (the edition is published / the viewer takes
 * part in the event).
 */
export async function listGallery(db: DbOrTx, options: GalleryListOptions): Promise<RecordPage<MediaRecord>> {
  const scope =
    options.albumId !== undefined ? eq(mediaItems.albumId, options.albumId) : eq(mediaItems.cuencadaId, options.cuencadaId);
  const rows = await selectRecords(db)
    .where(
      and(
        scope,
        memberVisibleSql(options.viewer.id),
        options.kind === undefined ? undefined : eq(mediaItems.kind, options.kind),
        keysetSql(options.cursor)
      )
    )
    .orderBy(desc(mediaItems.createdAt), desc(mediaItems.id))
    .limit(options.limit + 1);
  return toPage(rows.map(toRecord), options.limit);
}

/** Filters for {@link listAdmin}. */
export interface AdminListOptions {
  viewer: Viewer;
  limit: number;
  cursor?: string | undefined;
  moderationStatus?: MediaRow["moderationStatus"] | undefined;
  uploadStatus?: MediaRow["uploadStatus"] | undefined;
  cuencadaId?: string | undefined;
  /** WP-5.3: only media of this event's albums. */
  eventId?: string | undefined;
  reported?: boolean | undefined;
}

/**
 * Moderation queue: live rows of every scope (edition and album media, left
 * joins + {@link mediaScopeSql}, Security requirement 10), newest first.
 * `pending_upload` rows are only listed when asked for explicitly.
 */
export async function listAdmin(db: DbOrTx, options: AdminListOptions): Promise<RecordPage<AdminMediaRecord>> {
  const reportedFilter =
    options.reported === undefined
      ? undefined
      : options.reported
        ? sql`exists (select 1 from ${mediaReports} where ${mediaReports.mediaId} = ${mediaItems.id})`
        : sql`not exists (select 1 from ${mediaReports} where ${mediaReports.mediaId} = ${mediaItems.id})`;
  const rows = await selectAdminRecords(db)
    .where(
      and(
        isNull(mediaItems.deletedAt),
        mediaScopeSql(options.viewer),
        options.uploadStatus === undefined
          ? sql`${mediaItems.uploadStatus} <> 'pending_upload'`
          : eq(mediaItems.uploadStatus, options.uploadStatus),
        options.moderationStatus === undefined ? undefined : eq(mediaItems.moderationStatus, options.moderationStatus),
        options.cuencadaId === undefined ? undefined : eq(mediaItems.cuencadaId, options.cuencadaId),
        options.eventId === undefined ? undefined : eq(eventAlbums.eventId, options.eventId),
        reportedFilter,
        keysetSql(options.cursor)
      )
    )
    .orderBy(desc(mediaItems.createdAt), desc(mediaItems.id))
    .limit(options.limit + 1);
  return toPage(rows.map(toRecord), options.limit);
}

/**
 * Load one admin record (live, confirmed rows only).
 *
 * @returns The record, or `null` (404).
 */
export async function findAdminRecord(db: DbOrTx, id: string): Promise<AdminMediaRecord | null> {
  const [row] = await selectAdminRecords(db)
    .where(and(eq(mediaItems.id, id), adminViewableSql()))
    .limit(1);
  return row === undefined ? null : toRecord(row);
}

/**
 * Count `ready` + `approved` media per Cuencada. Exported so T2 can compute
 * `CuencadaSummary.hasMedia` with the same visibility rule (no duplicate
 * `/api/media/years` endpoint).
 *
 * @param cuencadaIds - Editions to count; empty → empty map.
 */
export async function countVisibleMediaByCuencada(db: DbOrTx, cuencadaIds: string[]): Promise<Map<string, number>> {
  if (cuencadaIds.length === 0) return new Map();
  const rows = await db
    .select({ cuencadaId: mediaItems.cuencadaId, total: count() })
    .from(mediaItems)
    .where(and(inArray(mediaItems.cuencadaId, cuencadaIds), publicVisibleSql()))
    .groupBy(mediaItems.cuencadaId);
  // `cuencada_id` is nullable since WP-5.2 (album media); the `inArray` filter already excludes nulls.
  return new Map(rows.flatMap((row) => (row.cuencadaId === null ? [] : [[row.cuencadaId, row.total] as const])));
}

/** Reports on one item, newest first (bounded). */
export async function listReports(db: DbOrTx, mediaId: string): Promise<MediaReport[]> {
  const rows = await db
    .select({
      id: mediaReports.id,
      reason: mediaReports.reason,
      details: mediaReports.details,
      reporterName: users.displayName,
      createdAt: mediaReports.createdAt
    })
    .from(mediaReports)
    .leftJoin(users, eq(users.id, mediaReports.reporterUserId))
    .where(eq(mediaReports.mediaId, mediaId))
    .orderBy(desc(mediaReports.createdAt), desc(mediaReports.id))
    .limit(500);
  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}

async function presign(storage: StorageService, key: string | null): Promise<string | null> {
  if (key === null) return null;
  const signed = await storage.presignGet({ key, expiresInSeconds: VIEW_URL_SECONDS });
  return signed.url;
}

/**
 * Map a record to the member contract, presigning the view URLs (1 h).
 * Only `ready` items get URLs; videos have no thumbnail and display the original.
 * `album`/`event` are set for album media (the record passed the scope check,
 * so the viewer may see that event).
 */
export async function toMediaItem(storage: StorageService, record: MediaRecord, viewer: Viewer): Promise<MediaItem> {
  const { item } = record;
  const ready = item.uploadStatus === "ready";
  const [thumbUrl, displayUrl] = await Promise.all([
    presign(storage, ready ? item.thumbKey : null),
    presign(storage, ready ? item.displayKey : null)
  ]);
  const isMine = item.uploadedByUserId === viewer.id;
  const canManage = isMine || isAdmin(viewer);
  return {
    id: item.id,
    cuencadaId: item.cuencadaId,
    year: record.year,
    kind: item.kind,
    mimeType: item.mimeType,
    thumbUrl,
    displayUrl,
    width: item.width,
    height: item.height,
    durationSeconds: item.durationSeconds,
    caption: item.caption,
    uploaderName: record.uploaderName,
    isMine,
    canEdit: canManage,
    canDelete: canManage,
    uploadStatus: item.uploadStatus,
    moderationStatus: item.moderationStatus,
    createdAt: item.createdAt.toISOString(),
    album: item.albumId === null ? null : record.album,
    event: item.albumId === null ? null : record.event
  };
}

/** Map an admin record to `AdminMediaItem`. */
export async function toAdminMediaItem(
  storage: StorageService,
  record: AdminMediaRecord,
  viewer: Viewer
): Promise<AdminMediaItem> {
  const base = await toMediaItem(storage, record, viewer);
  const { item } = record;
  return {
    ...base,
    uploaderUserId: item.uploadedByUserId,
    fileName: item.fileName,
    byteSize: item.byteSize,
    reportCount: record.reportCount,
    moderatedAt: item.moderatedAt?.toISOString() ?? null,
    moderatedByName: record.moderatedByName,
    moderationNote: item.moderationNote
  };
}

/**
 * Every object key a row may own: the recorded original/thumbnail/display
 * keys plus the derivative keys a running job may be about to write (the
 * display copy for every kind, the thumbnail for images). De-duplicated.
 *
 * @param item - The row.
 * @param year - Its edition year, for legacy rows without `storage_prefix`
 *   (`null` for album media, which always have a prefix).
 */
export function allObjectKeys(item: MediaRow, year: number | null): string[] {
  const keys = [item.objectKey, item.thumbKey, item.displayKey].filter((key): key is string => key !== null);
  const derived = mediaKeys(storagePrefixOf(item, year), item.id, item.mimeType);
  // Videos: `display/{id}.mp4|.mov` (the scrubbed copy). Images: both WebP copies.
  keys.push(derived.display);
  if (item.kind === "image") keys.push(derived.thumb);
  return [...new Set(keys)];
}
