/**
 * Person photo resolution for `Person.avatarUrl` / `PersonDetails.photoUrl`
 * (WP-4.0 interface; ADR 0001 §6 "photo precedence").
 *
 * Ownership: WP-4.1 (the `PersonDetails` builder) **calls** this with a row it
 * has already filtered for the viewer; WP-4.3 **implements** the tree-photo
 * branch. The signature is fixed so both can work in parallel.
 */
import type { PersonPhotoSource } from "@cuencada/types";
import { type AvatarUrlDeps, avatarUrlFor } from "../profile/avatar.js";
import { AvatarSize } from "../profile/constants.js";

/** What the resolver needs from a person row (people left-joined to the linked profile). */
export interface PersonPhotoRow {
  /**
   * The linked account's avatar key, **already `null` when the viewer may not
   * see it** (unlisted or disabled account, see `canSeeAvatar` in
   * `repository.ts`). The resolver applies no visibility rules itself.
   */
  avatarKey: string | null;
  /** `people.photo_key` (tree photo), or `null`. */
  photoKey: string | null;
}

/** A resolved, presigned photo and where it came from. */
export interface ResolvedPersonPhoto {
  photoUrl: string;
  photoSource: PersonPhotoSource;
}

/**
 * Resolve the photo to show for a person: the linked account's own avatar
 * wins, else the tree photo, else `null`. Storage failures degrade to the
 * next source (and finally `null`), like `avatarUrlFor`.
 *
 * @param deps - Storage and logger.
 * @param row - Keys, already filtered for the viewer.
 * @param size - Square size: 256 px (`Person`, details) or 64 px (summaries).
 * @returns The presigned URL and its source, or `null` when there is no photo.
 */
export async function resolvePersonPhoto(
  deps: AvatarUrlDeps,
  row: PersonPhotoRow,
  size: AvatarSize = AvatarSize.Large
): Promise<ResolvedPersonPhoto | null> {
  if (row.avatarKey !== null) {
    const photoUrl = await avatarUrlFor(deps, row.avatarKey, size);
    if (photoUrl !== null) return { photoUrl, photoSource: "avatar" };
  }
  // TODO(WP-4.3): presign the tree photo derivative of `row.photoKey` (512/256/64 px,
  // generated server-side key under `people/<personId>/…`) and return
  // `{ photoUrl, photoSource: "person" }`. Until then people without an avatar have no photo.
  return null;
}
