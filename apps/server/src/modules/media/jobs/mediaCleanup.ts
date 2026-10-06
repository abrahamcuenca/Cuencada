/**
 * Abandoned-upload cleanup. Deletes `pending_upload` rows whose upload URL
 * expired more than {@link UPLOAD_CLEANUP_GRACE_MS} ago, then their objects.
 *
 * - Rows with a NULL `upload_expires_at` are never stale (WP-0.3: legacy rows
 *   may point at real objects).
 * - The row is claimed (deleted with the status re-checked) before its object
 *   is removed, so a concurrent confirm that already moved the row to
 *   `processing` can never lose its file.
 * - Idempotent: a second run finds nothing; deleting a missing object is a no-op.
 */
import { and, eq, inArray, isNotNull, lt } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { mediaItems } from "../../../db/schema/index.js";
import { CLEANUP_BATCH_SIZE, CLEANUP_MAX_BATCHES, UPLOAD_CLEANUP_GRACE_MS } from "../constants.js";
import type { MediaJobDeps } from "./mediaProcess.js";

/** What a cleanup pass needs: DB, storage, clock and a logger (info/warn only). */
export type CleanupDeps = Pick<MediaJobDeps, "db" | "storage" | "clock"> & {
  log: Pick<FastifyBaseLogger, "info" | "warn">;
};

/** Result of one cleanup run. */
export interface CleanupResult {
  rowsDeleted: number;
  objectDeleteFailures: number;
}

/**
 * Run one cleanup pass.
 *
 * @param deps - DB, storage, clock (the cutoff uses `clock.now()`) and logger.
 */
export async function cleanupAbandonedUploads(deps: CleanupDeps): Promise<CleanupResult> {
  const cutoff = new Date(deps.clock.now().getTime() - UPLOAD_CLEANUP_GRACE_MS);
  const stale = and(
    eq(mediaItems.uploadStatus, "pending_upload"),
    isNotNull(mediaItems.uploadExpiresAt),
    lt(mediaItems.uploadExpiresAt, cutoff)
  );
  const result: CleanupResult = { rowsDeleted: 0, objectDeleteFailures: 0 };

  for (let batch = 0; batch < CLEANUP_MAX_BATCHES; batch += 1) {
    const candidates = deps.db.select({ id: mediaItems.id }).from(mediaItems).where(stale).limit(CLEANUP_BATCH_SIZE);
    const claimed = await deps.db
      .delete(mediaItems)
      .where(and(inArray(mediaItems.id, candidates), stale))
      .returning({ id: mediaItems.id, objectKey: mediaItems.objectKey });
    for (const row of claimed) {
      try {
        await deps.storage.delete(row.objectKey);
      } catch (error) {
        result.objectDeleteFailures += 1;
        deps.log.warn(
          { mediaId: row.id, errorName: error instanceof Error ? error.name : "unknown" },
          "abandoned upload object delete failed"
        );
      }
    }
    result.rowsDeleted += claimed.length;
    if (claimed.length < CLEANUP_BATCH_SIZE) break;
  }

  if (result.rowsDeleted > 0) deps.log.info({ ...result }, "abandoned uploads cleaned up");
  return result;
}
