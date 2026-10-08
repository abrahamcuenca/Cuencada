/**
 * `PersonDetails` for one person (`GET /api/family/people/:id` and the photo
 * routes of WP-4.3).
 *
 * **Interim builder, owned by WP-4.1.** WP-4.3 needs `canEditPhoto` and the
 * resolved photo on the person page before WP-4.1's builder lands, so this
 * one is deliberately **conservative**; WP-4.1 replaces the body (keep the
 * signature or update the three call sites):
 * - full dates and birthplace: deceased people for every verified member;
 *   living people only for themself and admins (WP-4.1 widens this to the
 *   qualifying circle);
 * - `canEdit`: admins and the person themself only (WP-4.1 adds the circle);
 * - `contacts`: always empty (fail closed; WP-4.4 / WP-4.1);
 * - `canEditPhoto`: the final rule (`canEditPersonPhoto`);
 * - `photoUrl`/`photoSource`: the final resolver, at 512 px.
 */
import type { PersonDetails } from "@cuencada/types";
import { eq } from "drizzle-orm";
import { people } from "../../db/schema/index.js";
import type { DbOrTx } from "../../lib/audit.js";
import type { AvatarUrlDeps } from "../profile/avatar.js";
import { canEditPersonPhoto } from "./photoAccess.js";
import { PersonPhotoSize, resolvePersonPhoto } from "./personPhoto.js";
import { canSeeAllFields, canSeeLink, personPhotoRowFor, type PersonViewRow, toPersonWithAvatar, type Viewer } from "./repository.js";

/** What {@link buildPersonDetails} needs from the app. */
export type PersonDetailsDeps = AvatarUrlDeps & { db: DbOrTx };

/**
 * Build the card for `row` as seen by `viewer`.
 *
 * @param deps - Client, storage and logger.
 * @param row - The person (from `findPerson`).
 * @param viewer - The caller (verified member or admin; the routes gate it).
 */
export async function buildPersonDetails(deps: PersonDetailsDeps, row: PersonViewRow, viewer: Viewer): Promise<PersonDetails> {
  const [extra] = await deps.db
    .select({ birthDate: people.birthDate, deathDate: people.deathDate, birthplace: people.birthplace, bio: people.bio })
    .from(people)
    .where(eq(people.id, row.id))
    .limit(1);
  const [person, photo, canEditPhoto] = await Promise.all([
    toPersonWithAvatar(deps, row, viewer),
    resolvePersonPhoto(deps, personPhotoRowFor(row, viewer), PersonPhotoSize.Display),
    canEditPersonPhoto(deps.db, viewer, row)
  ]);
  const showLifeDetails = row.deceased || canSeeAllFields(row, viewer);
  return {
    ...person,
    birthDate: showLifeDetails ? (extra?.birthDate ?? null) : null,
    deathDate: row.deceased ? (extra?.deathDate ?? null) : null,
    birthplace: showLifeDetails ? (extra?.birthplace ?? null) : null,
    bio: extra?.bio ?? null,
    photoUrl: photo?.photoUrl ?? null,
    photoSource: photo?.photoSource ?? null,
    isLinked: canSeeLink(row, viewer),
    canEdit: canSeeAllFields(row, viewer),
    canEditPhoto,
    contacts: []
  };
}
