/**
 * Tunables for the T5 modules: avatar uploads, processing, cleanup and the
 * per-user rate limits of the profile and directory routes.
 */
import type { RateLimitWindow } from "../../lib/rateLimit.js";

/** Presigned PUT lifetime for an avatar upload (seconds). */
export const AVATAR_UPLOAD_URL_TTL_SECONDS = 5 * 60;

/**
 * How long after the PUT URL expires a confirm is still accepted (the PUT
 * may have started just before expiry). Past this, cleanup may delete the
 * row and object at any time, so confirm answers 400.
 */
export const AVATAR_CONFIRM_GRACE_MS = 60 * 60 * 1000;

/** Abandoned (never confirmed) uploads are deleted this long after `expires_at`. */
export const AVATAR_CLEANUP_GRACE_MS = AVATAR_CONFIRM_GRACE_MS;

/** Confirmed upload rows are bookkeeping only; they are purged this long after confirmation. */
export const AVATAR_CONFIRMED_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Cleanup timer period. */
export const AVATAR_CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

/** Rows handled per cleanup batch, and the batch cap per pass. */
export const AVATAR_CLEANUP_BATCH_SIZE = 200;
export const AVATAR_CLEANUP_MAX_BATCHES = 20;

/** Open (unconfirmed, unexpired) avatar intents allowed per user. */
export const AVATAR_MAX_OPEN_INTENTS = 5;

/** Square sizes of the processed avatar (px). The large one is `profiles.avatar_key`. */
export const AvatarSize = {
  Large: 256,
  Small: 64
} as const;
export type AvatarSize = (typeof AvatarSize)[keyof typeof AvatarSize];

/**
 * Decompression-bomb guard for sharp (width × height): ~24 MP covers any
 * phone camera (a 24 MP shot is 6000 × 4000) while halving the worst-case
 * decode of the generic 50 MP media limit.
 */
export const AVATAR_MAX_INPUT_PIXELS = 24_000_000;

/** Avatars decoded at once in this process (sharp is CPU and memory heavy). */
export const AVATAR_PROCESSING_CONCURRENCY = 2;

/** WebP quality of the derivatives. */
export const AVATAR_WEBP_QUALITY = 82;

/** Presigned GET lifetime for avatar URLs in responses (seconds). */
export const AVATAR_URL_TTL_SECONDS = 60 * 60;

/**
 * `Cache-Control` stored on the derivatives: private, and no longer than the
 * presigned GET ({@link AVATAR_URL_TTL_SECONDS}) so avatars do not outlive a
 * logout in the browser's disk cache (WP-2.3 N1; it was a year).
 */
export const AVATAR_CACHE_CONTROL = `private, max-age=${AVATAR_URL_TTL_SECONDS}`;

/** Bytes read for the magic-byte check. */
export const MAGIC_BYTES_LENGTH = 32;

/** Per-user rate limits. */
export const AVATAR_INTENT_RATE_LIMIT: RateLimitWindow = {
  max: 10,
  timeWindow: "1 hour"
};
export const AVATAR_CONFIRM_RATE_LIMIT: RateLimitWindow = {
  max: 20,
  timeWindow: "1 hour"
};
export const AVATAR_DELETE_RATE_LIMIT: RateLimitWindow = {
  max: 20,
  timeWindow: "1 hour"
};
export const PROFILE_UPDATE_RATE_LIMIT: RateLimitWindow = {
  max: 30,
  timeWindow: "1 minute"
};
export const DIRECTORY_SEARCH_RATE_LIMIT: RateLimitWindow = {
  max: 60,
  timeWindow: "1 minute"
};
export const DIRECTORY_DETAIL_RATE_LIMIT: RateLimitWindow = {
  max: 120,
  timeWindow: "1 minute"
};
