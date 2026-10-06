/**
 * Announcement reads shared by the announcements and cuencadas modules: the
 * row → contract mapper, the "currently shown" filter and batched loaders.
 */
import type { Announcement, Visibility } from "@cuencada/types";
import { and, asc, desc, eq, gt, inArray, isNull, lte, or, type SQL } from "drizzle-orm";
import type { DbOrTx } from "../../lib/audit.js";
import { announcements, users } from "../../db/schema/index.js";

/** Columns selected for every announcement read (author name via a left join). */
export const announcementColumns = {
  id: announcements.id,
  cuencadaId: announcements.cuencadaId,
  title: announcements.title,
  body: announcements.body,
  visibility: announcements.visibility,
  pinned: announcements.pinned,
  publishAt: announcements.publishAt,
  expiresAt: announcements.expiresAt,
  updatedAt: announcements.updatedAt,
  authorName: users.displayName
};

/** Row shape produced by {@link announcementColumns}. */
export interface AnnouncementRow {
  id: string;
  cuencadaId: string | null;
  title: string;
  body: string;
  visibility: Visibility;
  pinned: boolean;
  publishAt: Date;
  expiresAt: Date | null;
  updatedAt: Date;
  authorName: string | null;
}

/**
 * Map a DB row to the `Announcement` contract.
 *
 * @param row - Row selected with {@link announcementColumns}.
 */
export function toAnnouncement(row: AnnouncementRow): Announcement {
  return {
    id: row.id,
    cuencadaId: row.cuencadaId,
    title: row.title,
    body: row.body,
    visibility: row.visibility,
    pinned: row.pinned,
    authorName: row.authorName,
    publishedAt: row.publishAt.toISOString(),
    expiresAt: row.expiresAt === null ? null : row.expiresAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

/**
 * `publish_at <= now and (expires_at is null or expires_at > now)`: the
 * announcement is currently shown.
 *
 * @param now - Current instant (`app.clock.now()`).
 */
export function isLive(now: Date): SQL {
  const live = and(lte(announcements.publishAt, now), or(isNull(announcements.expiresAt), gt(announcements.expiresAt, now)));
  if (live === undefined) throw new Error("isLive: empty condition");
  return live;
}

/** Display order: pinned first, then newest. */
export const announcementOrder = [desc(announcements.pinned), desc(announcements.publishAt), desc(announcements.id)];

/** Options for {@link listLiveAnnouncements}. */
export interface LiveAnnouncementQuery {
  /** Cuencadas to load; ignored when `portalWide` is set. */
  cuencadaIds?: readonly string[];
  /** Load portal-wide (`cuencada_id is null`) announcements instead. */
  portalWide?: boolean;
  /** Restrict to these visibilities (e.g. only `public` for anonymous reads). */
  visibilities: readonly Visibility[];
  now: Date;
}

/**
 * Currently shown announcements for several Cuencadas (or portal-wide ones)
 * in one query, pinned first.
 *
 * @param db - Client or transaction.
 * @param query - Scope, visibility filter and now.
 */
export async function listLiveAnnouncements(db: DbOrTx, query: LiveAnnouncementQuery): Promise<AnnouncementRow[]> {
  let scope: SQL;
  if (query.portalWide === true) {
    scope = isNull(announcements.cuencadaId);
  } else {
    const ids = query.cuencadaIds ?? [];
    if (ids.length === 0) return [];
    scope = inArray(announcements.cuencadaId, [...ids]);
  }
  return db
    .select(announcementColumns)
    .from(announcements)
    .leftJoin(users, eq(users.id, announcements.createdByUserId))
    .where(and(scope, inArray(announcements.visibility, [...query.visibilities]), isLive(query.now)))
    .orderBy(...announcementOrder);
}

/**
 * Every announcement of the given Cuencadas, including scheduled and expired
 * ones (admin views), pinned first.
 *
 * @param db - Client or transaction.
 * @param cuencadaIds - Cuencadas to load.
 */
export async function listAllAnnouncementsFor(db: DbOrTx, cuencadaIds: readonly string[]): Promise<AnnouncementRow[]> {
  if (cuencadaIds.length === 0) return [];
  return db
    .select(announcementColumns)
    .from(announcements)
    .leftJoin(users, eq(users.id, announcements.createdByUserId))
    .where(inArray(announcements.cuencadaId, [...cuencadaIds]))
    .orderBy(...announcementOrder, asc(announcements.createdAt));
}

/**
 * One announcement with its author name, or `undefined`.
 *
 * @param db - Client or transaction.
 * @param id - Announcement id.
 */
export async function findAnnouncement(db: DbOrTx, id: string): Promise<AnnouncementRow | undefined> {
  const [row] = await db
    .select(announcementColumns)
    .from(announcements)
    .leftJoin(users, eq(users.id, announcements.createdByUserId))
    .where(eq(announcements.id, id))
    .limit(1);
  return row;
}
