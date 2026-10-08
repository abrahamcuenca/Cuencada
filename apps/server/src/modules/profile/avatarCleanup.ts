/**
 * Avatar and tree-photo upload cleanup, run on an interval by the profile
 * module. The same two passes run over `avatar_uploads` and (WP-4.3)
 * `person_photo_uploads`; the counts in the result cover both tables.
 *
 * 1. **Abandoned** uploads (never confirmed, `expires_at` older than the
 *    grace): the row is claimed (deleted with the condition re-checked)
 *    before its object is removed, so a concurrent confirm that already
 *    claimed it cannot lose its file.
 * 2. **Confirmed** rows past retention: the original is deleted again
 *    (idempotent; confirm already tried) and the row is dropped. The
 *    processed derivatives are never touched here.
 *
 * Idempotent: a second pass finds nothing; deleting a missing object is a no-op.
 */
import { and, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { Database } from "../../db/client.js";
import { avatarUploads, personPhotoUploads } from "../../db/schema/index.js";
import type { Clock } from "../../lib/clock.js";
import type { StorageService } from "../../lib/storage/types.js";
import {
  AVATAR_CLEANUP_BATCH_SIZE,
  AVATAR_CLEANUP_GRACE_MS,
  AVATAR_CLEANUP_MAX_BATCHES,
  AVATAR_CONFIRMED_RETENTION_MS
} from "./constants.js";
import { errorName } from "./shared.js";

/** What a cleanup pass needs. */
export interface AvatarCleanupDeps {
  db: Database;
  storage: Pick<StorageService, "delete">;
  clock: Clock;
  log: Pick<FastifyBaseLogger, "info" | "warn">;
}

/** Result of one pass. */
export interface AvatarCleanupResult {
  abandonedDeleted: number;
  confirmedPurged: number;
  objectDeleteFailures: number;
}

/**
 * Run one cleanup pass.
 *
 * @param deps - DB, storage, clock (cutoffs use `clock.now()`) and logger.
 */
export async function cleanupAvatarUploads(deps: AvatarCleanupDeps): Promise<AvatarCleanupResult> {
  const result: AvatarCleanupResult = {
    abandonedDeleted: 0,
    confirmedPurged: 0,
    objectDeleteFailures: 0
  };
  await cleanupTable(deps, avatarUploads, "avatar", result);
  await cleanupTable(deps, personPhotoUploads, "person photo", result);
  if (result.abandonedDeleted > 0 || result.confirmedPurged > 0)
    deps.log.info({ ...result }, "avatar uploads cleaned up");
  return result;
}

/** Both upload tables share these columns. */
type UploadTable = typeof avatarUploads | typeof personPhotoUploads;

/** One table's two passes, added to `result`. */
async function cleanupTable(
  deps: AvatarCleanupDeps,
  table: UploadTable,
  label: string,
  result: AvatarCleanupResult
): Promise<void> {
  const now = deps.clock.now().getTime();
  const abandoned = and(isNull(table.confirmedAt), lt(table.expiresAt, new Date(now - AVATAR_CLEANUP_GRACE_MS)));
  const retired = and(
    isNotNull(table.confirmedAt),
    lt(table.confirmedAt, new Date(now - AVATAR_CONFIRMED_RETENTION_MS))
  );

  for (const [condition, field] of [
    [abandoned, "abandonedDeleted"],
    [retired, "confirmedPurged"]
  ] as const) {
    for (let batch = 0; batch < AVATAR_CLEANUP_MAX_BATCHES; batch += 1) {
      const candidates = deps.db.select({ id: table.id }).from(table).where(condition).limit(AVATAR_CLEANUP_BATCH_SIZE);
      const claimed = await deps.db
        .delete(table)
        .where(and(inArray(table.id, candidates), condition))
        .returning({ id: table.id, objectKey: table.objectKey });
      for (const row of claimed) {
        try {
          await deps.storage.delete(row.objectKey);
        } catch (error) {
          result.objectDeleteFailures += 1;
          deps.log.warn({ uploadId: row.id, errorName: errorName(error) }, `${label} cleanup object delete failed`);
        }
      }
      result[field] += claimed.length;
      if (claimed.length < AVATAR_CLEANUP_BATCH_SIZE) break;
    }
  }
}
