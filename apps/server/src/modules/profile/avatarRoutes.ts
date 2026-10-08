/**
 * Avatar routes: upload intent, confirm (verify + process) and removal.
 *
 * Flow: the intent row (`avatar_uploads`) and a presigned PUT bound to the
 * declared type and size → the browser PUTs the original → confirm checks
 * HEAD (size, type), magic bytes and decodes with sharp, writes the 256 and
 * 64 px WebP derivatives, points `profiles.avatar_key` at them, then deletes
 * the previous avatar's objects and the original (which may carry EXIF/GPS).
 */
import { randomUUID } from "node:crypto";
import {
  AuditAction,
  avatarConfirmInputSchema,
  avatarUploadInputSchema,
  avatarUploadResponseSchema,
  ownProfileSchema
} from "@cuencada/types";
import { and, count, eq, gt, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { avatarUploads, profiles } from "../../db/schema/index.js";
import { recordAudit } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { authUser } from "../../plugins/auth.js";
import { type AvatarKeys, avatarKeys, derivativeKeysFor, processAvatar } from "./avatar.js";
import {
  AVATAR_CONFIRM_GRACE_MS,
  AVATAR_CONFIRM_RATE_LIMIT,
  AVATAR_DELETE_RATE_LIMIT,
  AVATAR_INTENT_RATE_LIMIT,
  AVATAR_MAX_OPEN_INTENTS,
  AVATAR_UPLOAD_URL_TTL_SECONDS
} from "./constants.js";
import { loadOwnProfile, toOwnProfile } from "./service.js";
import { rateLimitByUser, t5ErrorResponses } from "./shared.js";
import { browserUploadHeaders, deleteObjectsQuietly, putWebpDerivatives, readVerifiedUpload } from "./uploadPipeline.js";

/** Audit actions written by the avatar routes. */
export const AvatarAuditAction = {
  Updated: AuditAction.ProfileAvatarUpdated,
  Removed: AuditAction.ProfileAvatarRemoved,
  Rejected: AuditAction.ProfileAvatarRejected
} as const;

const UPLOAD_NOT_FOUND = "No encontramos esa subida.";
const UPLOAD_MISMATCH = "El archivo no coincide con el tipo o el tamaño declarados.";
const UPLOAD_NOT_RECEIVED = "Aún no recibimos la foto. Intenta de nuevo en unos segundos.";
const UPLOAD_EXPIRED = "La subida venció. Vuelve a elegir la foto.";
const UPLOAD_UNREADABLE = "No pudimos procesar la imagen. Prueba con otra foto.";
const TOO_MANY_OPEN = "Tienes demasiadas subidas pendientes. Espera unos minutos.";

type AvatarUploadRow = typeof avatarUploads.$inferSelect;

/** Rejection reasons recorded in the audit log (codes only). */
type RejectReason =
  | "expired"
  | "size_mismatch"
  | "content_type_mismatch"
  | "signature_mismatch"
  | "pixel_limit_exceeded"
  | "format_mismatch"
  | "decode_failed";

/**
 * Drop a rejected, unconfirmed upload (row, then object), audit the reason
 * and answer 400 `UPLOAD_INVALID`.
 */
async function rejectUpload(
  app: FastifyInstance,
  upload: AvatarUploadRow,
  reason: RejectReason,
  ip: string,
  message: string
): Promise<never> {
  const deleted = await app.db.transaction(async (tx) => {
    const rows = await tx
      .delete(avatarUploads)
      .where(and(eq(avatarUploads.id, upload.id), isNull(avatarUploads.confirmedAt)))
      .returning({ id: avatarUploads.id });
    if (rows.length > 0) {
      await recordAudit(tx, {
        actorUserId: upload.userId,
        action: AvatarAuditAction.Rejected,
        entityType: "profile",
        entityId: null,
        metadata: { uploadId: upload.id, reason },
        ip
      });
    }
    return rows.length > 0;
  });
  if (deleted) await deleteObjectsQuietly(app, [upload.objectKey]);
  app.log.info({ uploadId: upload.id, reason }, "avatar upload rejected");
  throw new AppError("UPLOAD_INVALID", message);
}

/** Avatar routes under `/api`. */
const avatarRoutes: FastifyPluginAsyncZod = async (app) => {
  /**
   * Upload intent. The server picks the key `avatars/{userId}/{uploadId}.{ext}`
   * and presigns a PUT (5 min) bound to the declared type and size.
   * 10/hour per user and at most 5 open intents.
   */
  app.post(
    "/profile/me/avatar/uploads",
    {
      config: {
        auth: "user",
        rateLimit: rateLimitByUser("avatar-intent", AVATAR_INTENT_RATE_LIMIT)
      },
      schema: {
        body: avatarUploadInputSchema,
        response: { 201: avatarUploadResponseSchema, ...t5ErrorResponses }
      }
    },
    async (request, reply) => {
      const user = authUser(request);
      const { mimeType, byteSize } = request.body;
      const now = app.clock.now();

      const [open] = await app.db
        .select({ value: count() })
        .from(avatarUploads)
        .where(
          and(eq(avatarUploads.userId, user.id), isNull(avatarUploads.confirmedAt), gt(avatarUploads.expiresAt, now))
        );
      if ((open?.value ?? 0) >= AVATAR_MAX_OPEN_INTENTS) throw new AppError("RATE_LIMITED", TOO_MANY_OPEN);

      const uploadId = randomUUID();
      const keys = avatarKeys(user.id, uploadId, mimeType);
      const expiresAt = new Date(now.getTime() + AVATAR_UPLOAD_URL_TTL_SECONDS * 1000);

      // Presign inside the transaction: a storage outage (503) leaves no orphan row.
      const presigned = await app.db.transaction(async (tx) => {
        await tx.insert(avatarUploads).values({
          id: uploadId,
          userId: user.id,
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
   * Confirm an upload: owner only (others get 404). HEAD must match the
   * declared size and type, the magic bytes must match, and sharp must
   * decode it. Rejections delete the row and object (400 `UPLOAD_INVALID`);
   * an object that has not arrived yet is a retryable 400. A repeat confirm
   * returns the current profile.
   */
  app.post(
    "/profile/me/avatar/confirm",
    {
      config: {
        auth: "user",
        rateLimit: rateLimitByUser("avatar-confirm", AVATAR_CONFIRM_RATE_LIMIT)
      },
      schema: {
        body: avatarConfirmInputSchema,
        response: { 200: ownProfileSchema, ...t5ErrorResponses }
      }
    },
    async (request) => {
      const user = authUser(request);
      const [upload] = await app.db
        .select()
        .from(avatarUploads)
        .where(and(eq(avatarUploads.id, request.body.uploadId), eq(avatarUploads.userId, user.id)))
        .limit(1);
      if (upload === undefined) throw new AppError("NOT_FOUND", UPLOAD_NOT_FOUND);
      if (upload.confirmedAt !== null) return toOwnProfile(app, await loadOwnProfile(app.db, user.id));

      const now = app.clock.now();
      if (now.getTime() > upload.expiresAt.getTime() + AVATAR_CONFIRM_GRACE_MS) {
        return rejectUpload(app, upload, "expired", request.ip, UPLOAD_EXPIRED);
      }

      const checked = await readVerifiedUpload(app, upload);
      if (!checked.ok) {
        if (checked.notReceived) throw new AppError("UPLOAD_INVALID", UPLOAD_NOT_RECEIVED);
        return rejectUpload(app, upload, checked.failure, request.ip, UPLOAD_MISMATCH);
      }
      const processed = await processAvatar(checked.input, upload.mimeType, request.body.crop);
      if (!processed.ok) return rejectUpload(app, upload, processed.failure, request.ip, UPLOAD_UNREADABLE);

      const keys: AvatarKeys = avatarKeys(user.id, upload.id, upload.mimeType);
      await putWebpDerivatives(app, [
        { key: keys.large, body: processed.avatar.large },
        { key: keys.small, body: processed.avatar.small }
      ]);

      const outcome = await app.db.transaction(async (tx) => {
        const claimed = await tx
          .update(avatarUploads)
          .set({ confirmedAt: app.clock.now() })
          .where(and(eq(avatarUploads.id, upload.id), isNull(avatarUploads.confirmedAt)))
          .returning({ id: avatarUploads.id });
        if (claimed.length === 0) return { kind: "lost" as const };
        const current = await loadOwnProfile(tx, user.id, { forUpdate: true });
        await tx
          .update(profiles)
          .set({ avatarKey: keys.large, updatedAt: app.clock.now() })
          .where(eq(profiles.id, current.profile.id));
        await recordAudit(tx, {
          actorUserId: user.id,
          action: AvatarAuditAction.Updated,
          entityType: "profile",
          entityId: current.profile.id,
          metadata: {
            fields: ["avatar"],
            uploadId: upload.id,
            replaced: current.profile.avatarKey !== null
          },
          ip: request.ip
        });
        return {
          kind: "claimed" as const,
          previousKey: current.profile.avatarKey
        };
      });

      if (outcome.kind === "lost") {
        // A concurrent confirm of the same upload won (same deterministic keys,
        // already live), or cleanup removed the row: re-read to tell them apart.
        const [still] = await app.db
          .select({ id: avatarUploads.id })
          .from(avatarUploads)
          .where(eq(avatarUploads.id, upload.id))
          .limit(1);
        if (still === undefined) {
          await deleteObjectsQuietly(app, [keys.large, keys.small]);
          throw new AppError("UPLOAD_INVALID", UPLOAD_EXPIRED);
        }
        return toOwnProfile(app, await loadOwnProfile(app.db, user.id));
      }

      const previous = derivativeKeysFor(outcome.previousKey);
      const stale = [upload.objectKey];
      if (previous !== null && previous.large !== keys.large) stale.push(previous.large, previous.small);
      await deleteObjectsQuietly(app, stale);
      return toOwnProfile(app, await loadOwnProfile(app.db, user.id));
    }
  );

  /** Remove the caller's avatar (row first, then both derivative objects). */
  app.delete(
    "/profile/me/avatar",
    {
      config: {
        auth: "user",
        rateLimit: rateLimitByUser("avatar-delete", AVATAR_DELETE_RATE_LIMIT)
      },
      schema: { response: { 200: ownProfileSchema, ...t5ErrorResponses } }
    },
    async (request) => {
      const user = authUser(request);
      const previousKey = await app.db.transaction(async (tx) => {
        const current = await loadOwnProfile(tx, user.id, { forUpdate: true });
        if (current.profile.avatarKey === null) return null;
        await tx
          .update(profiles)
          .set({ avatarKey: null, updatedAt: app.clock.now() })
          .where(eq(profiles.id, current.profile.id));
        await recordAudit(tx, {
          actorUserId: user.id,
          action: AvatarAuditAction.Removed,
          entityType: "profile",
          entityId: current.profile.id,
          metadata: { fields: ["avatar"] },
          ip: request.ip
        });
        return current.profile.avatarKey;
      });
      const previous = derivativeKeysFor(previousKey);
      if (previous !== null) await deleteObjectsQuietly(app, [previous.large, previous.small]);
      return toOwnProfile(app, await loadOwnProfile(app.db, user.id));
    }
  );
};

export default avatarRoutes;
