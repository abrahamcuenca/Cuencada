/**
 * Memory Box reads (WP-6.3, ADR 0001 §8) [SEC]. Members only ever reach
 * `published` boxes ({@link boxVisibleSql}); admins reach every box. Counts
 * and cover thumbnails are computed per box in the same statement (no N+1)
 * and only from media the caller could see:
 * - `mediaCount`: members, the gallery's member visibility
 *   (`memberVisibleSql`: ready + approved, plus their own uploads); admins,
 *   every live confirmed item (what blocks a delete).
 * - cover: the chosen cover while it is a live, ready, approved photo of the
 *   box, else the newest such photo, else none.
 */
import type { MemoryAlbumStatus } from "@cuencada/types";
import { and, asc, desc, eq, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { mediaItems, memoryAlbums, users } from "../../db/schema/index.js";
import type { DbOrTx } from "../../lib/audit.js";
import { isAdmin, memberVisibleSql, type Viewer } from "../media/service.js";

/** A `memory_albums` row. */
export type MemoryAlbumRow = typeof memoryAlbums.$inferSelect;

/** A box plus the per-caller aggregates its responses need. */
export interface MemoryAlbumRecord {
  row: MemoryAlbumRow;
  mediaCount: number;
  /** Object key of the cover thumbnail (see module doc), or `null`. */
  coverThumbKey: string | null;
  createdByName: string | null;
}

const cover = alias(mediaItems, "cover_item");
const newest = alias(mediaItems, "newest_item");

/** SQL: a media row (aliased) everyone may see as a cover: a live, ready, approved photo with a thumbnail. */
function coverCandidateSql(item: typeof cover | typeof newest): SQL {
  return sql`(${item.deletedAt} is null and ${item.uploadStatus} = 'ready' and ${item.moderationStatus} = 'approved'
    and ${item.kind} = 'image' and ${item.thumbKey} is not null and ${item.memoryAlbumId} = ${memoryAlbums.id})`;
}

const coverThumbKeySql = sql<string | null>`coalesce(
  (select ${cover.thumbKey} from ${mediaItems} cover_item where ${cover.id} = ${memoryAlbums.coverMediaId} and ${coverCandidateSql(cover)}),
  (select ${newest.thumbKey} from ${mediaItems} newest_item where ${coverCandidateSql(newest)}
    order by ${newest.createdAt} desc, ${newest.id} desc limit 1)
)`;

/** SQL [SEC]: the viewer may see the box (members: `published` only; admins: every box). */
export function boxVisibleSql(viewer: Viewer): SQL | undefined {
  return isAdmin(viewer) ? undefined : eq(memoryAlbums.status, "published");
}

function mediaCountSql(viewer: Viewer): SQL<number> {
  const visible = isAdmin(viewer)
    ? sql`(${mediaItems.deletedAt} is null and ${mediaItems.uploadStatus} <> 'pending_upload')`
    : memberVisibleSql(viewer.id);
  return sql<number>`(select count(*)::int from ${mediaItems} where ${mediaItems.memoryAlbumId} = ${memoryAlbums.id} and ${visible})`.mapWith(
    Number
  );
}

function selectRecords(db: DbOrTx, viewer: Viewer) {
  return db
    .select({
      row: memoryAlbums,
      mediaCount: mediaCountSql(viewer),
      coverThumbKey: coverThumbKeySql,
      createdByName: users.displayName
    })
    .from(memoryAlbums)
    .leftJoin(users, eq(users.id, memoryAlbums.createdByUserId));
}

/** Box order everywhere: `sort_order`, then newest. */
const boxOrder = [asc(memoryAlbums.sortOrder), desc(memoryAlbums.createdAt), desc(memoryAlbums.id)];

/**
 * Boxes in order. `published`: the member list (published boxes only, for
 * everyone, admins included); `all`: the admin panel (every box the viewer
 * may see, i.e. every box for admins).
 *
 * @param limit - At most this many (`MEMORY_ALBUMS_MAX`).
 */
export async function listMemoryAlbums(
  db: DbOrTx,
  viewer: Viewer,
  which: "published" | "all",
  limit: number
): Promise<MemoryAlbumRecord[]> {
  return selectRecords(db, viewer)
    .where(which === "published" ? eq(memoryAlbums.status, "published") : boxVisibleSql(viewer))
    .orderBy(...boxOrder)
    .limit(limit);
}

/**
 * One box the viewer may see.
 *
 * @returns The record, or `null` (missing **or** invisible: callers answer the same 404).
 */
export async function findMemoryAlbum(db: DbOrTx, id: string, viewer: Viewer): Promise<MemoryAlbumRecord | null> {
  const [record] = await selectRecords(db, viewer)
    .where(and(eq(memoryAlbums.id, id), boxVisibleSql(viewer)))
    .limit(1);
  return record ?? null;
}

/**
 * Lock one box row (`for share`: uploads; `for update`: admin writes) and
 * return its status, or `null` when it does not exist.
 */
export async function lockMemoryAlbum(
  tx: DbOrTx,
  id: string,
  strength: "share" | "update"
): Promise<{ id: string; status: MemoryAlbumStatus } | null> {
  const [row] = await tx
    .select({ id: memoryAlbums.id, status: memoryAlbums.status })
    .from(memoryAlbums)
    .where(eq(memoryAlbums.id, id))
    .for(strength);
  return row ?? null;
}
