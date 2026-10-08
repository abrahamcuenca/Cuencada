/**
 * Bucket objects of a person's tree photo, removed when an admin deletes the
 * person (WP-4.0 acceptance criterion for WP-4.1).
 *
 * The keys are read **inside** the delete transaction (the
 * `person_photo_uploads` rows cascade with the person) and deleted after the
 * commit, best effort: a failure is logged with the person id and the error
 * name only (never the key) and leaves an orphan object, not a broken row.
 *
 * Interim until WP-4.3 merges its own helper: the current photo is
 * `people.photo_key` plus its size siblings when the key ends in
 * `-<size>.webp` (512/256/64 px, the WP-4.3 layout); pending uploads are
 * every `person_photo_uploads.object_key` of the person. Only keys under the
 * server-generated `people/` prefix are touched, never client input.
 */
import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { personPhotoUploads } from "../../db/schema/index.js";
import type { DbOrTx } from "../../lib/audit.js";
import type { StorageService } from "../../lib/storage/types.js";

/** Derivative sizes a tree photo may have (WP-4.3). */
const PHOTO_SIZES = [512, 256, 64] as const;
const SIZED_KEY = /^(people\/.+)-(?:512|256|64)\.webp$/;
const PEOPLE_PREFIX = "people/";

/**
 * Every object key of `personId`'s tree photo (current derivatives and
 * pending uploads).
 *
 * @param db - The delete's transaction.
 * @param personId - The person.
 * @param photoKey - `people.photo_key`, or `null`.
 */
export async function personPhotoObjectKeys(db: DbOrTx, personId: string, photoKey: string | null): Promise<string[]> {
  const keys = new Set<string>();
  if (photoKey?.startsWith(PEOPLE_PREFIX)) {
    keys.add(photoKey);
    const base = SIZED_KEY.exec(photoKey)?.[1];
    if (base !== undefined) for (const size of PHOTO_SIZES) keys.add(`${base}-${size}.webp`);
  }
  const uploads = await db
    .select({ objectKey: personPhotoUploads.objectKey })
    .from(personPhotoUploads)
    .where(eq(personPhotoUploads.personId, personId));
  for (const upload of uploads) if (upload.objectKey.startsWith(PEOPLE_PREFIX)) keys.add(upload.objectKey);
  return [...keys];
}

/** What {@link deletePersonPhotoObjects} needs. */
export interface PhotoObjectDeleteDeps {
  storage: Pick<StorageService, "delete">;
  log: Pick<FastifyBaseLogger, "warn">;
}

/**
 * Delete the objects, logging and continuing on failure.
 *
 * @param deps - Storage and logger.
 * @param personId - For the log line.
 * @param keys - From {@link personPhotoObjectKeys}.
 * @returns How many deletes failed.
 */
export async function deletePersonPhotoObjects(deps: PhotoObjectDeleteDeps, personId: string, keys: readonly string[]): Promise<number> {
  let failures = 0;
  for (const key of keys) {
    try {
      await deps.storage.delete(key);
    } catch (error) {
      failures += 1;
      deps.log.warn({ personId, errorName: error instanceof Error ? error.name : "unknown" }, "person photo object delete failed");
    }
  }
  return failures;
}
