/**
 * Media queries, visibility rules and response mapping (T4).
 *
 * Visibility (members): a row is visible when it is not deleted and either
 * - `ready` + `approved` (everyone), or
 * - the viewer's own upload in any state except `pending_upload` and `hidden`
 *   (so uploaders see their `processing`, `failed` and `pending_review` items).
 *
 * Admins additionally see every non-deleted, non-`pending_upload` row by id.
 * Responses never contain object keys or bucket names; media URLs are
 * presigned GETs.
 */
import type { AdminMediaItem, MediaItem, MediaReport, UserRole } from "@cuencada/types";
import { and, count, desc, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { cuencadas, mediaItems, mediaReports, users } from "../../db/schema/index.js";
import type { DbOrTx } from "../../lib/audit.js";
import type { StorageService } from "../../lib/storage/types.js";
import { VIEW_URL_SECONDS } from "./constants.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import { mediaKeys } from "./files.js";

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
  year: number;
  uploaderName: string | null;
  /** `created_at` as epoch microseconds (keyset cursor). */
  cursorMicros: string;
}

/** {@link MediaRecord} plus the admin-only aggregates. */
export interface AdminMediaRecord extends MediaRecord {
  reportCount: number;
  moderatedByName: string | null;
}

const moderator = alias(users, "moderator");

const cursorMicrosSql = sql<string>`(extract(epoch from ${mediaItems.createdAt}) * 1000000)::bigint::text`;

const reportCountSql = sql<number>`(select count(*)::int from ${mediaReports} where ${mediaReports.mediaId} = ${mediaItems.id})`;

/** True when the viewer is an admin. */
export function isAdmin(viewer: Viewer): boolean {
  return viewer.role === "admin";
}

/** SQL: rows a member may see (see module doc). */
export function memberVisibleSql(viewerId: string): SQL {
  return sql`(${mediaItems.deletedAt} is null and (
    (${mediaItems.uploadStatus} = 'ready' and ${mediaItems.moderationStatus} = 'approved')
    or (${mediaItems.uploadedByUserId} = ${viewerId}
        and ${mediaItems.uploadStatus} <> 'pending_upload'
        and ${mediaItems.moderationStatus} <> 'hidden')
  ))`;
}

/** SQL: rows the viewer may open by id (admins: any live, confirmed row). */
export function viewableSql(viewer: Viewer): SQL {
  return isAdmin(viewer) ? adminViewableSql() : memberVisibleSql(viewer.id);
}

/** SQL: rows an admin may open (live and confirmed). */
function adminViewableSql(): SQL {
  return sql`(${mediaItems.deletedAt} is null and ${mediaItems.uploadStatus} <> 'pending_upload')`;
}

/** SQL: rows everyone may see (`ready` + `approved`, live). */
export function publicVisibleSql(): SQL {
  return sql`(${mediaItems.deletedAt} is null and ${mediaItems.uploadStatus} = 'ready' and ${mediaItems.moderationStatus} = 'approved')`;
}

function keysetSql(rawCursor: string | undefined): SQL | undefined {
  if (rawCursor === undefined) return undefined;
  const cursor = decodeCursor(rawCursor);
  return sql`(${mediaItems.createdAt}, ${mediaItems.id}) < (to_timestamp(0) + ${cursor.micros}::bigint * interval '1 microsecond', ${cursor.id}::uuid)`;
}

function selectRecords(db: DbOrTx) {
  return db
    .select({
      item: mediaItems,
      year: cuencadas.year,
      uploaderName: users.displayName,
      cursorMicros: cursorMicrosSql
    })
    .from(mediaItems)
    .innerJoin(cuencadas, eq(cuencadas.id, mediaItems.cuencadaId))
    .leftJoin(users, eq(users.id, mediaItems.uploadedByUserId));
}

function selectAdminRecords(db: DbOrTx) {
  return db
    .select({
      item: mediaItems,
      year: cuencadas.year,
      uploaderName: users.displayName,
      cursorMicros: cursorMicrosSql,
      reportCount: reportCountSql,
      moderatedByName: moderator.displayName
    })
    .from(mediaItems)
    .innerJoin(cuencadas, eq(cuencadas.id, mediaItems.cuencadaId))
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
 * Load one record by id if the viewer may see it.
 *
 * @returns The record, or `null` (callers answer 404).
 */
export async function findViewableRecord(db: DbOrTx, id: string, viewer: Viewer): Promise<MediaRecord | null> {
  const [row] = await selectRecords(db)
    .where(and(eq(mediaItems.id, id), viewableSql(viewer)))
    .limit(1);
  return row ?? null;
}

/**
 * Load a live (not deleted) record by id regardless of visibility. Callers
 * must apply their own ownership/role rule before revealing anything.
 */
export async function findLiveRecord(db: DbOrTx, id: string): Promise<MediaRecord | null> {
  const [row] = await selectRecords(db)
    .where(and(eq(mediaItems.id, id), isNull(mediaItems.deletedAt)))
    .limit(1);
  return row ?? null;
}

/** Options for {@link listGallery}. */
export interface GalleryListOptions {
  cuencadaId: string;
  viewer: Viewer;
  limit: number;
  cursor?: string | undefined;
  kind?: MediaRow["kind"] | undefined;
}

/**
 * Gallery page for one Cuencada, newest first (`created_at desc, id desc`).
 * Admins get the member view here (plus their own items); the moderation
 * queue is `listAdmin`.
 */
export async function listGallery(db: DbOrTx, options: GalleryListOptions): Promise<RecordPage<MediaRecord>> {
  const rows = await selectRecords(db)
    .where(
      and(
        eq(mediaItems.cuencadaId, options.cuencadaId),
        memberVisibleSql(options.viewer.id),
        options.kind === undefined ? undefined : eq(mediaItems.kind, options.kind),
        keysetSql(options.cursor)
      )
    )
    .orderBy(desc(mediaItems.createdAt), desc(mediaItems.id))
    .limit(options.limit + 1);
  return toPage(rows, options.limit);
}

/** Filters for {@link listAdmin}. */
export interface AdminListOptions {
  limit: number;
  cursor?: string | undefined;
  moderationStatus?: MediaRow["moderationStatus"] | undefined;
  uploadStatus?: MediaRow["uploadStatus"] | undefined;
  cuencadaId?: string | undefined;
  reported?: boolean | undefined;
}

/**
 * Moderation queue: live rows, newest first. `pending_upload` rows are only
 * listed when asked for explicitly.
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
        options.uploadStatus === undefined
          ? sql`${mediaItems.uploadStatus} <> 'pending_upload'`
          : eq(mediaItems.uploadStatus, options.uploadStatus),
        options.moderationStatus === undefined ? undefined : eq(mediaItems.moderationStatus, options.moderationStatus),
        options.cuencadaId === undefined ? undefined : eq(mediaItems.cuencadaId, options.cuencadaId),
        reportedFilter,
        keysetSql(options.cursor)
      )
    )
    .orderBy(desc(mediaItems.createdAt), desc(mediaItems.id))
    .limit(options.limit + 1);
  return toPage(rows, options.limit);
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
  return row ?? null;
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
  return new Map(rows.map((row) => [row.cuencadaId, row.total]));
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
    createdAt: item.createdAt.toISOString()
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
 * keys plus, for images, the derivative keys a running job may be about to
 * write. De-duplicated (a video's display key is its original).
 *
 * @param item - The row.
 * @param year - Its Cuencada year (part of the key).
 */
export function allObjectKeys(item: MediaRow, year: number): string[] {
  const keys = [item.objectKey, item.thumbKey, item.displayKey].filter((key): key is string => key !== null);
  if (item.kind === "image") {
    const derived = mediaKeys(year, item.id, item.mimeType);
    keys.push(derived.thumb, derived.display);
  }
  return [...new Set(keys)];
}
