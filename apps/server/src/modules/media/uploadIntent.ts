/**
 * The gallery upload intent, shared by edition media
 * (`POST /api/cuencadas/:year/media/uploads`), event-album media
 * (`POST /api/events/:id/albums/:albumId/uploads`, WP-5.3) and Memory Box
 * media (`POST /api/memories/:id/uploads`, WP-6.3).
 *
 * [SEC] One locked daily-budget step for both scopes (Security requirement
 * 12): the per-user advisory lock serializes a user's intents, so the open
 * intent cap and the rolling byte budget are exact under concurrency and
 * shared by edition, album and Memory Box uploads. Keys are server-generated from the
 * scope's stored prefix (never from input).
 */
import { randomUUID } from "node:crypto";
import { type CreateUploadInput, type CreateUploadResponse, mediaKindOfMime } from "@cuencada/types";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { mediaItems } from "../../db/schema/index.js";
import type { Transaction } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import type { AuthUser } from "../../plugins/auth.js";
import { DAILY_UPLOAD_BYTES, DAILY_UPLOAD_WINDOW_MS, MAX_PENDING_UPLOADS_PER_USER, UPLOAD_URL_SECONDS } from "./constants.js";
import { mediaKeys, sanitizeFileName } from "./files.js";

/** Where the item goes: exactly one scope, plus its server-derived key prefix. */
export type UploadScope =
  | { cuencadaId: string; albumId?: never; memoryAlbumId?: never; storagePrefix: string }
  | { albumId: string; cuencadaId?: never; memoryAlbumId?: never; storagePrefix: string }
  | { memoryAlbumId: string; cuencadaId?: never; albumId?: never; storagePrefix: string };

/** Headers a browser may set itself; the signature also covers Content-Length, which the browser derives from the File. */
function browserUploadHeaders(required: Record<string, string>, mimeType: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": mimeType };
  for (const [name, value] of Object.entries(required)) {
    if (name.toLowerCase().startsWith("x-amz-")) headers[name] = value;
  }
  return headers;
}

/**
 * Create a `pending_upload` row and a presigned PUT bound to the declared
 * type and size (5 min), after the locked caps.
 *
 * @param app - Fastify instance (`db`, `storage`, `config`, `clock`).
 * @param user - The uploader.
 * @param scope - The edition or album, with its prefix.
 * @param body - The validated intent.
 * @param recheck - Optional authorization re-check run inside the locked
 *   transaction (e.g. the uploader still takes part in the event).
 * @throws AppError `RATE_LIMITED` over the open-intent cap or the daily budget.
 */
export async function createPendingUpload(
  app: FastifyInstance,
  user: AuthUser,
  scope: UploadScope,
  body: CreateUploadInput,
  recheck?: (tx: Transaction) => Promise<void>
): Promise<CreateUploadResponse> {
  const mediaId = randomUUID();
  const keys = mediaKeys(scope.storagePrefix, mediaId, body.mimeType);
  const now = app.clock.now();
  const needsReview = app.config.MEDIA_REQUIRE_APPROVAL && user.role !== "admin";

  const presigned = await app.db.transaction(async (tx) => {
    // Serialize this user's intents so the caps below are exact under concurrency.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`media-intent:${user.id}`}))`);
    if (recheck !== undefined) await recheck(tx);
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
      cuencadaId: scope.cuencadaId ?? null,
      albumId: scope.albumId ?? null,
      memoryAlbumId: scope.memoryAlbumId ?? null,
      storagePrefix: scope.storagePrefix,
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

  return {
    mediaId,
    uploadUrl: presigned.url,
    headers: browserUploadHeaders(presigned.requiredHeaders, body.mimeType),
    expiresAt: presigned.expiresAt.toISOString()
  };
}
