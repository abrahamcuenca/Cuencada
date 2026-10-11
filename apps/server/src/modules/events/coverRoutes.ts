/**
 * Event cover routes (WP-5.3) [SEC] under `/api/events/:id/cover`, copying
 * WP-4.3's tree-photo routes: upload intent, confirm (verify + optional 16:9
 * crop + process) and removal. Organizers and admins only, re-checked at
 * confirm under the event lock; the confirm is uploader-only (404
 * otherwise). An invisible event is 404 `EVENT_NOT_FOUND` first.
 *
 * Pipeline (Security requirement 8): an exact presigned PUT bound to the
 * declared type and length (JPEG/PNG/WebP ≤ 10 MB), HEAD and magic-byte
 * checks (`readVerifiedUpload`), the 24 MP decode cap, `.rotate()` before
 * the clamped crop (`clampAspectCropRect`), WebP at 1280 and 640 px without
 * metadata (EXIF/GPS stripped) under the shared decode semaphore. The
 * original and replaced or removed covers' objects are deleted after the
 * commit; abandoned intents are reclaimed by the profile cleanup job.
 */
import { randomUUID } from "node:crypto";
import {
  AuditAction,
  AuditEntityType,
  EVENT_COVER_ASPECT,
  EVENT_COVER_WIDTHS,
  eventCoverConfirmBodySchema,
  eventCoverUploadInputSchema,
  eventCoverUploadParamsSchema,
  eventCoverUploadResponseSchema,
  eventDetailSchema,
  eventIdParamsSchema
} from "@cuencada/types";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { eventCoverUploads, events } from "../../db/schema/index.js";
import { recordAudit } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { authUser } from "../../plugins/auth.js";
import { rateLimitByUser } from "../media/shared.js";
import { processImage } from "../profile/avatar.js";
import {
  AVATAR_CONFIRM_GRACE_MS,
  AVATAR_CONFIRM_RATE_LIMIT,
  AVATAR_DELETE_RATE_LIMIT,
  AVATAR_INTENT_RATE_LIMIT,
  AVATAR_MAX_OPEN_INTENTS,
  AVATAR_UPLOAD_URL_TTL_SECONDS
} from "../profile/constants.js";
import {
  browserUploadHeaders,
  deleteObjectsQuietly,
  putWebpDerivatives,
  readVerifiedUpload
} from "../profile/uploadPipeline.js";
import type { EventViewer } from "./access.js";
import { coverDerivativeKeys, coverKeys } from "./cover.js";
import { loadVisibleEvent, lockVisibleEvent } from "./repository.js";
import { eventErrorResponses } from "./routes.js";
import { eventDetailById, eventViewerOf, openCoverIntents, requireManager } from "./service.js";

const UPLOAD_NOT_FOUND = "No encontramos esa subida.";
const UPLOAD_MISMATCH = "El archivo no coincide con el tipo o el tamaño declarados.";
const UPLOAD_NOT_RECEIVED = "Aún no recibimos la foto. Intenta de nuevo en unos segundos.";
const UPLOAD_EXPIRED = "La subida venció. Vuelve a elegir la foto.";
const UPLOAD_UNREADABLE = "No pudimos procesar la imagen. Prueba con otra foto.";
const TOO_MANY_OPEN = "Tienes demasiadas subidas pendientes. Espera unos minutos.";

type CoverUploadRow = typeof eventCoverUploads.$inferSelect;

/** The visible event, 403 unless the caller manages it. */
async function requireCoverEditor(app: FastifyInstance, viewer: EventViewer, eventId: string): Promise<void> {
  const event = await loadVisibleEvent(app.db, viewer, eq(events.id, eventId));
  requireManager(event, viewer);
}

/** Drop a rejected, unconfirmed upload (row, then object), audit the code and answer 400 `UPLOAD_INVALID`. */
async function rejectCover(
  app: FastifyInstance,
  upload: CoverUploadRow,
  actorUserId: string,
  reason: string,
  ip: string,
  message: string
): Promise<never> {
  const deleted = await app.db.transaction(async (tx) => {
    const rows = await tx
      .delete(eventCoverUploads)
      .where(and(eq(eventCoverUploads.id, upload.id), isNull(eventCoverUploads.confirmedAt)))
      .returning({ id: eventCoverUploads.id });
    if (rows.length > 0) {
      await recordAudit(tx, {
        actorUserId,
        action: AuditAction.EventCoverRejected,
        entityType: AuditEntityType.Event,
        entityId: upload.eventId,
        metadata: { uploadId: upload.id, reason },
        ip
      });
    }
    return rows.length > 0;
  });
  if (deleted) await deleteObjectsQuietly(app, [upload.objectKey], "event cover");
  app.log.info({ uploadId: upload.id, reason }, "event cover upload rejected");
  throw new AppError("UPLOAD_INVALID", message);
}

/** Cover routes (mounted under `/api`). */
const eventCoverRoutes: FastifyPluginAsyncZod = async (app) => {
  const member = { auth: "user", requireVerifiedEmail: true } as const;

  /**
   * `POST /api/events/:id/cover/uploads`: intent for
   * `events/{eventId}/cover/{uploadId}.{ext}`. At most 5 open intents.
   */
  app.post(
    "/events/:id/cover/uploads",
    {
      config: { ...member, rateLimit: rateLimitByUser("event-cover-intent", AVATAR_INTENT_RATE_LIMIT) },
      schema: {
        params: eventIdParamsSchema,
        body: eventCoverUploadInputSchema,
        response: { 201: eventCoverUploadResponseSchema, ...eventErrorResponses }
      }
    },
    async (request, reply) => {
      const user = authUser(request);
      const eventId = request.params.id;
      await requireCoverEditor(app, eventViewerOf(user), eventId);
      if ((await openCoverIntents(app, user.id)) >= AVATAR_MAX_OPEN_INTENTS) throw new AppError("RATE_LIMITED", TOO_MANY_OPEN);
      const { mimeType, byteSize } = request.body;
      const uploadId = randomUUID();
      const keys = coverKeys(eventId, uploadId, mimeType);
      const expiresAt = new Date(app.clock.now().getTime() + AVATAR_UPLOAD_URL_TTL_SECONDS * 1000);
      // Presign inside the transaction: a storage outage (503) leaves no orphan row.
      const presigned = await app.db.transaction(async (tx) => {
        await tx.insert(eventCoverUploads).values({
          id: uploadId,
          eventId,
          uploadedByUserId: user.id,
          objectKey: keys.original,
          mimeType,
          byteSize,
          expiresAt
        });
        return app.storage.presignPut({
          key: keys.original,
          contentType: mimeType,
          contentLength: byteSize,
          expiresInSeconds: AVATAR_UPLOAD_URL_TTL_SECONDS
        });
      });
      return reply.code(201).send({
        uploadId,
        uploadUrl: presigned.url,
        headers: browserUploadHeaders(presigned.requiredHeaders, mimeType),
        expiresAt: expiresAt.toISOString()
      });
    }
  );

  /**
   * `POST /api/events/:id/cover/uploads/:uploadId/confirm`: uploader only;
   * the organizer/admin rule is re-checked before the decode and again under
   * the event lock. A repeat confirm returns the current detail.
   */
  app.post(
    "/events/:id/cover/uploads/:uploadId/confirm",
    {
      config: { ...member, rateLimit: rateLimitByUser("event-cover-confirm", AVATAR_CONFIRM_RATE_LIMIT) },
      schema: {
        params: eventCoverUploadParamsSchema,
        body: eventCoverConfirmBodySchema,
        response: { 200: eventDetailSchema, ...eventErrorResponses }
      }
    },
    async (request) => {
      const user = authUser(request);
      const viewer = eventViewerOf(user);
      const { id: eventId, uploadId } = request.params;
      await requireCoverEditor(app, viewer, eventId);
      const [upload] = await app.db
        .select()
        .from(eventCoverUploads)
        .where(
          and(
            eq(eventCoverUploads.id, uploadId),
            eq(eventCoverUploads.eventId, eventId),
            eq(eventCoverUploads.uploadedByUserId, user.id)
          )
        )
        .limit(1);
      if (upload === undefined) throw new AppError("NOT_FOUND", UPLOAD_NOT_FOUND);
      if (upload.confirmedAt !== null) return eventDetailById(app, viewer, eventId);

      if (app.clock.now().getTime() > upload.expiresAt.getTime() + AVATAR_CONFIRM_GRACE_MS) {
        return rejectCover(app, upload, user.id, "expired", request.ip, UPLOAD_EXPIRED);
      }
      const checked = await readVerifiedUpload(app, upload);
      if (!checked.ok) {
        if (checked.notReceived) throw new AppError("UPLOAD_INVALID", UPLOAD_NOT_RECEIVED);
        return rejectCover(app, upload, user.id, checked.failure, request.ip, UPLOAD_MISMATCH);
      }
      const processed = await processImage(checked.input, upload.mimeType, {
        widths: EVENT_COVER_WIDTHS,
        aspect: EVENT_COVER_ASPECT,
        ...(request.body.crop === undefined ? {} : { crop: request.body.crop })
      });
      if (!processed.ok) return rejectCover(app, upload, user.id, processed.failure, request.ip, UPLOAD_UNREADABLE);
      const [large, small] = processed.images;
      if (large === undefined || small === undefined) {
        return rejectCover(app, upload, user.id, "decode_failed", request.ip, UPLOAD_UNREADABLE);
      }
      const keys = coverKeys(eventId, upload.id, upload.mimeType);
      await putWebpDerivatives(app, [
        { key: keys.w1280, body: large },
        { key: keys.w640, body: small }
      ]);

      const outcome = await app.db.transaction(async (tx) => {
        const event = await lockVisibleEvent(tx, viewer, eventId);
        requireManager(event, viewer);
        const claimed = await tx
          .update(eventCoverUploads)
          .set({ confirmedAt: app.clock.now() })
          .where(and(eq(eventCoverUploads.id, upload.id), isNull(eventCoverUploads.confirmedAt)))
          .returning({ id: eventCoverUploads.id });
        if (claimed.length === 0) return { kind: "lost" as const };
        const changedAt = app.clock.now();
        await tx
          .update(events)
          .set({ coverKey: keys.w1280, coverUpdatedAt: changedAt, updatedAt: changedAt })
          .where(eq(events.id, eventId));
        await recordAudit(tx, {
          actorUserId: user.id,
          action: AuditAction.EventCoverUpdated,
          entityType: AuditEntityType.Event,
          entityId: eventId,
          metadata: { uploadId: upload.id, replaced: event.row.coverKey !== null },
          ip: request.ip
        });
        return { kind: "claimed" as const, previousKey: event.row.coverKey };
      });

      if (outcome.kind === "lost") {
        const [still] = await app.db
          .select({ id: eventCoverUploads.id })
          .from(eventCoverUploads)
          .where(eq(eventCoverUploads.id, upload.id))
          .limit(1);
        if (still === undefined) {
          await deleteObjectsQuietly(app, [keys.w1280, keys.w640], "event cover");
          throw new AppError("UPLOAD_INVALID", UPLOAD_EXPIRED);
        }
        return eventDetailById(app, viewer, eventId);
      }
      const stale = [upload.objectKey, ...coverDerivativeKeys(outcome.previousKey).filter((key) => key !== keys.w1280 && key !== keys.w640)];
      await deleteObjectsQuietly(app, stale, "event cover");
      return eventDetailById(app, viewer, eventId);
    }
  );

  /** `DELETE /api/events/:id/cover`: remove the cover (row first, then its objects). */
  app.delete(
    "/events/:id/cover",
    {
      config: { ...member, rateLimit: rateLimitByUser("event-cover-delete", AVATAR_DELETE_RATE_LIMIT) },
      schema: { params: eventIdParamsSchema, response: { 200: eventDetailSchema, ...eventErrorResponses } }
    },
    async (request) => {
      const user = authUser(request);
      const viewer = eventViewerOf(user);
      const eventId = request.params.id;
      const previousKey = await app.db.transaction(async (tx) => {
        const event = await lockVisibleEvent(tx, viewer, eventId);
        requireManager(event, viewer);
        if (event.row.coverKey === null) return null;
        const changedAt = app.clock.now();
        await tx.update(events).set({ coverKey: null, coverUpdatedAt: null, updatedAt: changedAt }).where(eq(events.id, eventId));
        await recordAudit(tx, {
          actorUserId: user.id,
          action: AuditAction.EventCoverRemoved,
          entityType: AuditEntityType.Event,
          entityId: eventId,
          metadata: {},
          ip: request.ip
        });
        return event.row.coverKey;
      });
      await deleteObjectsQuietly(app, coverDerivativeKeys(previousKey), "event cover");
      return eventDetailById(app, viewer, eventId);
    }
  );
};

export default eventCoverRoutes;
