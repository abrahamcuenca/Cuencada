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
