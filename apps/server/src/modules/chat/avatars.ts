/**
 * Sender avatars for chat messages: the profile module's `avatarUrlFor`
 * (64 px), presigned once per distinct key. It signs only keys the profile
 * module wrote and degrades a storage failure to `null`.
 */
import { type AvatarUrlDeps, AvatarSize, avatarUrlFor } from "../profile/index.js";

/** What avatar signing needs from the app. */
export type AvatarDeps = AvatarUrlDeps;

/**
 * Presign each distinct avatar key once.
 *
 * @returns `avatar_key → URL | null`; look up missing keys as `null`.
 */
export async function avatarUrlsFor(
  deps: AvatarDeps,
  keys: Iterable<string | null>
): Promise<Map<string, string | null>> {
  const distinct = [...new Set([...keys].filter((key): key is string => key !== null))];
  const urls = await Promise.all(distinct.map((key) => avatarUrlFor(deps, key, AvatarSize.Small)));
  return new Map(distinct.map((key, index) => [key, urls[index] ?? null]));
}
