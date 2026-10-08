/**
 * The one place where a merge touches tree-photo objects (WP-4.5), over the
 * WP-4.3 helpers in `personPhoto.ts`.
 *
 * Inside the merge transaction, before the duplicate is deleted, collect
 * every object of the duplicate's tree photo (its current derivatives and
 * its pending uploads) **except** the photo that moves to the kept person;
 * after the commit, delete them (best effort, logged without keys). The
 * duplicate's `person_photo_uploads` rows cascade with it: a pending upload
 * is an in-flight change to the removed person (its keys carry that person's
 * id), so it is dropped rather than moved.
 */
import type { DbOrTx } from "../../lib/audit.js";
import type { UploadPipelineDeps } from "../profile/uploadPipeline.js";
import { deletePersonPhotoObjects, personPhotoDerivativeKeys, personPhotoObjectKeys } from "./personPhoto.js";

/**
 * Object keys the merge removes with the duplicate.
 *
 * @param tx - The merge transaction (before the duplicate is deleted).
 * @param duplicateId - The person being merged away.
 * @param movedPhotoKey - The duplicate's `photo_key` when that photo moves to the kept person, else `null`.
 */
export async function losingPhotoKeys(tx: DbOrTx, duplicateId: string, movedPhotoKey: string | null): Promise<string[]> {
  const keys = await personPhotoObjectKeys(tx, duplicateId);
  const moved = personPhotoDerivativeKeys(movedPhotoKey);
  const kept = new Set(moved === null ? [] : [moved.display, moved.large, moved.small]);
  return keys.filter((key) => !kept.has(key));
}

/**
 * Delete the losing objects after the commit (failures are logged, never thrown).
 *
 * @param deps - Storage and logger.
 * @param keys - From {@link losingPhotoKeys}.
 */
export async function deleteLosingPhotoObjects(deps: Pick<UploadPipelineDeps, "storage" | "log">, keys: readonly string[]): Promise<void> {
  await deletePersonPhotoObjects(deps, keys);
}
