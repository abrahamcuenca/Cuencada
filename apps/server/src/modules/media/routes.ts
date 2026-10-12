/**
 * Member media routes (T4): upload intent, confirm, gallery list, read,
 * caption edit, delete and report. Mounted under `/api`.
 *
 * IDOR rule: an item the caller may not see — or may not act on, for
 * owner-only actions — answers 404, never 403, so ids reveal nothing.
 * Every route requires a verified email (ADR 0001, WP-2.3 L2 owner decision):
 * photos and uploader names reveal who belongs to the family, like attendees.
 *
 * WP-5.3 [SEC]: every by-id route (`GET|PATCH|DELETE /media/:id`, `confirm`,
 * `report`) applies `mediaScopeSql` first, so event-album media answer 404 to
 * anyone outside the event (non-participants, and participants of an event
 * that is no longer visible to them). Album uploads start at
 * `POST /api/events/:id/albums/:albumId/uploads` (events module) and are
 * confirmed here. WP-6.3: so do Memory Box uploads
 * (`POST /api/memories/:id/uploads`); box media of a draft or hidden box
 * answer 404 to members on every route here.
 */
import {
  AuditAction,
  confirmUploadInputSchema,
  createUploadInputSchema,
  createUploadResponseSchema,
  idParamSchema,
  type MediaItem,
  mediaItemSchema,
  mediaListQuerySchema,
  pageSchema,
  reportMediaInputSchema,
  updateMediaInputSchema,
  yearParamSchema
} from "@cuencada/types";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { cuencadas, mediaItems, mediaReports, memoryAlbums } from "../../db/schema/index.js";
import { recordAudit, type Transaction } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { authUser } from "../../plugins/auth.js";
import { AdminViewSurface, auditAdminEventView } from "../events/adminView.js";
import { CONFIRM_RATE_LIMIT, REPORT_RATE_LIMIT, SNIFF_BYTES, UPLOAD_INTENT_RATE_LIMIT } from "./constants.js";
import { albumStoragePrefix, editionStoragePrefix, mediaKeys, memoryStoragePrefix, normalizeContentType, signatureMatches } from "./files.js";
import { enqueueMediaProcessing } from "./jobs/mediaProcess.js";
import {
  allObjectKeys,
  findLiveRecord,
  findScopedRecord,
  findViewableRecord,
  isAdmin,
  listGallery,
  type MediaRecord,
  toMediaItem,
  type Viewer
} from "./service.js";
import { deleteObjectsQuietly, jobDeps, mediaErrorResponses, noContentSchema, rateLimitByUser, viewerOf } from "./shared.js";
import { createPendingUpload } from "./uploadIntent.js";

const NOT_FOUND_MESSAGE = "No encontramos esa foto o video.";
const NO_CUENCADA_MESSAGE = "No encontramos esa Cuencada.";
const UPLOAD_MISMATCH_MESSAGE = "El archivo no coincide con el tipo o el tamaño declarados.";

/**
 * `UPLOAD_INVALID` detail codes (path `upload`) so the web can tell a
 * retryable confirm from a final rejection without a new `ErrorCode`.
 */
export const UploadInvalidReason = {
  /** The object is not in the bucket yet: retry the PUT/confirm. */
  NotReceived: "not_received",
  /** The upload was checked and refused (final; upload again). */
  Rejected: "rejected"
} as const;
export type UploadInvalidReason = (typeof UploadInvalidReason)[keyof typeof UploadInvalidReason];

function uploadInvalid(reason: UploadInvalidReason, message: string): AppError {
  return new AppError("UPLOAD_INVALID", message, { details: [{ path: "upload", message: reason }] });
}

async function findPublishedCuencada(app: FastifyInstance, year: number): Promise<{ id: string; year: number }> {
  const [row] = await app.db
    .select({ id: cuencadas.id, year: cuencadas.year })
    .from(cuencadas)
    .where(and(eq(cuencadas.year, year), eq(cuencadas.isPublished, true)))
    .limit(1);
  if (row === undefined) throw new AppError("NOT_FOUND", NO_CUENCADA_MESSAGE);
  return row;
}

function isOwner(record: MediaRecord, viewer: Viewer): boolean {
  return record.item.uploadedByUserId === viewer.id;
}

/**
 * [SEC] Security requirement 7 (and PR #54 L3): the prefix is re-derived
 * from the scope row itself, the album (`events/{album.eventId}/{album.id}`),
 * the Memory Box (`memories/{box.id}`, WP-6.3, ADR 0001 §8 requirement 5)
 * or the edition (`cuencadas/{year}`), never taken from the stored
 * `storage_prefix`; the stored prefix (when set) and the original key must
 * both match it. A row whose keys sit elsewhere is never confirmed (and so
 * never processed or served).
 */
function keysMatchPrefix(record: MediaRecord): boolean {
  const { item } = record;
  let expectedPrefix: string;
  if (item.albumId !== null) {
    if (record.album === null || record.album.id !== item.albumId) return false;
    expectedPrefix = albumStoragePrefix(record.album);
  } else if (item.memoryAlbumId !== null) {
    if (record.memoryAlbum === null || record.memoryAlbum.id !== item.memoryAlbumId) return false;
    expectedPrefix = memoryStoragePrefix(record.memoryAlbum);
  } else {
    if (record.year === null) return false;
    expectedPrefix = editionStoragePrefix(record.year);
  }
  if (item.storagePrefix !== null && item.storagePrefix !== expectedPrefix) return false;
  return item.objectKey === mediaKeys(expectedPrefix, item.id, item.mimeType).original;
}

/**
 * [SEC] WP-6.3 (ADR 0001 §8 requirement 5): a box upload is re-checked at
 * confirm **under the box row lock** (`for share`; hiding a box takes
 * `for update`), so a confirm racing a hide either commits before the hide
 * or sees the box hidden and answers 404. Members need a `published` box;
 * admins reach every box. Other scopes: nothing to do here (their checks
 * are `mediaScopeSql` in the lookup).
 */
async function recheckMemoryConfirm(tx: Transaction, item: MediaRecord["item"], viewer: Viewer): Promise<void> {
  if (item.memoryAlbumId === null) return;
  const [box] = await tx
    .select({ status: memoryAlbums.status })
    .from(memoryAlbums)
    .where(eq(memoryAlbums.id, item.memoryAlbumId))
    .for("share");
  if (box === undefined || (!isAdmin(viewer) && box.status !== "published")) throw new AppError("NOT_FOUND", NOT_FOUND_MESSAGE);
}

/** Member media routes. */
const mediaRoutes: FastifyPluginAsyncZod = async (app) => {
  const deps = jobDeps(app);

  /** Mark a pending upload as failed, audit, and remove the object. Always throws `UPLOAD_INVALID`. */
  async function rejectUpload(record: MediaRecord, userId: string, ip: string, reason: string): Promise<never> {
    const { item } = record;
    await app.db.transaction(async (tx) => {
      const updated = await tx
        .update(mediaItems)
        .set({ uploadStatus: "failed", processingError: reason })
        .where(and(eq(mediaItems.id, item.id), eq(mediaItems.uploadStatus, "pending_upload")))
        .returning({ id: mediaItems.id });
      if (updated.length === 0) return;
      await recordAudit(tx, {
        actorUserId: userId,
        action: AuditAction.MediaUploadRejected,
        entityType: "media",
        entityId: item.id,
        metadata: { reason, mimeType: item.mimeType },
        ip
      });
    });
    await deleteObjectsQuietly(app, item.id, [item.objectKey]);
    app.log.info({ mediaId: item.id, reason }, "media upload rejected");
    throw uploadInvalid(UploadInvalidReason.Rejected, UPLOAD_MISMATCH_MESSAGE);
  }

  /**
   * POST /api/cuencadas/:year/media/uploads — create a pending item and a
   * presigned PUT bound to the declared type and size (5 min). The locked
   * budget step is shared with event-album uploads (`createPendingUpload`).
   */
  app.post(
    "/cuencadas/:year/media/uploads",
    {
      config: { auth: "user", requireVerifiedEmail: true, rateLimit: rateLimitByUser("media-upload", UPLOAD_INTENT_RATE_LIMIT) },
      schema: {
        params: yearParamSchema,
        body: createUploadInputSchema,
        response: { 201: createUploadResponseSchema, ...mediaErrorResponses }
      }
    },
    async (request, reply) => {
      const user = authUser(request);
      const cuencada = await findPublishedCuencada(app, request.params.year);
      const response = await createPendingUpload(
        app,
        user,
        { cuencadaId: cuencada.id, storagePrefix: editionStoragePrefix(cuencada.year) },
        request.body
      );
      return reply.code(201).send(response);
    }
  );

  /**
   * POST /api/media/:id/confirm — uploader only, within the caller's scope
   * (an album upload is re-checked against the event's participants at this
   * moment). HEAD (size + type) and a magic-byte check, then `processing` +
   * the sharp job. Idempotent once accepted.
   */
  app.post(
    "/media/:id/confirm",
    {
      config: { auth: "user", requireVerifiedEmail: true, rateLimit: rateLimitByUser("media-confirm", CONFIRM_RATE_LIMIT) },
      schema: {
        params: idParamSchema,
        body: confirmUploadInputSchema,
        response: { 200: mediaItemSchema, ...mediaErrorResponses }
      }
    },
    async (request): Promise<MediaItem> => {
      const user = authUser(request);
      const viewer = viewerOf(user);
      const record = await findLiveRecord(app.db, request.params.id, viewer);
      if (record === null || !isOwner(record, viewer)) throw new AppError("NOT_FOUND", NOT_FOUND_MESSAGE);
      const { item } = record;

      if (item.uploadStatus === "processing" || item.uploadStatus === "ready") {
        return toMediaItem(app.storage, record, viewer);
      }
      if (item.uploadStatus === "failed") throw uploadInvalid(UploadInvalidReason.Rejected, UPLOAD_MISMATCH_MESSAGE);
      if (!keysMatchPrefix(record)) return rejectUpload(record, user.id, request.ip, "prefix_mismatch");

      const head = await app.storage.head(item.objectKey);
      if (head === null) {
        throw uploadInvalid(UploadInvalidReason.NotReceived, "Aún no recibimos el archivo. Vuelve a intentarlo.");
      }
      if (head.contentLength !== item.byteSize) return rejectUpload(record, user.id, request.ip, "size_mismatch");
      if (normalizeContentType(head.contentType) !== item.mimeType) {
        return rejectUpload(record, user.id, request.ip, "content_type_mismatch");
      }
      const leading = await app.storage.getRange(item.objectKey, 0, SNIFF_BYTES - 1);
      if (!signatureMatches(item.mimeType, leading)) {
        return rejectUpload(record, user.id, request.ip, "signature_mismatch");
      }

      const confirmed = await app.db.transaction(async (tx) => {
        await recheckMemoryConfirm(tx, item, viewer);
        const [row] = await tx
          .update(mediaItems)
          .set({ uploadStatus: "processing", confirmedAt: app.clock.now() })
          .where(
            and(eq(mediaItems.id, item.id), eq(mediaItems.uploadStatus, "pending_upload"), isNull(mediaItems.deletedAt))
          )
          .returning();
        if (row === undefined) return null;
        await recordAudit(tx, {
          actorUserId: user.id,
          action: AuditAction.MediaUploaded,
          entityType: "media",
          entityId: row.id,
          metadata: {
            kind: row.kind,
            mimeType: row.mimeType,
            byteSize: row.byteSize,
            ...(row.albumId === null ? {} : { albumId: row.albumId }),
            ...(row.memoryAlbumId === null ? {} : { memoryAlbumId: row.memoryAlbumId })
          },
          ip: request.ip
        });
        return row;
      });

      if (confirmed === null) {
        // A concurrent confirm won (or the item was deleted/cleaned up meanwhile).
        const current = await findLiveRecord(app.db, item.id, viewer);
        if (current === null || !isOwner(current, viewer) || current.item.uploadStatus === "pending_upload") {
          throw new AppError("NOT_FOUND", NOT_FOUND_MESSAGE);
        }
        if (current.item.uploadStatus === "failed") {
          throw uploadInvalid(UploadInvalidReason.Rejected, UPLOAD_MISMATCH_MESSAGE);
        }
        return toMediaItem(app.storage, current, viewer);
      }

      enqueueMediaProcessing(deps, confirmed.id);
      return toMediaItem(app.storage, { ...record, item: confirmed }, viewer);
    }
  );

  /** GET /api/cuencadas/:year/media — gallery page, newest first, with presigned URLs (1 h). */
  app.get(
    "/cuencadas/:year/media",
    {
      config: { auth: "user", requireVerifiedEmail: true },
      schema: {
        params: yearParamSchema,
        querystring: mediaListQuerySchema,
        response: { 200: pageSchema(mediaItemSchema), ...mediaErrorResponses }
      }
    },
    async (request) => {
      const viewer = viewerOf(authUser(request));
      const cuencada = await findPublishedCuencada(app, request.params.year);
      const page = await listGallery(app.db, {
        cuencadaId: cuencada.id,
        viewer,
        limit: request.query.limit,
        cursor: request.query.cursor,
        kind: request.query.kind
      });
      const items = await Promise.all(page.records.map((record) => toMediaItem(app.storage, record, viewer)));
      return { items, nextCursor: page.nextCursor };
    }
  );

  /**
   * GET /api/media/:id — one item the caller may see (scope first). An
   * admin outside a `participants` event opening its album media is audited
   * (`event.admin_viewed`, surface `media`) before the item is returned.
   */
  app.get(
    "/media/:id",
    {
      config: { auth: "user", requireVerifiedEmail: true },
      schema: { params: idParamSchema, response: { 200: mediaItemSchema, ...mediaErrorResponses } }
    },
    async (request): Promise<MediaItem> => {
      const viewer = viewerOf(authUser(request));
      const record = await findViewableRecord(app.db, request.params.id, viewer);
      if (record === null) throw new AppError("NOT_FOUND", NOT_FOUND_MESSAGE);
      if (record.album !== null && isAdmin(viewer)) {
        await auditAdminEventView(app.db, {
          viewer,
          eventId: record.album.eventId,
          surface: AdminViewSurface.Media,
          ip: request.ip,
          now: app.clock.now()
        });
      }
      return toMediaItem(app.storage, record, viewer);
    }
  );

  /** PATCH /api/media/:id — edit the caption (uploader or admin, within scope). */
  app.patch(
    "/media/:id",
    {
      config: { auth: "user", requireVerifiedEmail: true },
      schema: {
        params: idParamSchema,
        body: updateMediaInputSchema,
        response: { 200: mediaItemSchema, ...mediaErrorResponses }
      }
    },
    async (request): Promise<MediaItem> => {
      const user = authUser(request);
      const viewer = viewerOf(user);
      const record = await findViewableRecord(app.db, request.params.id, viewer);
      if (record === null || !(isOwner(record, viewer) || isAdmin(viewer))) {
        throw new AppError("NOT_FOUND", NOT_FOUND_MESSAGE);
      }
      const updated = await app.db.transaction(async (tx) => {
        const [row] = await tx
          .update(mediaItems)
          .set({ caption: request.body.caption })
          .where(and(eq(mediaItems.id, record.item.id), isNull(mediaItems.deletedAt)))
          .returning();
        if (row === undefined) throw new AppError("NOT_FOUND", NOT_FOUND_MESSAGE);
        await recordAudit(tx, {
          actorUserId: user.id,
          action: AuditAction.MediaUpdated,
          entityType: "media",
          entityId: row.id,
          metadata: { fields: ["caption"], byAdmin: !isOwner(record, viewer) },
          ip: request.ip
        });
        return row;
      });
      return toMediaItem(app.storage, { ...record, item: updated }, viewer);
    }
  );

  /**
   * DELETE /api/media/:id — uploader (any status, including a cancelled
   * `pending_upload`) or admin, within scope. Soft-deletes the row and
   * removes the objects. Repeating it answers 204 again and retries the
   * object deletes.
   */
  app.delete(
    "/media/:id",
    {
      config: { auth: "user", requireVerifiedEmail: true },
      schema: { params: idParamSchema, response: { 204: noContentSchema, ...mediaErrorResponses } }
    },
    async (request, reply) => {
      const user = authUser(request);
      const viewer = viewerOf(user);
      const found = await findScopedRecord(app.db, request.params.id, viewer);
      if (found === null) throw new AppError("NOT_FOUND", NOT_FOUND_MESSAGE);
      const own = found.item.uploadedByUserId === user.id;
      if (!own && !isAdmin(viewer)) throw new AppError("NOT_FOUND", NOT_FOUND_MESSAGE);
      // Members cannot see a hidden item of someone else, but they may delete their own.

      const current = await app.db.transaction(async (tx) => {
        const [row] = await tx
          .update(mediaItems)
          .set({ deletedAt: app.clock.now(), deletedByUserId: user.id })
          .where(and(eq(mediaItems.id, found.item.id), isNull(mediaItems.deletedAt)))
          .returning();
        if (row === undefined) return found.item; // already deleted: idempotent
        await recordAudit(tx, {
          actorUserId: user.id,
          action: AuditAction.MediaDeleted,
          entityType: "media",
          entityId: row.id,
          metadata: { byAdmin: !own, uploadStatus: row.uploadStatus, kind: row.kind },
          ip: request.ip
        });
        return row;
      });

      await deleteObjectsQuietly(app, current.id, allObjectKeys(current, found.year));
      return reply.code(204).send();
    }
  );

  /** POST /api/media/:id/report — any member within scope, once per item (409 on repeat). Reasons/details are never logged. */
  app.post(
    "/media/:id/report",
    {
      config: { auth: "user", requireVerifiedEmail: true, rateLimit: rateLimitByUser("media-report", REPORT_RATE_LIMIT) },
      schema: { params: idParamSchema, body: reportMediaInputSchema, response: { 204: noContentSchema, ...mediaErrorResponses } }
    },
    async (request, reply) => {
      const user = authUser(request);
      const viewer = viewerOf(user);
      const record = await findViewableRecord(app.db, request.params.id, viewer);
      if (record === null) throw new AppError("NOT_FOUND", NOT_FOUND_MESSAGE);
      if (isOwner(record, viewer)) throw new AppError("FORBIDDEN", "No puedes reportar tu propia publicación.");

      await app.db.transaction(async (tx) => {
        const inserted = await tx
          .insert(mediaReports)
          .values({
            mediaId: record.item.id,
            reporterUserId: user.id,
            reason: request.body.reason,
            details: request.body.details
          })
          .onConflictDoNothing({ target: [mediaReports.mediaId, mediaReports.reporterUserId] })
          .returning({ id: mediaReports.id });
        const report = inserted[0];
        if (report === undefined) throw new AppError("CONFLICT", "Ya habías reportado esta publicación.");
        await recordAudit(tx, {
          actorUserId: user.id,
          action: AuditAction.MediaReported,
          entityType: "media",
          entityId: record.item.id,
          metadata: { reportId: report.id, reason: request.body.reason },
          ip: request.ip
        });
      });
      return reply.code(204).send();
    }
  );
};

export default mediaRoutes;
