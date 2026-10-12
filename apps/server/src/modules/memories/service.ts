/**
 * Memory Box writes and response mapping (WP-6.3, ADR 0001 §8) [SEC].
 *
 * - Admin writes lock the box row `for update`; member uploads lock it
 *   `for share` (intent and confirm), so hiding a box serializes with every
 *   upload into it.
 * - Every box write is audited with ids, enums, field names and counts only
 *   (never titles or descriptions; requirement 10).
 * - Deleting a box purges its soft-deleted media rows (`memory_album_id` is
 *   ON DELETE RESTRICT) and deletes their objects after the commit; live
 *   media answer 409 `MEMORY_ALBUM_NOT_EMPTY`.
 */
import {
  type AdminMemoryAlbum,
  AuditAction,
  AuditEntityType,
  type CreateMemoryAlbumInput,
  MEMORY_ALBUMS_MAX,
  type MemoryAlbumDetail,
  type MemoryAlbumSummary,
  type UpdateMemoryAlbumInput
} from "@cuencada/types";
import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { mediaItems, memoryAlbums } from "../../db/schema/index.js";
import { recordAudit, type Transaction } from "../../lib/audit.js";
import type { StorageService } from "../../lib/storage/types.js";
import type { AuthUser } from "../../plugins/auth.js";
import { VIEW_URL_SECONDS } from "../media/constants.js";
import { allObjectKeys, isAdmin, type Viewer } from "../media/service.js";
import { deleteObjectsQuietly } from "../media/shared.js";
import { memoryAlbumLimit, memoryAlbumNotEmpty, memoryAlbumNotFound, memoryCoverInvalid, memoryOrderStale } from "./errors.js";
import { lockMemoryAlbum, type MemoryAlbumRecord } from "./repository.js";

/* -------------------------------------------------------------------------- */
/* Mapping                                                                     */
/* -------------------------------------------------------------------------- */

async function coverUrl(storage: StorageService, key: string | null): Promise<string | null> {
  if (key === null) return null;
  return (await storage.presignGet({ key, expiresInSeconds: VIEW_URL_SECONDS })).url;
}

/** A box card (member list). */
export async function toMemoryAlbumSummary(storage: StorageService, record: MemoryAlbumRecord): Promise<MemoryAlbumSummary> {
  const { row } = record;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    coverUrl: await coverUrl(storage, record.coverThumbKey),
    mediaCount: record.mediaCount,
    updatedAt: row.updatedAt.toISOString()
  };
}

/** `GET /api/memories/:id`: the card plus `canUpload` (published boxes for members; admins always). */
export async function toMemoryAlbumDetail(
  storage: StorageService,
  record: MemoryAlbumRecord,
  viewer: Viewer
): Promise<MemoryAlbumDetail> {
  return {
    ...(await toMemoryAlbumSummary(storage, record)),
    canUpload: isAdmin(viewer) || record.row.status === "published"
  };
}

/** A box in the admin panel. */
export async function toAdminMemoryAlbum(storage: StorageService, record: MemoryAlbumRecord): Promise<AdminMemoryAlbum> {
  const { row } = record;
  return {
    ...(await toMemoryAlbumSummary(storage, record)),
    status: row.status,
    sortOrder: row.sortOrder,
    coverMediaId: row.coverMediaId,
    createdByName: record.createdByName,
    createdAt: row.createdAt.toISOString()
  };
}

/* -------------------------------------------------------------------------- */
/* Admin writes                                                                */
/* -------------------------------------------------------------------------- */

function boxAudit(tx: Transaction, user: AuthUser, albumId: string, ip: string) {
  return (action: AuditAction, metadata: Record<string, unknown>) =>
    recordAudit(tx, { actorUserId: user.id, action, entityType: AuditEntityType.MemoryAlbum, entityId: albumId, metadata, ip });
}

/**
 * `POST /api/admin/memory-albums`. At most {@link MEMORY_ALBUMS_MAX} boxes
 * (counted under a transaction-scoped advisory lock, so two creates cannot
 * both pass the cap).
 *
 * @returns The new box id.
 */
export async function createMemoryAlbum(app: FastifyInstance, user: AuthUser, input: CreateMemoryAlbumInput, ip: string): Promise<string> {
  return app.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('memory-albums'))`);
    const [existing] = await tx.select({ value: count() }).from(memoryAlbums);
    if ((existing?.value ?? 0) >= MEMORY_ALBUMS_MAX) throw memoryAlbumLimit(MEMORY_ALBUMS_MAX);
    const [row] = await tx
      .insert(memoryAlbums)
      .values({ ...input, createdByUserId: user.id })
      .returning({ id: memoryAlbums.id });
    if (row === undefined) throw new Error("memory album insert returned no row");
    const audit = boxAudit(tx, user, row.id, ip);
    await audit(AuditAction.MemoryAlbumCreated, { status: input.status, sortOrder: input.sortOrder });
    if (input.status === "published") await audit(AuditAction.MemoryAlbumPublished, { previousStatus: null });
    if (input.status === "hidden") await audit(AuditAction.MemoryAlbumHidden, { previousStatus: null });
    return row.id;
  });
}

/** [SEC] The cover must be a live, ready, approved photo **of this box** (else 400). */
async function requireCoverOfBox(tx: Transaction, albumId: string, mediaId: string): Promise<void> {
  const [item] = await tx
    .select({ id: mediaItems.id })
    .from(mediaItems)
    .where(
      and(
        eq(mediaItems.id, mediaId),
        eq(mediaItems.memoryAlbumId, albumId),
        isNull(mediaItems.deletedAt),
        eq(mediaItems.uploadStatus, "ready"),
        eq(mediaItems.moderationStatus, "approved"),
        eq(mediaItems.kind, "image")
      )
    )
    .limit(1);
  if (item === undefined) throw memoryCoverInvalid();
}

/**
 * `PATCH /api/admin/memory-albums/:id`: edit, set the cover, publish, hide
 * or move back to draft. Audits `memory_album.updated` (field names) plus
 * `published` / `hidden` when the status becomes one of them.
 */
export async function updateMemoryAlbum(
  app: FastifyInstance,
  user: AuthUser,
  albumId: string,
  input: UpdateMemoryAlbumInput,
  ip: string
): Promise<void> {
  await app.db.transaction(async (tx) => {
    const box = await lockMemoryAlbum(tx, albumId, "update");
    if (box === null) throw memoryAlbumNotFound();
    if (input.coverMediaId !== undefined && input.coverMediaId !== null) await requireCoverOfBox(tx, albumId, input.coverMediaId);
    await tx
      .update(memoryAlbums)
      .set({ ...input, updatedAt: app.clock.now() })
      .where(eq(memoryAlbums.id, albumId));
    const audit = boxAudit(tx, user, albumId, ip);
    await audit(AuditAction.MemoryAlbumUpdated, { fields: Object.keys(input).sort() });
    if (input.status !== undefined && input.status !== box.status) {
      if (input.status === "published") await audit(AuditAction.MemoryAlbumPublished, { previousStatus: box.status });
      if (input.status === "hidden") await audit(AuditAction.MemoryAlbumHidden, { previousStatus: box.status });
    }
  });
}

/**
 * `DELETE /api/admin/memory-albums/:id`: 409 `MEMORY_ALBUM_NOT_EMPTY` while
 * live media remain (any row not soft-deleted, a pending upload included);
 * soft-deleted rows are hard-deleted in the transaction (their tags, likes,
 * comments and notifications cascade) and their objects removed after it.
 */
export async function deleteMemoryAlbum(app: FastifyInstance, user: AuthUser, albumId: string, ip: string): Promise<void> {
  const keys = await app.db.transaction(async (tx) => {
    const box = await lockMemoryAlbum(tx, albumId, "update");
    if (box === null) throw memoryAlbumNotFound();
    const rows = await tx.select().from(mediaItems).where(eq(mediaItems.memoryAlbumId, albumId)).for("update");
    if (rows.some((row) => row.deletedAt === null)) throw memoryAlbumNotEmpty();
    // The cover FK is SET NULL, but clear it first so the purge never trips on it.
    await tx.update(memoryAlbums).set({ coverMediaId: null }).where(eq(memoryAlbums.id, albumId));
    if (rows.length > 0) {
      await tx.delete(mediaItems).where(
        inArray(
          mediaItems.id,
          rows.map((row) => row.id)
        )
      );
    }
    await tx.delete(memoryAlbums).where(eq(memoryAlbums.id, albumId));
    await boxAudit(tx, user, albumId, ip)(AuditAction.MemoryAlbumDeleted, { mediaDeleted: rows.length, previousStatus: box.status });
    return rows.map((row) => ({ id: row.id, keys: allObjectKeys(row, null) }));
  });
  for (const purged of keys) await deleteObjectsQuietly(app, purged.id, purged.keys);
}

/**
 * `PUT /api/admin/memory-albums/order`: `ids` must be exactly the current
 * set of boxes (409 when it changed meanwhile); `sort_order` = index.
 */
export async function reorderMemoryAlbums(app: FastifyInstance, user: AuthUser, ids: readonly string[], ip: string): Promise<void> {
  await app.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('memory-albums'))`);
    const current = await tx.select({ id: memoryAlbums.id }).from(memoryAlbums).for("update");
    const known = new Set(current.map((row) => row.id));
    if (current.length !== ids.length || !ids.every((id) => known.has(id))) throw memoryOrderStale();
    const now = app.clock.now();
    for (const [index, id] of ids.entries()) {
      await tx.update(memoryAlbums).set({ sortOrder: index, updatedAt: now }).where(eq(memoryAlbums.id, id));
    }
    await recordAudit(tx, {
      actorUserId: user.id,
      action: AuditAction.MemoryAlbumsReordered,
      entityType: AuditEntityType.MemoryAlbum,
      entityId: null,
      metadata: { count: ids.length },
      ip
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Uploads                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * [SEC] Re-checked inside the upload intent's locked transaction (ADR 0001
 * §8 requirement 5): the box still exists and, for members, is still
 * `published`; the box row is held `for share` until the intent commits.
 *
 * @throws AppError 404 `MEMORY_ALBUM_NOT_FOUND` otherwise.
 */
export async function recheckMemoryUpload(tx: Transaction, viewer: Viewer, albumId: string): Promise<void> {
  const box = await lockMemoryAlbum(tx, albumId, "share");
  if (box === null || (!isAdmin(viewer) && box.status !== "published")) throw memoryAlbumNotFound();
}
