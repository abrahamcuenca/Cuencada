/**
 * Tree-photo routes (WP-4.3) [SEC] under `/api/family/people/:id/photo`:
 * upload intent, confirm (verify + optional crop + process) and removal.
 * Verified members only; who may change a photo is `canEditPersonPhoto`
 * (admins, the linked person, close relatives of a person without account).
 *
 * Same pipeline as avatars (`profile/uploadPipeline.ts`, `processSquareImage`):
 * an exact-origin presigned PUT bound to the declared type and length, HEAD
 * and magic-byte checks, a 24 MP decode cap, `.rotate()` before the clamped
 * crop, WebP at 512/256/64 px without metadata, `private, max-age=3600`,
 * server-generated keys and the shared decode semaphore. Replaced and
 * original objects are deleted after the commit; abandoned intents are
 * reclaimed by the profile module's cleanup job.
 *
 * Every change writes a `person.photo` revision (`{ type: "photo", personId,
 * hasPhoto, photoUpdatedAt }`, never a key) and an audit row in the same
 * transaction. Responses are `PersonDetails` (no keys, no bucket names).
 */
import { randomUUID } from "node:crypto";
import {
  AuditAction,
  AuditEntityType,
  idParamSchema,
  type PersonDetails,
  PersonRevisionAction,
  type PersonRevisionPhotoSnapshot,
  personDetailsSchema,
  personPhotoConfirmBodySchema,
  personPhotoUploadInputSchema,
  personPhotoUploadParamsSchema,
  personPhotoUploadResponseSchema
} from "@cuencada/types";
import { and, count, eq, gt, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { people, personPhotoUploads, personRevisions } from "../../db/schema/index.js";
import { recordAudit, type Transaction } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { authUser } from "../../plugins/auth.js";
import { processSquareImage } from "../profile/avatar.js";
import {
  AVATAR_CONFIRM_GRACE_MS,
  AVATAR_CONFIRM_RATE_LIMIT,
  AVATAR_DELETE_RATE_LIMIT,
  AVATAR_INTENT_RATE_LIMIT,
  AVATAR_MAX_OPEN_INTENTS,
  AVATAR_UPLOAD_URL_TTL_SECONDS
} from "../profile/constants.js";
import { rateLimitByUser, t5ErrorResponses } from "../profile/shared.js";
import { browserUploadHeaders, putWebpDerivatives, readVerifiedUpload } from "../profile/uploadPipeline.js";
import { buildPersonDetails } from "./personDetails.js";
import {
  deletePersonPhotoObjects,
  PERSON_PHOTO_SIZES,
  personPhotoDerivativeKeys,
  personPhotoKeys
} from "./personPhoto.js";
import { photoEditDenial } from "./photoAccess.js";
import { findPerson, type PersonViewRow, type Viewer } from "./repository.js";

const PERSON_NOT_FOUND = "No encontramos a esa persona.";
const NOT_ALLOWED = "No puedes cambiar la foto de esta persona.";
const UPLOAD_NOT_FOUND = "No encontramos esa subida.";
const UPLOAD_MISMATCH = "El archivo no coincide con el tipo o el tamaño declarados.";
const UPLOAD_NOT_RECEIVED = "Aún no recibimos la foto. Intenta de nuevo en unos segundos.";
const UPLOAD_EXPIRED = "La subida venció. Vuelve a elegir la foto.";
const UPLOAD_UNREADABLE = "No pudimos procesar la imagen. Prueba con otra foto.";
const TOO_MANY_OPEN = "Tienes demasiadas subidas pendientes. Espera unos minutos.";

type PhotoUploadRow = typeof personPhotoUploads.$inferSelect;

/** Rejection reasons recorded in the audit log (codes only). */
type RejectReason =
  | "expired"
  | "size_mismatch"
  | "content_type_mismatch"
  | "signature_mismatch"
  | "pixel_limit_exceeded"
  | "format_mismatch"
  | "decode_failed";

const photoErrorResponses = t5ErrorResponses;

/** The person, or 404. */
async function requirePerson(app: FastifyInstance, id: string): Promise<PersonViewRow> {
  const row = await findPerson(app.db, id);
  if (row === undefined) throw new AppError("NOT_FOUND", PERSON_NOT_FOUND);
  return row;
}

/**
 * 403 unless `viewer` may change `person`'s photo. The detail code
 * (`photoEditDenial`) never tells a non-relative that a person is linked.
 */
async function requirePhotoEditor(app: FastifyInstance, viewer: Viewer, person: PersonViewRow): Promise<void> {
  const code = await photoEditDenial(app.db, viewer, person);
  if (code === null) return;
  throw new AppError("FORBIDDEN", NOT_ALLOWED, { details: [{ path: "id", message: NOT_ALLOWED, code }] });
}

/** Photo snapshot for `person_revisions` (no object keys). */
function photoSnapshot(personId: string, photoUpdatedAt: Date | null): PersonRevisionPhotoSnapshot {
  return {
    type: "photo",
    personId,
    id: personId,
    hasPhoto: photoUpdatedAt !== null,
    photoUpdatedAt: photoUpdatedAt?.toISOString() ?? null
  };
}

/** The person row locked for the photo change (or 404 when it was deleted meanwhile). */
async function lockPersonPhoto(tx: Transaction, personId: string): Promise<{ photoKey: string | null; photoUpdatedAt: Date | null }> {
  const [row] = await tx
    .select({ photoKey: people.photoKey, photoUpdatedAt: people.photoUpdatedAt })
    .from(people)
    .where(eq(people.id, personId))
    .for("update");
  if (row === undefined) throw new AppError("NOT_FOUND", PERSON_NOT_FOUND);
  return row;
}

/** Re-read and build the response after a change. */
async function detailsFor(app: FastifyInstance, personId: string, viewer: Viewer): Promise<PersonDetails> {
  return buildPersonDetails(app, await requirePerson(app, personId), viewer);
}

/**
 * Drop a rejected, unconfirmed upload (row, then object), audit the reason
 * and answer 400 `UPLOAD_INVALID`.
 */
async function rejectUpload(
  app: FastifyInstance,
  upload: PhotoUploadRow,
  actorUserId: string,
  reason: RejectReason,
  ip: string,
  message: string
): Promise<never> {
  const deleted = await app.db.transaction(async (tx) => {
    const rows = await tx
      .delete(personPhotoUploads)
      .where(and(eq(personPhotoUploads.id, upload.id), isNull(personPhotoUploads.confirmedAt)))
      .returning({ id: personPhotoUploads.id });
    if (rows.length > 0) {
      await recordAudit(tx, {
        actorUserId,
        action: AuditAction.PersonPhotoRejected,
        entityType: AuditEntityType.Person,
        entityId: upload.personId,
        metadata: { uploadId: upload.id, reason },
        ip
      });
    }
    return rows.length > 0;
  });
  if (deleted) await deletePersonPhotoObjects(app, [upload.objectKey]);
  app.log.info({ uploadId: upload.id, reason }, "person photo upload rejected");
  throw new AppError("UPLOAD_INVALID", message);
}

/** Tree-photo routes (mounted under `/api`). */
const personPhotoRoutes: FastifyPluginAsyncZod = async (app) => {
  const memberConfig = { auth: "user", requireVerifiedEmail: true } as const;

  /**
   * `POST /api/family/people/:id/photo/uploads`: upload intent. Checks
   * `canEditPersonPhoto`, then presigns a PUT (5 min) for
   * `people/{personId}/{uploadId}.{ext}`, bound to the declared type and size.
   * 10/hour per user and at most 5 open intents (shared with nothing else).
   */
  app.post(
    "/family/people/:id/photo/uploads",
    {
      config: { ...memberConfig, rateLimit: rateLimitByUser("person-photo-intent", AVATAR_INTENT_RATE_LIMIT) },
      schema: {
        params: idParamSchema,
        body: personPhotoUploadInputSchema,
        response: { 201: personPhotoUploadResponseSchema, ...photoErrorResponses }
      }
    },
    async (request, reply) => {
      const viewer = authUser(request);
      const person = await requirePerson(app, request.params.id);
      await requirePhotoEditor(app, viewer, person);
      const { mimeType, byteSize } = request.body;
      const now = app.clock.now();

      const [open] = await app.db
        .select({ value: count() })
        .from(personPhotoUploads)
        .where(
          and(
            eq(personPhotoUploads.uploadedByUserId, viewer.id),
            isNull(personPhotoUploads.confirmedAt),
            gt(personPhotoUploads.expiresAt, now)
          )
        );
      if ((open?.value ?? 0) >= AVATAR_MAX_OPEN_INTENTS) throw new AppError("RATE_LIMITED", TOO_MANY_OPEN);

      const uploadId = randomUUID();
      const keys = personPhotoKeys(person.id, uploadId, mimeType);
      const expiresAt = new Date(now.getTime() + AVATAR_UPLOAD_URL_TTL_SECONDS * 1000);

      // Presign inside the transaction: a storage outage (503) leaves no orphan row.
      const presigned = await app.db.transaction(async (tx) => {
        await tx.insert(personPhotoUploads).values({
          id: uploadId,
          personId: person.id,
          uploadedByUserId: viewer.id,
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

      reply.code(201);
      return {
        uploadId,
        uploadUrl: presigned.url,
        headers: browserUploadHeaders(presigned.requiredHeaders, mimeType),
        expiresAt: expiresAt.toISOString()
      };
    }
  );

  /**
   * `POST /api/family/people/:id/photo/uploads/:uploadId/confirm`. **Uploader
   * only**: an upload of another user or another person is 404 (IDOR). The
   * permission is re-checked (it may have changed since the intent). Then the
   * same checks as avatars, the optional `crop` clamped with `clampCropRect`
   * after auto-orient, and the 512/256/64 WebPs. A repeat confirm returns the
   * current details.
   */
  app.post(
    "/family/people/:id/photo/uploads/:uploadId/confirm",
    {
      config: { ...memberConfig, rateLimit: rateLimitByUser("person-photo-confirm", AVATAR_CONFIRM_RATE_LIMIT) },
      schema: {
        params: personPhotoUploadParamsSchema,
        body: personPhotoConfirmBodySchema,
        response: { 200: personDetailsSchema, ...photoErrorResponses }
      }
    },
    async (request) => {
      const viewer = authUser(request);
      const { id: personId, uploadId } = request.params;
      const [upload] = await app.db
        .select()
        .from(personPhotoUploads)
        .where(
          and(
            eq(personPhotoUploads.id, uploadId),
            eq(personPhotoUploads.personId, personId),
            eq(personPhotoUploads.uploadedByUserId, viewer.id)
          )
        )
        .limit(1);
      if (upload === undefined) throw new AppError("NOT_FOUND", UPLOAD_NOT_FOUND);
      const person = await requirePerson(app, personId);
      if (upload.confirmedAt !== null) return buildPersonDetails(app, person, viewer);
      await requirePhotoEditor(app, viewer, person);

      const now = app.clock.now();
      if (now.getTime() > upload.expiresAt.getTime() + AVATAR_CONFIRM_GRACE_MS) {
        return rejectUpload(app, upload, viewer.id, "expired", request.ip, UPLOAD_EXPIRED);
      }
      const checked = await readVerifiedUpload(app, upload);
      if (!checked.ok) {
        if (checked.notReceived) throw new AppError("UPLOAD_INVALID", UPLOAD_NOT_RECEIVED);
        return rejectUpload(app, upload, viewer.id, checked.failure, request.ip, UPLOAD_MISMATCH);
      }
      const processed = await processSquareImage(checked.input, upload.mimeType, {
        sizes: PERSON_PHOTO_SIZES,
        ...(request.body.crop === undefined ? {} : { crop: request.body.crop })
      });
      if (!processed.ok) return rejectUpload(app, upload, viewer.id, processed.failure, request.ip, UPLOAD_UNREADABLE);
      const [display, large, small] = processed.images;
      if (display === undefined || large === undefined || small === undefined) {
        return rejectUpload(app, upload, viewer.id, "decode_failed", request.ip, UPLOAD_UNREADABLE);
      }

      const keys = personPhotoKeys(personId, upload.id, upload.mimeType);
      await putWebpDerivatives(app, [
        { key: keys.display, body: display },
        { key: keys.large, body: large },
        { key: keys.small, body: small }
      ]);

      const outcome = await app.db.transaction(async (tx) => {
        const claimed = await tx
          .update(personPhotoUploads)
          .set({ confirmedAt: app.clock.now() })
          .where(and(eq(personPhotoUploads.id, upload.id), isNull(personPhotoUploads.confirmedAt)))
          .returning({ id: personPhotoUploads.id });
        if (claimed.length === 0) return { kind: "lost" as const };
        const current = await lockPersonPhoto(tx, personId);
        const changedAt = app.clock.now();
        await tx
          .update(people)
          .set({ photoKey: keys.large, photoUpdatedAt: changedAt, updatedByUserId: viewer.id, updatedAt: changedAt })
          .where(eq(people.id, personId));
        await tx.insert(personRevisions).values({
          personId,
          actorUserId: viewer.id,
          action: PersonRevisionAction.PersonPhoto,
          before: photoSnapshot(personId, current.photoKey === null ? null : current.photoUpdatedAt),
          after: photoSnapshot(personId, changedAt)
        });
        await recordAudit(tx, {
          actorUserId: viewer.id,
          action: AuditAction.PersonPhotoUpdated,
          entityType: AuditEntityType.Person,
          entityId: personId,
          metadata: { fields: ["photo"], uploadId: upload.id, replaced: current.photoKey !== null },
          ip: request.ip
        });
        return { kind: "claimed" as const, previousKey: current.photoKey };
      });

      if (outcome.kind === "lost") {
        // A concurrent confirm of the same upload won (same keys, already live),
        // or cleanup removed the row: re-read to tell them apart.
        const [still] = await app.db
          .select({ id: personPhotoUploads.id })
          .from(personPhotoUploads)
          .where(eq(personPhotoUploads.id, upload.id))
          .limit(1);
        if (still === undefined) {
          await deletePersonPhotoObjects(app, [keys.display, keys.large, keys.small]);
          throw new AppError("UPLOAD_INVALID", UPLOAD_EXPIRED);
        }
        return detailsFor(app, personId, viewer);
      }

      const previous = personPhotoDerivativeKeys(outcome.previousKey);
      const stale = [upload.objectKey];
      if (previous !== null && previous.large !== keys.large) stale.push(previous.display, previous.large, previous.small);
      await deletePersonPhotoObjects(app, stale);
      return detailsFor(app, personId, viewer);
    }
  );

  /** `DELETE /api/family/people/:id/photo`: remove the tree photo (row first, then its objects). */
  app.delete(
    "/family/people/:id/photo",
    {
      config: { ...memberConfig, rateLimit: rateLimitByUser("person-photo-delete", AVATAR_DELETE_RATE_LIMIT) },
      schema: { params: idParamSchema, response: { 200: personDetailsSchema, ...photoErrorResponses } }
    },
    async (request) => {
      const viewer = authUser(request);
      const personId = request.params.id;
      const person = await requirePerson(app, personId);
      await requirePhotoEditor(app, viewer, person);
      const previousKey = await app.db.transaction(async (tx) => {
        const current = await lockPersonPhoto(tx, personId);
        if (current.photoKey === null) return null;
        const changedAt = app.clock.now();
        await tx
          .update(people)
          .set({ photoKey: null, photoUpdatedAt: null, updatedByUserId: viewer.id, updatedAt: changedAt })
          .where(eq(people.id, personId));
        await tx.insert(personRevisions).values({
          personId,
          actorUserId: viewer.id,
          action: PersonRevisionAction.PersonPhoto,
          before: photoSnapshot(personId, current.photoUpdatedAt),
          after: photoSnapshot(personId, null)
        });
        await recordAudit(tx, {
          actorUserId: viewer.id,
          action: AuditAction.PersonPhotoRemoved,
          entityType: AuditEntityType.Person,
          entityId: personId,
          metadata: { fields: ["photo"] },
          ip: request.ip
        });
        return current.photoKey;
      });
      const previous = personPhotoDerivativeKeys(previousKey);
      if (previous !== null) await deletePersonPhotoObjects(app, [previous.display, previous.large, previous.small]);
      return detailsFor(app, personId, viewer);
    }
  );
};

export default personPhotoRoutes;
