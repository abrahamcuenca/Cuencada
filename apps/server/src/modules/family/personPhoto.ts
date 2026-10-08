/**
 * Person (tree) photos: server-generated object keys, presigned URLs and the
 * photo resolver for `Person.avatarUrl` / `PersonDetails.photoUrl`
 * (WP-4.0 interface, implemented in WP-4.3; ADR 0001 §6 "photo precedence").
 *
 * Ownership: WP-4.1 (the `PersonDetails` builder) **calls**
 * {@link resolvePersonPhoto} with a row it has already filtered for the
 * viewer (use `personPhotoRowFor` in `repository.ts`); WP-4.3 implements it.
 *
 * Keys (never client input): `people/{personId}/{uploadId}.{ext}` is the
 * original the browser PUTs (deleted once processed: it may carry EXIF/GPS);
 * `…-512.webp`, `…-256.webp` and `…-64.webp` are the derivatives, and
 * `people.photo_key` stores the 256 px one.
 */
import type { PersonPhotoSource } from "@cuencada/types";
import { eq } from "drizzle-orm";
import { type AvatarMimeType, people, personPhotoUploads } from "../../db/schema/index.js";
import type { DbOrTx } from "../../lib/audit.js";
import { type AvatarUrlDeps, avatarUrlFor } from "../profile/avatar.js";
import { AVATAR_URL_TTL_SECONDS, AvatarSize } from "../profile/constants.js";
import { errorName } from "../profile/shared.js";
import { deleteObjectsQuietly, type UploadPipelineDeps } from "../profile/uploadPipeline.js";

/**
 * Square sizes of a processed tree photo (px). `Display` (512) is only for
 * tree photos: avatars stop at 256, so a 512 request for an avatar is served
 * the 256 px derivative.
 */
export const PersonPhotoSize = {
  Display: 512,
  Large: AvatarSize.Large,
  Small: AvatarSize.Small
} as const;
export type PersonPhotoSize = (typeof PersonPhotoSize)[keyof typeof PersonPhotoSize];

/** Sizes rendered at confirm, largest first (see `processSquareImage`). */
export const PERSON_PHOTO_SIZES = [PersonPhotoSize.Display, PersonPhotoSize.Large, PersonPhotoSize.Small] as const;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** `people.photo_key` values this module writes: `people/{personId}/{uploadId}-256.webp`. */
const PHOTO_KEY_PATTERN = new RegExp(`^people/(${UUID})/(${UUID})-${PersonPhotoSize.Large}\\.webp$`);

const EXTENSION_BY_MIME = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp"
} as const satisfies Record<AvatarMimeType, string>;

/** Object keys of one tree-photo upload. */
export interface PersonPhotoKeys {
  /** What the browser PUTs; deleted once processed. */
  original: string;
  /** 512 px WebP. */
  display: string;
  /** 256 px WebP; stored in `people.photo_key`. */
  large: string;
  /** 64 px WebP. */
  small: string;
}

/**
 * Build the keys for a tree-photo upload.
 *
 * @param personId - The person (path segment; never client input).
 * @param uploadId - `person_photo_uploads.id`.
 * @param mimeType - Declared type (decides the original's extension).
 */
export function personPhotoKeys(personId: string, uploadId: string, mimeType: AvatarMimeType): PersonPhotoKeys {
  const base = `people/${personId}/${uploadId}`;
  return {
    original: `${base}.${EXTENSION_BY_MIME[mimeType]}`,
    display: `${base}-${PersonPhotoSize.Display}.webp`,
    large: `${base}-${PersonPhotoSize.Large}.webp`,
    small: `${base}-${PersonPhotoSize.Small}.webp`
  };
}

/**
 * The derivative keys behind a stored `photo_key`, or `null` when the value
 * is not one this module wrote. Callers must never presign or delete a key
 * that fails this check.
 *
 * @param photoKey - `people.photo_key`.
 */
export function personPhotoDerivativeKeys(photoKey: string | null): Omit<PersonPhotoKeys, "original"> | null {
  if (photoKey === null || !PHOTO_KEY_PATTERN.test(photoKey)) return null;
  const base = photoKey.slice(0, -`-${PersonPhotoSize.Large}.webp`.length);
  return {
    display: `${base}-${PersonPhotoSize.Display}.webp`,
    large: photoKey,
    small: `${base}-${PersonPhotoSize.Small}.webp`
  };
}

/**
 * Presigned GET (1 h) for a tree photo, or `null`.
 *
 * **Security: callers must check visibility first** (see `canSeePersonPhoto`
 * in `repository.ts`); like `avatarUrlFor`, this does no authorization. A key
 * this module did not write gives `null`, and a storage failure degrades to
 * `null` (logged without the key).
 *
 * @param deps - Storage and logger.
 * @param photoKey - `people.photo_key`.
 * @param size - 512, 256 (default) or 64 px.
 */
export async function personPhotoUrlFor(
  deps: AvatarUrlDeps,
  photoKey: string | null,
  size: PersonPhotoSize = PersonPhotoSize.Large
): Promise<string | null> {
  const keys = personPhotoDerivativeKeys(photoKey);
  if (keys === null) return null;
  const key = size === PersonPhotoSize.Display ? keys.display : size === PersonPhotoSize.Small ? keys.small : keys.large;
  try {
    const signed = await deps.storage.presignGet({ key, expiresInSeconds: AVATAR_URL_TTL_SECONDS });
    return signed.url;
  } catch (error) {
    deps.log.warn({ errorName: errorName(error) }, "person photo presign failed");
    return null;
  }
}

/** What the resolver needs from a person row (people left-joined to the linked profile). */
export interface PersonPhotoRow {
  /**
   * The linked account's avatar key, **already `null` when the viewer may not
   * see it** (unlisted or disabled account, see `canSeeAvatar` in
   * `repository.ts`). The resolver applies no visibility rules itself.
   */
  avatarKey: string | null;
  /**
   * `people.photo_key` (tree photo), **already `null` when the viewer may not
   * see it** (see `canSeePersonPhoto` in `repository.ts`: the same unlisted
   * and disabled rules as the avatar for a linked person).
   */
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
 * next source (and finally `null`), like `avatarUrlFor`. The tree photo is
 * kept when the person links an account, so it shows again if they remove
 * their avatar.
 *
 * WP-4.3 widened `size` to {@link PersonPhotoSize} (adds 512 px for tree
 * photos; an avatar asked at 512 is served at 256, its largest size). Every
 * existing `AvatarSize` argument is still valid.
 *
 * @param deps - Storage and logger.
 * @param row - Keys, already filtered for the viewer (`personPhotoRowFor`).
 * @param size - Square size: 512 (person page), 256 (`Person`) or 64 px (summaries).
 * @returns The presigned URL and its source, or `null` when there is no photo.
 */
export async function resolvePersonPhoto(
  deps: AvatarUrlDeps,
  row: PersonPhotoRow,
  size: AvatarSize | PersonPhotoSize = AvatarSize.Large
): Promise<ResolvedPersonPhoto | null> {
  if (row.avatarKey !== null) {
    const avatarSize = size === PersonPhotoSize.Small ? AvatarSize.Small : AvatarSize.Large;
    const photoUrl = await avatarUrlFor(deps, row.avatarKey, avatarSize);
    if (photoUrl !== null) return { photoUrl, photoSource: "avatar" };
  }
  if (row.photoKey !== null) {
    const photoUrl = await personPhotoUrlFor(deps, row.photoKey, size);
    if (photoUrl !== null) return { photoUrl, photoSource: "person" };
  }
  return null;
}

/**
 * Every bucket object of a person's tree photo: the current derivatives and
 * the originals of pending (or not yet purged) uploads. Read it **before**
 * deleting the person (the upload rows cascade), then pass the result to
 * {@link deletePersonPhotoObjects} after the transaction commits.
 *
 * For WP-4.1's admin person delete (WP-4.0 acceptance criterion).
 *
 * @param db - Client or transaction.
 * @param personId - The person.
 */
export async function personPhotoObjectKeys(db: DbOrTx, personId: string): Promise<string[]> {
  const [person] = await db.select({ photoKey: people.photoKey }).from(people).where(eq(people.id, personId)).limit(1);
  const uploads = await db
    .select({ objectKey: personPhotoUploads.objectKey, id: personPhotoUploads.id })
    .from(personPhotoUploads)
    .where(eq(personPhotoUploads.personId, personId));
  const keys: string[] = [];
  const current = personPhotoDerivativeKeys(person?.photoKey ?? null);
  if (current !== null) keys.push(current.display, current.large, current.small);
  for (const upload of uploads) {
    keys.push(upload.objectKey);
    // Derivatives of a confirm that lost a race or failed after storing them.
    const derived = personPhotoKeys(personId, upload.id, "image/jpeg");
    if (derived.large !== current?.large) keys.push(derived.display, derived.large, derived.small);
  }
  return [...new Set(keys)];
}

/**
 * Delete tree-photo objects (best effort, logged without keys).
 *
 * @param deps - Storage and logger.
 * @param keys - From {@link personPhotoObjectKeys} or the confirm/delete routes.
 */
export async function deletePersonPhotoObjects(
  deps: Pick<UploadPipelineDeps, "storage" | "log">,
  keys: readonly string[]
): Promise<void> {
  await deleteObjectsQuietly(deps, keys, "person photo");
}
