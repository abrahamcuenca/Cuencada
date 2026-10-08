/**
 * Who may change a person's tree photo (WP-4.3; ADR 0001 §6) [SEC], in one
 * place for the intent, confirm and delete routes and for
 * `PersonDetails.canEditPhoto` (WP-4.1's builder calls {@link photoEditDenial}).
 *
 * - **Admins**: anyone.
 * - **The linked member**: their own person.
 * - **Close relatives**: a person in the viewer's `FamilyCircle.close` set
 *   (parents, partners, children of self over **qualifying** edges, WP-4.1's
 *   `loadFamilyCircle`), and only while the target has **no account** (a
 *   linked person manages their own photo).
 */
import { FamilyIssueCode } from "@cuencada/types";
import type { DbOrTx } from "../../lib/audit.js";
import { EMPTY_CIRCLE, type FamilyCircle, loadFamilyCircle } from "./circle.js";
import type { PersonRow, Viewer } from "./repository.js";

/** The viewer fields the rule reads. */
type PhotoViewer = Pick<Viewer, "id" | "role">;

/**
 * Why `viewer` may not change `target`'s photo, or `null` when they may.
 *
 * [SEC] `PERSON_LINKED_TO_OTHER` is only told to **close relatives** (who
 * already know the family; accepted risk A13). Anyone else gets
 * `FAMILY_NOT_IN_CIRCLE`, so the code never reveals that an unlisted account
 * is linked to a node outside the caller's family.
 *
 * @param viewer - The caller.
 * @param target - The person whose photo would change.
 * @param circle - The viewer's qualifying circle (ignored for admins).
 */
export function photoEditDenial(
  viewer: PhotoViewer,
  target: Pick<PersonRow, "id" | "userId">,
  circle: FamilyCircle
): FamilyIssueCode | null {
  if (viewer.role === "admin") return null;
  if (target.userId !== null && target.userId === viewer.id) return null;
  if (!circle.close.has(target.id)) return FamilyIssueCode.NotInCircle;
  return target.userId === null ? null : FamilyIssueCode.PersonLinkedToOther;
}

/**
 * Load the viewer's circle (none for admins) and apply {@link photoEditDenial}.
 * Inside a write, call it after taking the tree lock.
 *
 * @param db - Client or transaction.
 * @param viewer - The caller.
 * @param target - The person whose photo would change.
 */
export async function loadPhotoEditDenial(
  db: DbOrTx,
  viewer: PhotoViewer,
  target: Pick<PersonRow, "id" | "userId">
): Promise<FamilyIssueCode | null> {
  const circle = viewer.role === "admin" ? EMPTY_CIRCLE : await loadFamilyCircle(db, viewer.id);
  return photoEditDenial(viewer, target, circle);
}

/**
 * Boolean form of {@link loadPhotoEditDenial}.
 *
 * @param db - Client or transaction.
 * @param viewer - The caller.
 * @param target - The person.
 */
export async function canEditPersonPhoto(db: DbOrTx, viewer: PhotoViewer, target: Pick<PersonRow, "id" | "userId">): Promise<boolean> {
  return (await loadPhotoEditDenial(db, viewer, target)) === null;
}
