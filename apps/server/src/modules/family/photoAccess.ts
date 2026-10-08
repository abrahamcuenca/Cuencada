/**
 * Who may change a person's tree photo (WP-4.3; ADR 0001 §6) [SEC], in one
 * place for the intent, confirm and delete routes and for
 * `PersonDetails.canEditPhoto`.
 *
 * - **Admins**: anyone.
 * - **The linked member**: their own person.
 * - **Close relatives**: a member whose own person is a parent, child or
 *   partner of the target over a **qualifying** edge, and only while the
 *   target has **no account** (a linked person manages their own photo;
 *   relatives cannot set what represents another member).
 *
 * {@link qualifyingEdge} is the Security M1 rule (ADR 0001 §6), exported so
 * WP-4.1's circle walk can reuse the exact same predicate:
 * an edge qualifies when an admin created it (`created_by_member = false`),
 * or a member created it **and** that member also created one of its two
 * endpoint people. Anything else (incl. after the creator's account was
 * deleted, `created_by_user_id` null) does not qualify: fail closed.
 */
import { FamilyIssueCode, RelationshipKind } from "@cuencada/types";
import { and, eq, or, type SQL, sql } from "drizzle-orm";
import { people, personRelationships } from "../../db/schema/index.js";
import type { DbOrTx } from "../../lib/audit.js";
import type { PersonRow, Viewer } from "./repository.js";
import { findPersonByUserId } from "./repository.js";

/**
 * SQL predicate: the `person_relationships` row `edge` is a qualifying edge
 * (Security M1). Correlated subqueries on the endpoints, so it can be used in
 * any `where` over `person_relationships` (or an alias of it).
 *
 * @param edge - The relationships table or an alias of it.
 */
export function qualifyingEdge(edge: typeof personRelationships = personRelationships): SQL {
  const endpoint = sql.identifier("qualifying_endpoint");
  return sql`(${edge.createdByMember} = false or (${edge.createdByUserId} is not null and exists (
    select 1 from ${people} as ${endpoint}
    where ${endpoint}.id in (${edge.fromPersonId}, ${edge.toPersonId})
      and ${endpoint}.created_by_user_id = ${edge.createdByUserId}
  )))`;
}

/**
 * True when `a` and `b` are directly related as parent/child (either
 * direction) or partners, over a qualifying edge. Symmetric; one indexed
 * query (`from_person_id`/`to_person_id` indexes).
 *
 * @param db - Client or transaction.
 * @param a - A person id (e.g. the viewer's own person).
 * @param b - Another person id.
 */
export async function isCloseRelative(db: DbOrTx, a: string, b: string): Promise<boolean> {
  if (a === b) return false;
  const edge = personRelationships;
  const [row] = await db
    .select({ id: edge.id })
    .from(edge)
    .where(
      and(
        or(eq(edge.kind, RelationshipKind.ParentOf), eq(edge.kind, RelationshipKind.PartnerOf)),
        or(and(eq(edge.fromPersonId, a), eq(edge.toPersonId, b)), and(eq(edge.fromPersonId, b), eq(edge.toPersonId, a))),
        qualifyingEdge(edge)
      )
    )
    .limit(1);
  return row !== undefined;
}

/**
 * The tree-photo rule in the module comment.
 *
 * @param db - Client or transaction.
 * @param viewer - The caller (role from the verified session).
 * @param target - The person whose photo would change.
 */
export async function canEditPersonPhoto(db: DbOrTx, viewer: Viewer, target: Pick<PersonRow, "id" | "userId">): Promise<boolean> {
  return (await photoEditDenial(db, viewer, target)) === null;
}

/**
 * Why `viewer` may not change `target`'s photo, or `null` when they may.
 *
 * [SEC] `PERSON_LINKED_TO_OTHER` is only told to **close relatives** (who
 * already know the family; accepted risk A13). Anyone else gets
 * `FAMILY_NOT_IN_CIRCLE`, so the code never reveals that an unlisted account
 * is linked to a node outside the caller's family.
 *
 * @param db - Client or transaction.
 * @param viewer - The caller.
 * @param target - The person whose photo would change.
 */
export async function photoEditDenial(
  db: DbOrTx,
  viewer: Viewer,
  target: Pick<PersonRow, "id" | "userId">
): Promise<FamilyIssueCode | null> {
  if (viewer.role === "admin") return null;
  if (target.userId !== null && target.userId === viewer.id) return null;
  const own = await findPersonByUserId(db, viewer.id);
  const close = own !== undefined && (await isCloseRelative(db, own.id, target.id));
  if (!close) return FamilyIssueCode.NotInCircle;
  return target.userId === null ? null : FamilyIssueCode.PersonLinkedToOther;
}
