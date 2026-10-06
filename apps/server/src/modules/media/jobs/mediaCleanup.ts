/**
 * Media cleanup pass (every 15 min). Three bounded, idempotent steps:
 *
 * 1. **Abandon:** `pending_upload` rows whose upload URL expired more than
 *    {@link UPLOAD_CLEANUP_GRACE_MS} ago are claimed by a soft delete (status
 *    re-checked, so a concurrent confirm that already moved the row to
 *    `processing` is skipped and a confirm that comes later gets 404), then
 *    their objects are deleted. Rows with a NULL `upload_expires_at` are never
 *    stale (WP-0.3: legacy rows may point at real objects).
 * 2. **Sweep leftovers:** for rows deleted, failed or processed between
 *    {@link SWEEP_MAX_AGE_MS} and {@link SWEEP_MIN_AGE_MS} ago, object deletes
 *    are re-issued (deleting a missing key is a no-op): every key of deleted
 *    and failed rows, and the original of ready rows (only sanitized copies
 *    are served). This retries transient storage failures and removes bytes a
 *    client re-PUT with a still-valid URL after rejection/processing. No
 *    schema change is needed: the time window is the tracking.
 * 3. **Purge:** abandoned/cancelled `pending_upload` rows soft-deleted before
 *    the sweep window are hard-deleted (their objects were swept already).
 */
import { and, asc, between, eq, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { cuencadas, mediaItems } from "../../../db/schema/index.js";
import {
  CLEANUP_BATCH_SIZE,
  CLEANUP_MAX_BATCHES,
  SWEEP_BATCH_SIZE,
  SWEEP_MAX_AGE_MS,
  SWEEP_MIN_AGE_MS,
  UPLOAD_CLEANUP_GRACE_MS
} from "../constants.js";
import { deleteObjectsQuietly } from "../objects.js";
import { allObjectKeys } from "../service.js";
import type { MediaJobDeps } from "./mediaProcess.js";

/** What a cleanup pass needs: DB, storage, clock and a logger (info/warn only). */
export type CleanupDeps = Pick<MediaJobDeps, "db" | "storage" | "clock"> & {
  log: Pick<FastifyBaseLogger, "info" | "warn">;
};

/** Result of one cleanup pass. */
export interface CleanupResult {
  /** Stale `pending_upload` rows claimed (soft-deleted) this pass. */
  abandoned: number;
  /** Rows whose leftover objects were re-deleted. */
  swept: number;
  /** Old abandoned/cancelled pending rows hard-deleted. */
  purged: number;
  objectDeleteFailures: number;
}

async function abandonStaleUploads(deps: CleanupDeps, now: Date, result: CleanupResult): Promise<void> {
  const cutoff = new Date(now.getTime() - UPLOAD_CLEANUP_GRACE_MS);
  const stale = and(
    eq(mediaItems.uploadStatus, "pending_upload"),
    isNull(mediaItems.deletedAt),
    isNotNull(mediaItems.uploadExpiresAt),
    lt(mediaItems.uploadExpiresAt, cutoff)
  );
  for (let batch = 0; batch < CLEANUP_MAX_BATCHES; batch += 1) {
    const candidates = deps.db.select({ id: mediaItems.id }).from(mediaItems).where(stale).limit(CLEANUP_BATCH_SIZE);
    const claimed = await deps.db
      .update(mediaItems)
      .set({ deletedAt: now })
      .where(and(inArray(mediaItems.id, candidates), stale))
      .returning({ id: mediaItems.id, objectKey: mediaItems.objectKey });
    for (const row of claimed) {
      result.objectDeleteFailures += await deleteObjectsQuietly(deps, row.id, [row.objectKey]);
    }
    result.abandoned += claimed.length;
    if (claimed.length < CLEANUP_BATCH_SIZE) break;
  }
}

async function sweepLeftoverObjects(deps: CleanupDeps, now: Date, result: CleanupResult): Promise<void> {
  const from = new Date(now.getTime() - SWEEP_MAX_AGE_MS);
  const to = new Date(now.getTime() - SWEEP_MIN_AGE_MS);

  const gone = await deps.db
    .select({ item: mediaItems, year: cuencadas.year })
    .from(mediaItems)
    .innerJoin(cuencadas, eq(cuencadas.id, mediaItems.cuencadaId))
    .where(
      or(
        between(mediaItems.deletedAt, from, to),
        and(eq(mediaItems.uploadStatus, "failed"), between(mediaItems.updatedAt, from, to))
      )
    )
    .orderBy(asc(mediaItems.updatedAt))
    .limit(SWEEP_BATCH_SIZE);
  for (const { item, year } of gone) {
    result.objectDeleteFailures += await deleteObjectsQuietly(deps, item.id, allObjectKeys(item, year));
  }

  const ready = await deps.db
    .select({ id: mediaItems.id, objectKey: mediaItems.objectKey, thumbKey: mediaItems.thumbKey, displayKey: mediaItems.displayKey })
    .from(mediaItems)
    .where(
      and(
        eq(mediaItems.uploadStatus, "ready"),
        isNull(mediaItems.deletedAt),
        between(mediaItems.processedAt, from, to)
      )
    )
    .orderBy(asc(mediaItems.processedAt))
    .limit(SWEEP_BATCH_SIZE);
  for (const row of ready) {
    // Never delete a key that is being served (legacy rows that display their original).
    if (row.objectKey === row.displayKey || row.objectKey === row.thumbKey) continue;
    result.objectDeleteFailures += await deleteObjectsQuietly(deps, row.id, [row.objectKey]);
  }
  result.swept += gone.length + ready.length;
}

async function purgeOldPendingRows(deps: CleanupDeps, now: Date, result: CleanupResult): Promise<void> {
  const before = new Date(now.getTime() - SWEEP_MAX_AGE_MS);
  const old = and(
    eq(mediaItems.uploadStatus, "pending_upload"),
    isNotNull(mediaItems.uploadExpiresAt),
    isNotNull(mediaItems.deletedAt),
    lt(mediaItems.deletedAt, before)
  );
  const candidates = deps.db.select({ id: mediaItems.id }).from(mediaItems).where(old).limit(CLEANUP_BATCH_SIZE);
  const purged = await deps.db
    .delete(mediaItems)
    .where(and(inArray(mediaItems.id, candidates), old))
    .returning({ id: mediaItems.id });
  result.purged += purged.length;
}

/**
 * Run one cleanup pass (abandon, sweep, purge).
 *
 * @param deps - DB, storage, clock (every cutoff uses `clock.now()`) and logger.
 */
export async function runMediaCleanup(deps: CleanupDeps): Promise<CleanupResult> {
  const now = deps.clock.now();
  const result: CleanupResult = { abandoned: 0, swept: 0, purged: 0, objectDeleteFailures: 0 };
  await abandonStaleUploads(deps, now, result);
  await sweepLeftoverObjects(deps, now, result);
  await purgeOldPendingRows(deps, now, result);
  if (result.abandoned + result.purged + result.objectDeleteFailures > 0) deps.log.info({ ...result }, "media cleanup pass");
  return result;
}
