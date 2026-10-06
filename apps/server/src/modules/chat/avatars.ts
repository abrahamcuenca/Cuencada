/**
 * Sender avatars for chat messages, presigned once per distinct key.
 *
 * TODO(T7 after T5 merges): replace `presignAvatar` with the profile
 * module's `avatarUrlFor(app, key, AvatarSize.Small)` (the only supported
 * way to turn `profiles.avatar_key` into a URL). Until then this mirrors its
 * rules: only keys the profile module writes are signed, and a storage
 * failure degrades to `null` (logged without the key).
 */
import type { FastifyBaseLogger } from "fastify";
import type { StorageService } from "../../lib/storage/types.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** `profiles.avatar_key` values the profile module writes. */
const AVATAR_KEY_PATTERN = new RegExp(`^avatars/${UUID}/${UUID}-256\\.webp$`);
/** Same TTL as the profile module's avatar URLs. */
const AVATAR_URL_TTL_SECONDS = 3600;

/** What avatar signing needs from the app. */
export interface AvatarDeps {
  storage: Pick<StorageService, "presignGet">;
  log: Pick<FastifyBaseLogger, "warn">;
}

async function presignAvatar(deps: AvatarDeps, key: string): Promise<string | null> {
  if (!AVATAR_KEY_PATTERN.test(key)) return null;
  try {
    const signed = await deps.storage.presignGet({
      key,
      expiresInSeconds: AVATAR_URL_TTL_SECONDS
    });
    return signed.url;
  } catch (error) {
    deps.log.warn({ errorName: error instanceof Error ? error.name : "unknown" }, "chat avatar presign failed");
    return null;
  }
}

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
  const urls = await Promise.all(distinct.map((key) => presignAvatar(deps, key)));
  return new Map(distinct.map((key, index) => [key, urls[index] ?? null]));
}
