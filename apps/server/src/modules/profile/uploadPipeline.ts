/**
 * Upload steps shared by avatars (T5) and tree photos (WP-4.3): the headers
 * the browser must send on the presigned PUT, the HEAD + magic-byte checks
 * of an uploaded original, storing derivatives, and best-effort deletes.
 *
 * Nothing here authorizes anything: callers check ownership and permissions
 * first and pass only server-generated keys.
 */
import type { FastifyBaseLogger } from "fastify";
import type { AvatarMimeType } from "../../db/schema/index.js";
import type { StorageService } from "../../lib/storage/types.js";
import { avatarSignatureMatches, normalizeContentType } from "./avatar.js";
import { AVATAR_CACHE_CONTROL, MAGIC_BYTES_LENGTH } from "./constants.js";
import { errorName } from "./shared.js";

/** Storage and logger, as on the Fastify instance. */
export interface UploadPipelineDeps {
  storage: Pick<StorageService, "head" | "getRange" | "put" | "delete">;
  log: Pick<FastifyBaseLogger, "warn">;
}

/** Why an uploaded original was refused before decoding (audited as a code). */
export type UploadCheckFailure = "size_mismatch" | "content_type_mismatch" | "signature_mismatch";

/** Result of {@link readVerifiedUpload}. */
export type UploadCheckResult =
  | { ok: true; input: Uint8Array }
  /** The object has not arrived yet: retryable, nothing is deleted. */
  | { ok: false; notReceived: true }
  | { ok: false; notReceived: false; failure: UploadCheckFailure };

/** The pending upload row fields the checks need. */
export interface PendingUpload {
  objectKey: string;
  mimeType: AvatarMimeType;
  byteSize: number;
}

/**
 * Headers the browser must send on the PUT: the signed Content-Type plus any
 * `x-amz-*` the signer adds.
 *
 * @param required - `requiredHeaders` from the presigner.
 * @param mimeType - The declared type (bound into the signature).
 */
export function browserUploadHeaders(required: Record<string, string>, mimeType: string): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": mimeType };
  for (const [name, value] of Object.entries(required)) {
    if (name.toLowerCase().startsWith("x-amz-")) headers[name] = value;
  }
  return headers;
}

/**
 * HEAD must match the declared size and type, the magic bytes must match the
 * declared type, and the full read must have exactly the declared length.
 * Only then is the file returned for decoding.
 *
 * @param deps - Storage.
 * @param upload - The pending row (server-generated key).
 */
export async function readVerifiedUpload(deps: Pick<UploadPipelineDeps, "storage">, upload: PendingUpload): Promise<UploadCheckResult> {
  const head = await deps.storage.head(upload.objectKey);
  if (head === null) return { ok: false, notReceived: true };
  if (head.contentLength !== upload.byteSize) return { ok: false, notReceived: false, failure: "size_mismatch" };
  if (normalizeContentType(head.contentType) !== upload.mimeType) {
    return { ok: false, notReceived: false, failure: "content_type_mismatch" };
  }
  const leading = await deps.storage.getRange(upload.objectKey, 0, MAGIC_BYTES_LENGTH - 1);
  if (!avatarSignatureMatches(upload.mimeType, leading)) {
    return { ok: false, notReceived: false, failure: "signature_mismatch" };
  }
  const input = await deps.storage.getRange(upload.objectKey, 0, upload.byteSize - 1);
  if (input.byteLength !== upload.byteSize) return { ok: false, notReceived: false, failure: "size_mismatch" };
  return { ok: true, input };
}

/**
 * Store processed WebP derivatives with the private, short cache lifetime
 * (`private, max-age=3600`, no longer than the presigned GET).
 *
 * @param deps - Storage.
 * @param objects - Server-generated keys and their bodies.
 */
export async function putWebpDerivatives(
  deps: Pick<UploadPipelineDeps, "storage">,
  objects: ReadonlyArray<{ key: string; body: Buffer }>
): Promise<void> {
  for (const object of objects) {
    await deps.storage.put({
      key: object.key,
      body: object.body,
      contentType: "image/webp",
      cacheControl: AVATAR_CACHE_CONTROL
    });
  }
}

/**
 * Delete objects, logging (without keys) and continuing on failure; the
 * cleanup jobs retry originals of confirmed rows.
 *
 * @param deps - Storage and logger.
 * @param keys - Server-generated keys.
 * @param label - Short log label (`avatar`, `person photo`).
 */
export async function deleteObjectsQuietly(
  deps: Pick<UploadPipelineDeps, "storage" | "log">,
  keys: readonly string[],
  label = "avatar"
): Promise<void> {
  for (const key of keys) {
    try {
      await deps.storage.delete(key);
    } catch (error) {
      deps.log.warn({ errorName: errorName(error) }, `${label} object delete failed`);
    }
  }
}
