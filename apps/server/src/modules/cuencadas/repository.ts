/**
 * Cuencada queries. Content for several editions is always loaded with one
 * query per table (`where cuencada_id = any(...)`), never per edition.
 *
 * `hasMedia` reads `media_items` (owned by T4/media) read-only through an
 * EXISTS on its gallery keyset index; nothing here writes media rows.
 */
import { MediaUploadStatus, ModerationStatus, Visibility } from "@cuencada/types";
import { and, asc, desc, eq, inArray, type SQL, sql } from "drizzle-orm";
import {
  chatRooms,
  cuencadaItineraryItems,
  cuencadaLocations,
  cuencadas,
  dailyMessages,
  mediaItems
} from "../../db/schema/index.js";
import type { DbOrTx } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { type AnnouncementRow, listAllAnnouncementsFor, listLiveAnnouncements } from "../announcements/repository.js";
import type { CuencadaRow, DailyMessageRow, ItineraryRow, LocationRow } from "./mappers.js";

/** Spanish 404 message used by every Cuencada lookup. */
export const CUENCADA_NOT_FOUND = "No encontramos esa Cuencada.";

/** True when the edition has a visible gallery item (approved, ready, not deleted). */
// Column names are spelled out with explicit table qualifiers: in a
// single-table select Drizzle renders `${column}` unqualified, which inside
// this subquery would bind `id` to media_items instead of the outer cuencadas.
const hasMediaSql = sql<boolean>`exists (
  select 1 from media_items m
  where m.cuencada_id = "cuencadas"."id"
    and m.deleted_at is null
    and m.upload_status = ${MediaUploadStatus.Ready}
    and m.moderation_status = ${ModerationStatus.Approved}
)`;

/** A published edition with its `hasMedia` flag. */
export interface PublishedEdition {
  row: CuencadaRow;
  hasMedia: boolean;
}

/**
 * Every published edition, newest year first, with `hasMedia`. The list is
 * small (one edition per year), so status is computed in the caller.
 *
 * @param db - Client or transaction.
 */
export async function listPublishedEditions(db: DbOrTx): Promise<PublishedEdition[]> {
  const rows = await db
    .select({ row: cuencadas, hasMedia: hasMediaSql })
    .from(cuencadas)
    .where(eq(cuencadas.isPublished, true))
    .orderBy(desc(cuencadas.year));
  return rows.map(({ row, hasMedia }) => ({ row, hasMedia: Boolean(hasMedia) }));
}

/**
 * A published edition by year.
 *
 * @param db - Client or transaction.
 * @param year - Edition year.
 * @throws AppError `NOT_FOUND` when missing or a draft.
 */
export async function getPublishedByYear(db: DbOrTx, year: number): Promise<CuencadaRow> {
  const [row] = await db
    .select()
    .from(cuencadas)
    .where(and(eq(cuencadas.year, year), eq(cuencadas.isPublished, true)))
    .limit(1);
  if (row === undefined) throw new AppError("NOT_FOUND", CUENCADA_NOT_FOUND);
  return row;
}

/**
 * Any edition (drafts included) by id, optionally locked `for update`.
 *
 * @param db - Client or transaction (use a transaction with `lock`).
 * @param id - Cuencada id.
 * @param lock - Take a row lock for the rest of the transaction.
 * @throws AppError `NOT_FOUND`.
 */
export async function getCuencadaById(db: DbOrTx, id: string, lock = false): Promise<CuencadaRow> {
  const query = db.select().from(cuencadas).where(eq(cuencadas.id, id)).limit(1);
  const [row] = lock ? await query.for("update") : await query;
  if (row === undefined) throw new AppError("NOT_FOUND", CUENCADA_NOT_FOUND);
  return row;
}

/** Content lists of several editions, grouped by Cuencada id. */
export interface EditionContent {
  itinerary: ItineraryRow[];
  locations: LocationRow[];
  announcements: AnnouncementRow[];
}

/** How much content to load. */
export const ContentScope = {
  /** Public items and live public announcements (anonymous). */
  Public: "public",
  /** All items and live announcements of any visibility (members). */
  Members: "members",
  /** All items and every announcement, scheduled/expired included (admins). */
  Admin: "admin"
} as const;
export type ContentScope = (typeof ContentScope)[keyof typeof ContentScope];

function visibilityFilter(scope: ContentScope, column: typeof cuencadaItineraryItems.visibility | typeof cuencadaLocations.visibility): SQL | undefined {
  return scope === ContentScope.Public ? eq(column, Visibility.Public) : undefined;
}

/**
 * Load itinerary, locations and announcements of `cuencadaIds` in three
 * queries total (no per-edition queries).
 *
 * @param db - Client or transaction.
 * @param cuencadaIds - Editions to load.
 * @param scope - Visibility scope.
 * @param now - Current instant (announcement publish/expiry window).
 * @returns A map with an entry (possibly empty lists) for every requested id.
 */
export async function loadEditionContent(
  db: DbOrTx,
  cuencadaIds: readonly string[],
  scope: ContentScope,
  now: Date
): Promise<Map<string, EditionContent>> {
  const result = new Map<string, EditionContent>();
  for (const id of cuencadaIds) result.set(id, { itinerary: [], locations: [], announcements: [] });
  if (cuencadaIds.length === 0) return result;
  const ids = [...cuencadaIds];

  const [itinerary, locations, announcementRows] = await Promise.all([
    db
      .select()
      .from(cuencadaItineraryItems)
      .where(and(inArray(cuencadaItineraryItems.cuencadaId, ids), visibilityFilter(scope, cuencadaItineraryItems.visibility)))
      .orderBy(
        asc(cuencadaItineraryItems.sortOrder),
        asc(cuencadaItineraryItems.date),
        sql`${cuencadaItineraryItems.startTime} asc nulls first`,
        asc(cuencadaItineraryItems.id)
      ),
    db
      .select()
      .from(cuencadaLocations)
      .where(and(inArray(cuencadaLocations.cuencadaId, ids), visibilityFilter(scope, cuencadaLocations.visibility)))
      .orderBy(asc(cuencadaLocations.sortOrder), asc(cuencadaLocations.name), asc(cuencadaLocations.id)),
    scope === ContentScope.Admin
      ? listAllAnnouncementsFor(db, ids)
      : listLiveAnnouncements(db, {
          cuencadaIds: ids,
          visibilities: scope === ContentScope.Public ? [Visibility.Public] : [Visibility.Public, Visibility.Members],
          now
        })
  ]);

  for (const item of itinerary) result.get(item.cuencadaId)?.itinerary.push(item);
  for (const location of locations) result.get(location.cuencadaId)?.locations.push(location);
  for (const announcement of announcementRows) {
    if (announcement.cuencadaId !== null) result.get(announcement.cuencadaId)?.announcements.push(announcement);
  }
  return result;
}

/**
 * Message for one Cuencada and calendar date, if any.
 *
 * @param db - Client or transaction.
 * @param cuencadaId - Edition.
 * @param date - `YYYY-MM-DD` in the edition's timezone.
 */
export async function findDailyMessage(db: DbOrTx, cuencadaId: string, date: string): Promise<DailyMessageRow | undefined> {
  const [row] = await db
    .select()
    .from(dailyMessages)
    .where(and(eq(dailyMessages.cuencadaId, cuencadaId), eq(dailyMessages.date, date)))
    .limit(1);
  return row;
}

/**
 * Create the edition's chat room if it does not exist yet (idempotent via the
 * partial unique index `chat_rooms_cuencada_unique`).
 *
 * @param db - The publishing transaction.
 * @param cuencada - Edition id and year (for the room title).
 * @returns `true` when a room was created now.
 */
export async function ensureCuencadaChatRoom(db: DbOrTx, cuencada: Pick<CuencadaRow, "id" | "year">): Promise<boolean> {
  const created = await db
    .insert(chatRooms)
    .values({ kind: "cuencada", cuencadaId: cuencada.id, title: `Cuencada ${cuencada.year}` })
    .onConflictDoNothing({ target: chatRooms.cuencadaId, where: sql`kind = 'cuencada'` })
    .returning({ id: chatRooms.id });
  return created.length > 0;
}

/**
 * Why a draft cannot be deleted, or `null` when it can: it has a chat room
 * (it was published at some point, which created the room) or any media row
 * (deleting would orphan the bucket objects).
 *
 * @param db - The deleting transaction.
 * @param cuencadaId - Edition.
 */
export async function draftDeleteBlocker(db: DbOrTx, cuencadaId: string): Promise<string | null> {
  const [row] = await db.execute<{ has_room: boolean; has_media: boolean }>(sql`
    select
      exists (select 1 from ${chatRooms} where ${chatRooms.cuencadaId} = ${cuencadaId}) as has_room,
      exists (select 1 from ${mediaItems} where ${mediaItems.cuencadaId} = ${cuencadaId}) as has_media
  `);
  if (row?.has_room === true) return "Esta Cuencada ya se publicó alguna vez; despublícala en lugar de eliminarla.";
  if (row?.has_media === true) return "Esta Cuencada tiene fotos o videos; no se puede eliminar.";
  return null;
}

/**
 * Next `sort_order` (max + 1) for an edition's itinerary or locations.
 *
 * @param db - Transaction.
 * @param table - `cuencada_itinerary_items` or `cuencada_locations`.
 * @param cuencadaId - Edition.
 */
export async function nextSortOrder(
  db: DbOrTx,
  table: typeof cuencadaItineraryItems | typeof cuencadaLocations,
  cuencadaId: string
): Promise<number> {
  const rows = await db.execute<{ next: number }>(
    sql`select (coalesce(max(sort_order), -1) + 1)::int as next from ${table} where cuencada_id = ${cuencadaId}`
  );
  return rows[0]?.next ?? 0;
}

/**
 * Rewrite `sort_order` of every item of one edition in a single statement.
 * `ids` must list each of the edition's items exactly once (locked first so
 * a concurrent insert cannot slip in between the check and the write).
 *
 * @param db - Transaction.
 * @param table - `cuencada_itinerary_items` or `cuencada_locations`.
 * @param cuencadaId - Edition.
 * @param ids - New order.
 * @param now - `updated_at` value (`app.clock.now()`).
 * @throws AppError `VALIDATION` when `ids` is not exactly the edition's set.
 */
export async function rewriteSortOrder(
  db: DbOrTx,
  table: typeof cuencadaItineraryItems | typeof cuencadaLocations,
  cuencadaId: string,
  ids: readonly string[],
  now: Date
): Promise<void> {
  const existing = await db.execute<{ id: string }>(
    sql`select id from ${table} where cuencada_id = ${cuencadaId} for update`
  );
  const existingIds = new Set(existing.map((row) => row.id));
  const sameSet = existingIds.size === ids.length && ids.every((id) => existingIds.has(id));
  if (!sameSet) {
    throw new AppError("VALIDATION", "El nuevo orden debe incluir cada elemento de esta Cuencada exactamente una vez.", {
      details: [{ path: "ids", message: "La lista no coincide con los elementos de esta Cuencada." }]
    });
  }
  const idArray = sql`array[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `
  )}]::uuid[]`;
  await db.execute(sql`
    update ${table} as t
    set sort_order = (v.ord - 1)::int, updated_at = ${now.toISOString()}::timestamptz
    from unnest(${idArray}) with ordinality as v(id, ord)
    where t.id = v.id and t.cuencada_id = ${cuencadaId}
  `);
}

/**
 * Portal-wide live announcements for the given visibilities.
 *
 * @param db - Client.
 * @param visibilities - Allowed visibilities.
 * @param now - Current instant.
 */
export function listPortalAnnouncements(
  db: DbOrTx,
  visibilities: readonly Visibility[],
  now: Date
): Promise<AnnouncementRow[]> {
  return listLiveAnnouncements(db, { portalWide: true, visibilities, now });
}
