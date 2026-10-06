/**
 * Best-effort object deletion shared by routes and jobs. Failures are logged
 * with the media id and error name only (never the key) and retried by the
 * leftover-object sweep in the cleanup pass.
 */
import type { FastifyBaseLogger } from "fastify";
import type { StorageService } from "../../lib/storage/types.js";

/** What {@link deleteObjectsQuietly} needs. */
export interface ObjectDeleteDeps {
  storage: Pick<StorageService, "delete">;
  log: Pick<FastifyBaseLogger, "warn">;
}

/**
 * Delete objects, logging and continuing on failure.
 *
 * @param deps - Storage and logger.
 * @param mediaId - For the log line.
 * @param keys - Object keys to remove (deleting a missing key is a no-op).
 * @returns How many deletes failed.
 */
export async function deleteObjectsQuietly(deps: ObjectDeleteDeps, mediaId: string, keys: string[]): Promise<number> {
  let failures = 0;
  for (const key of keys) {
    try {
      await deps.storage.delete(key);
    } catch (error) {
      failures += 1;
      deps.log.warn({ mediaId, errorName: error instanceof Error ? error.name : "unknown" }, "media object delete failed");
    }
  }
  return failures;
}
