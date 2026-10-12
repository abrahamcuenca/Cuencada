/**
 * TODO(WP-6.2): placeholder for `moveMediaTagsTx`, which WP-6.2 implements
 * in `modules/social/` (WP-6.0 "Integrations"). WP-6.4's `mergePeopleTx`
 * already calls it before deleting the duplicate. Whichever of 6.2 and 6.4
 * merges second points the import in `family/merge.ts` at 6.2's real
 * function and deletes this file.
 *
 * Until 6.2 lands no code writes `media_tags`, so there is nothing to move:
 * this no-op is exact, not a gap.
 */
import type { Transaction } from "../../lib/audit.js";

/** Result of moving a merged person's photo tags. */
export interface MoveMediaTagsResult {
  moved: number;
  dropped: number;
}

/**
 * Move every tag of `fromPersonId` to `toPersonId` (WP-6.2 contract; no-op here).
 *
 * @param tx - The merge's transaction.
 * @param fromPersonId - The duplicate.
 * @param toPersonId - The person that stays.
 */
export async function moveMediaTagsTx(tx: Transaction, fromPersonId: string, toPersonId: string): Promise<MoveMediaTagsResult> {
  void tx;
  void fromPersonId;
  void toPersonId;
  return { moved: 0, dropped: 0 };
}
