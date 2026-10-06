/**
 * Member media routes (T4): upload intent, confirm, gallery list, read,
 * caption edit, delete and report. Mounted under `/api`.
 *
 * IDOR rule: an item the caller may not see — or may not act on, for
 * owner-only actions — answers 404, never 403, so ids reveal nothing.
 */
import { randomUUID } from "node:crypto";
import {
  AuditAction,
  confirmUploadInputSchema,
  createUploadInputSchema,
  createUploadResponseSchema,
  idParamSchema,
  type MediaItem,
  mediaItemSchema,
  mediaKindOfMime,
  mediaListQuerySchema,
  pageSchema,
  reportMediaInputSchema,
  updateMediaInputSchema,
  yearParamSchema
} from "@cuencada/types";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { cuencadas, mediaItems, mediaReports } from "../../db/schema/index.js";
import { recordAudit } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { authUser } from "../../plugins/auth.js";
import {
  CONFIRM_RATE_LIMIT,
  DAILY_UPLOAD_BYTES,
  DAILY_UPLOAD_WINDOW_MS,
  MAX_PENDING_UPLOADS_PER_USER,
  REPORT_RATE_LIMIT,
  SNIFF_BYTES,
  UPLOAD_INTENT_RATE_LIMIT,
  UPLOAD_URL_SECONDS
} from "./constants.js";
import { mediaKeys, normalizeContentType, sanitizeFileName, signatureMatches } from "./files.js";
import { enqueueMediaProcessing } from "./jobs/mediaProcess.js";
import {
  allObjectKeys,
  findLiveRecord,
  findViewableRecord,
  isAdmin,
  listGallery,
  type MediaRecord,
  toMediaItem,
  type Viewer
} from "./service.js";
import { deleteObjectsQuietly, jobDeps, mediaErrorResponses, noContentSchema, rateLimitByUser, viewerOf } from "./shared.js";

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

/** Headers a browser may set itself; the signature also covers Content-Length, which the browser derives from the File. */
function browserUploadHeaders(required: Record<string, string>, mimeType: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": mimeType };
  for (const [name, value] of Object.entries(required)) {
    if (name.toLowerCase().startsWith("x-amz-")) headers[name] = value;
  }
  return headers;
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
   * presigned PUT bound to the declared type and size (5 min).
   */
  app.post(
    "/cuencadas/:year/media/uploads",
    {
      config: { auth: "user", rateLimit: rateLimitByUser("media-upload", UPLOAD_INTENT_RATE_LIMIT) },
      schema: {
        params: yearParamSchema,
        body: createUploadInputSchema,
        response: { 201: createUploadResponseSchema, ...mediaErrorResponses }
      }
    },
    async (request, reply) => {
      const user = authUser(request);
      const body = request.body;
      const cuencada = await findPublishedCuencada(app, request.params.year);

      const mediaId = randomUUID();
      const keys = mediaKeys(cuencada.year, mediaId, body.mimeType);
      const now = app.clock.now();
      const needsReview = app.config.MEDIA_REQUIRE_APPROVAL && user.role !== "admin";

      const presigned = await app.db.transaction(async (tx) => {
        // Serialize this user's intents so the caps below are exact under concurrency.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`media-intent:${user.id}`}))`);
        const since = new Date(now.getTime() - DAILY_UPLOAD_WINDOW_MS).toISOString();
        const [usage] = await tx
          .select({
            open: sql<number>`(count(*) filter (where ${mediaItems.uploadStatus} = 'pending_upload' and ${mediaItems.deletedAt} is null))::int`,
            recentBytes: sql<string>`coalesce(sum(${mediaItems.byteSize}) filter (where ${mediaItems.uploadStatus} <> 'failed' and ${mediaItems.createdAt} > ${since}::timestamptz), 0)::text`
          })
          .from(mediaItems)
          .where(eq(mediaItems.uploadedByUserId, user.id));
        if ((usage?.open ?? 0) >= MAX_PENDING_UPLOADS_PER_USER) {
          throw new AppError("RATE_LIMITED", "Tienes demasiadas subidas pendientes. Espera a que terminen.");
        }
        // Admins are exempt (they load historical albums); members get the rolling budget.
        if (user.role !== "admin" && Number(usage?.recentBytes ?? "0") + body.byteSize > DAILY_UPLOAD_BYTES) {
          throw new AppError("RATE_LIMITED", "Llegaste al límite de subidas de hoy. Intenta de nuevo mañana.");
        }

        await tx.insert(mediaItems).values({
          id: mediaId,
          cuencadaId: cuencada.id,
          uploadedByUserId: user.id,
          kind: mediaKindOfMime(body.mimeType),
          objectKey: keys.original,
          bucket: app.config.S3_BUCKET,
          fileName: sanitizeFileName(body.fileName),
          mimeType: body.mimeType,
          byteSize: body.byteSize,
          caption: body.caption,
          uploadStatus: "pending_upload",
          uploadExpiresAt: new Date(now.getTime() + UPLOAD_URL_SECONDS * 1000),
          moderationStatus: needsReview ? "pending_review" : "approved"
        });
        // Presign inside the transaction: if storage is unavailable, no orphan row is left.
        return app.storage.presignPut({
          key: keys.original,
          contentType: body.mimeType,
          contentLength: body.byteSize,
          expiresInSeconds: UPLOAD_URL_SECONDS
        });
      });

      return reply.code(201).send({
        mediaId,
        uploadUrl: presigned.url,
        headers: browserUploadHeaders(presigned.requiredHeaders, body.mimeType),
        expiresAt: presigned.expiresAt.toISOString()
      });
    }
  );

  /**
   * POST /api/media/:id/confirm — uploader only. HEAD (size + type) and a
   * magic-byte check, then `processing` + the sharp job. Idempotent once
   * accepted.
   */
  app.post(
    "/media/:id/confirm",
    {
      config: { auth: "user", rateLimit: rateLimitByUser("media-confirm", CONFIRM_RATE_LIMIT) },
      schema: {
        params: idParamSchema,
        body: confirmUploadInputSchema,
        response: { 200: mediaItemSchema, ...mediaErrorResponses }
      }
    },
    async (request): Promise<MediaItem> => {
      const user = authUser(request);
      const viewer = viewerOf(user);
      const record = await findLiveRecord(app.db, request.params.id);
      if (record === null || !isOwner(record, viewer)) throw new AppError("NOT_FOUND", NOT_FOUND_MESSAGE);
      const { item } = record;

      if (item.uploadStatus === "processing" || item.uploadStatus === "ready") {
        return toMediaItem(app.storage, record, viewer);
      }
      if (item.uploadStatus === "failed") throw uploadInvalid(UploadInvalidReason.Rejected, UPLOAD_MISMATCH_MESSAGE);

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
          metadata: { kind: row.kind, mimeType: row.mimeType, byteSize: row.byteSize },
          ip: request.ip
        });
        return row;
      });

      if (confirmed === null) {
        // A concurrent confirm won (or the item was deleted/cleaned up meanwhile).
        const current = await findLiveRecord(app.db, item.id);
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
      config: { auth: "user" },
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

  /** GET /api/media/:id — one item the caller may see. */
  app.get(
    "/media/:id",
    {
      config: { auth: "user" },
      schema: { params: idParamSchema, response: { 200: mediaItemSchema, ...mediaErrorResponses } }
    },
    async (request): Promise<MediaItem> => {
      const viewer = viewerOf(authUser(request));
      const record = await findViewableRecord(app.db, request.params.id, viewer);
      if (record === null) throw new AppError("NOT_FOUND", NOT_FOUND_MESSAGE);
      return toMediaItem(app.storage, record, viewer);
    }
  );

  /** PATCH /api/media/:id — edit the caption (uploader or admin). */
  app.patch(
    "/media/:id",
    {
      config: { auth: "user" },
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
   * `pending_upload`) or admin. Soft-deletes the row and removes the objects.
   * Repeating it answers 204 again and retries the object deletes.
   */
  app.delete(
    "/media/:id",
    {
      config: { auth: "user" },
      schema: { params: idParamSchema, response: { 204: noContentSchema, ...mediaErrorResponses } }
    },
    async (request, reply) => {
      const user = authUser(request);
      const viewer = viewerOf(user);
      const [found] = await app.db
        .select({ item: mediaItems, year: cuencadas.year })
        .from(mediaItems)
        .innerJoin(cuencadas, eq(cuencadas.id, mediaItems.cuencadaId))
        .where(eq(mediaItems.id, request.params.id))
        .limit(1);
      if (found === undefined) throw new AppError("NOT_FOUND", NOT_FOUND_MESSAGE);
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

  /** POST /api/media/:id/report — any member, once per item (409 on repeat). Reasons/details are never logged. */
  app.post(
    "/media/:id/report",
    {
      config: { auth: "user", rateLimit: rateLimitByUser("media-report", REPORT_RATE_LIMIT) },
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
