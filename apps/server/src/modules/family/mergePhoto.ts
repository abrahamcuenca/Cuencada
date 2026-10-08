/**
 * The one place where a merge touches tree-photo objects (WP-4.5): the
 * duplicate's losing photo (when both people had one) is collected inside the
 * merge transaction and deleted after the commit, best effort.
 *
 * Thin adapter over the person-photo object helpers, so swapping them (WP-4.3
 * replaces `personPhotoObjects.ts`) is a change to this file only.
 */
import type { DbOrTx } from "../../lib/audit.js";
import { type PhotoObjectDeleteDeps, deletePersonPhotoObjects, personPhotoObjectKeys } from "./personPhotoObjects.js";

/**
 * Object keys of the duplicate's current tree photo. Call after its pending
 * uploads moved to the kept person, so only the losing photo is collected.
 *
 * @param tx - The merge transaction.
 * @param duplicateId - The person being merged away.
 * @param photoKey - Its `people.photo_key`.
 */
export async function losingPhotoKeys(tx: DbOrTx, duplicateId: string, photoKey: string | null): Promise<string[]> {
  return personPhotoObjectKeys(tx, duplicateId, photoKey);
}

/**
 * Delete the losing objects after the commit (failures are logged, never thrown).
 *
 * @param deps - Storage and logger.
 * @param duplicateId - For the log line.
 * @param keys - From {@link losingPhotoKeys}.
 */
export async function deleteLosingPhotoObjects(deps: PhotoObjectDeleteDeps, duplicateId: string, keys: readonly string[]): Promise<void> {
  await deletePersonPhotoObjects(deps, duplicateId, keys);
}
