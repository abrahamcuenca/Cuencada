import { env } from "../../../shared/lib/env";

/** Shown instead of the upload button when this build has no bucket origin. */
export const UPLOADS_UNAVAILABLE_MESSAGE = "Por ahora no se pueden subir fotos ni videos. Avísale a un administrador.";
/** Extra line for developers (dev builds only). */
export const UPLOAD_ORIGIN_DEV_HINT =
  "Desarrollo: falta VITE_MEDIA_UPLOAD_ORIGIN (el origen del bucket, p. ej. https://<bucket>.<región>.linodeobjects.com) en apps/web/.env.local.";

/**
 * Whether this build can upload at all. Checked **before** asking the server
 * for an upload intent, so an unconfigured build never leaves an orphan
 * `pending_upload` row behind (the intent would be refused anyway).
 *
 * @param bucketOrigin - `env.mediaUploadOrigin` (read at call time).
 * @returns `true` when a bucket origin is configured.
 */
export function uploadsConfigured(bucketOrigin: string | null = env.mediaUploadOrigin): boolean {
  return bucketOrigin !== null;
}

/** Thrown by the upload pipeline when {@link uploadsConfigured} is false; its message is user-safe Spanish. */
export class UploadsUnavailableError extends Error {
  constructor() {
    super(UPLOADS_UNAVAILABLE_MESSAGE);
    this.name = "UploadsUnavailableError";
  }
}

/**
 * True when a presigned upload URL points at the configured bucket origin [SEC].
 * Malformed URLs, URLs with credentials, any other origin (including the same
 * host over `http:`) and an unconfigured origin (`null`) are all refused, so
 * the file is never PUT anywhere but the bucket.
 *
 * @param raw - `CreateUploadResponse.uploadUrl`.
 * @param bucketOrigin - `env.mediaUploadOrigin`.
 * @returns Whether the browser may PUT the file there.
 */
export function isAllowedUploadUrl(raw: string, bucketOrigin: string | null): boolean {
  if (bucketOrigin === null) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "") return false;
  return url.origin === bucketOrigin;
}
