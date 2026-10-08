/**
 * `PersonDetails` builder (WP-4.1 owns it; ADR 0001 §6): one person's full
 * card for `GET /api/family/people/:id` and the member write routes.
 *
 * - Privacy of `Person` fields: `toPerson` with the viewer's qualifying circle.
 * - Photo: `resolvePersonPhoto` (WP-4.3), with `avatarKey: null` whenever the
 *   viewer may not see the linked account's avatar (unlisted/disabled rules).
 * - Contacts: `personContactCard` + `loadPersonContactRows` (WP-4.4), only
 *   for linked, listed, active accounts (every family read is verified-only).
 * - `canEdit`, `canEditPhoto`, `canAddRelative`, `canDelete` are UX hints;
 *   every write re-checks them.
 */
import type { PersonDetails } from "@cuencada/types";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { personRelationships } from "../../db/schema/index.js";
import type { DbOrTx } from "../../lib/audit.js";
import type { AvatarUrlDeps } from "../profile/avatar.js";
import { AvatarSize } from "../profile/constants.js";
import type { FamilyCircle } from "./circle.js";
import { loadPersonContactRows, personContactCard } from "./personContacts.js";
import { resolvePersonPhoto } from "./personPhoto.js";
import { type PersonViewRow, type Viewer, canSeeAvatar, canSeeLink, toPerson } from "./repository.js";

/** What the builder needs from the app. */
export type PersonDetailsDeps = AvatarUrlDeps & { db: DbOrTx };

const foreignEdgeRowSchema = z.object({ found: z.boolean() });

/**
 * True when `personId` has an edge that a member delete may **not** remove:
 * anything but a member edge made by `userId` together with the person (same
 * transaction, so the same `created_at`, compared in SQL to keep microseconds).
 *
 * @param db - Client or transaction (holding the tree lock for a delete).
 * @param personId - The person.
 * @param userId - The member.
 */
export async function hasForeignEdges(db: DbOrTx, personId: string, userId: string): Promise<boolean> {
  const rows = await db.execute(sql`
    select exists(
      select 1 from ${personRelationships} r
      where (r.from_person_id = ${personId}::uuid or r.to_person_id = ${personId}::uuid)
        and not (
          r.created_by_member
          and r.created_by_user_id = ${userId}::uuid
          and r.created_at = (select p.created_at from people p where p.id = ${personId}::uuid)
        )
    ) as found
  `);
  const parsed = foreignEdgeRowSchema.safeParse(rows[0]);
  if (!parsed.success) throw new Error("edge check returned an unexpected row shape");
  return parsed.data.found;
}

/**
 * True when `viewer` may edit `row` as a member (admins always may): the
 * person is the viewer's own, or in their qualifying circle and not linked to
 * another account.
 */
export function memberCanEdit(row: Pick<PersonViewRow, "id" | "userId">, viewer: Viewer, circle: FamilyCircle): boolean {
  if (row.userId !== null) return row.userId === viewer.id;
  return circle.ids.has(row.id);
}

/**
 * Build the card for `row` as seen by `viewer`.
 *
 * @param deps - Client, storage and logger.
 * @param row - The person (with the linked profile/account join).
 * @param viewer - The caller.
 * @param circle - The viewer's qualifying circle (ignored for admins).
 */
export async function buildPersonDetails(
  deps: PersonDetailsDeps,
  row: PersonViewRow,
  viewer: Viewer,
  circle: FamilyCircle
): Promise<PersonDetails> {
  const admin = viewer.role === "admin";
  const isSelf = row.userId !== null && row.userId === viewer.id;
  const scoped: Viewer = { ...viewer, circle: circle.ids };
  const photo = await resolvePersonPhoto(
    deps,
    { avatarKey: canSeeAvatar(row, scoped) ? row.avatarKey : null, photoKey: row.photoKey },
    AvatarSize.Large
  );
  const person = toPerson(row, scoped, new Map([[row.id, photo?.photoUrl ?? null]]));

  const contactsAllowed = row.userId !== null && row.listedInDirectory !== false && row.userStatus === "active";
  let contacts: PersonDetails["contacts"] = [];
  if (contactsAllowed && row.userId !== null) {
    const contactRows = await loadPersonContactRows(deps.db, [row.userId]);
    contacts = personContactCard(contactRows.get(row.userId) ?? null);
  }

  const canDelete =
    !admin &&
    row.createdByUserId === viewer.id &&
    row.userId === null &&
    !(await hasForeignEdges(deps.db, row.id, viewer.id));

  return {
    ...person,
    birthDate: person.birthDate ?? null,
    deathDate: person.deathDate ?? null,
    birthplace: person.birthplace ?? null,
    bio: person.bio ?? null,
    photoUrl: photo?.photoUrl ?? null,
    photoSource: photo?.photoSource ?? null,
    isLinked: canSeeLink(row, scoped),
    canEdit: admin || memberCanEdit(row, viewer, circle),
    canEditPhoto: admin || isSelf || circle.close.has(row.id),
    contacts,
    canAddRelative: admin || circle.ids.has(row.id),
    canDelete
  };
}
