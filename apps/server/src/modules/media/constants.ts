/**
 * Tunables for the media pipeline (T4). Kept in one place so tests and docs
 * reference the same numbers.
 */

/** Lifetime of the presigned PUT returned by the upload intent. */
export const UPLOAD_URL_SECONDS = 5 * 60;

/**
 * Grace period after `upload_expires_at` before a `pending_upload` row is
 * considered abandoned. A PUT that started before the URL expired may still
 * be streaming a 300 MB video over a slow phone connection.
 */
export const UPLOAD_CLEANUP_GRACE_MS = 6 * 60 * 60 * 1000;

/** How often the abandoned-upload cleanup runs. */
export const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

/** Rows removed per cleanup batch (bounded so one run never holds long locks). */
export const CLEANUP_BATCH_SIZE = 200;

/** Upper bound on batches per cleanup run. */
export const CLEANUP_MAX_BATCHES = 20;

/** Presigned GET lifetime for thumbnails/display copies in list responses. */
export const VIEW_URL_SECONDS = 60 * 60;

/** Upload intents per user per minute. */
export const UPLOAD_INTENT_RATE_LIMIT = { max: 30, timeWindow: "1 minute" } as const;

/** Confirms per user per minute (each costs a HEAD and a ranged GET). */
export const CONFIRM_RATE_LIMIT = { max: 60, timeWindow: "1 minute" } as const;

/**
 * Per-user upload budget over a rolling 24 h, in bytes (sum of `byte_size` of
 * the user's non-failed items created in the window, deleted ones included so
 * delete-and-reupload cannot bypass it). Future config key:
 * `MEDIA_DAILY_UPLOAD_BYTES` (config.ts is frozen in Phase 1).
 */
export const DAILY_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

/** Window of {@link DAILY_UPLOAD_BYTES}. */
export const DAILY_UPLOAD_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Leftover-object sweep: rows deleted, failed or processed between 25 h and
 * 1 h ago get their (idempotent) object deletes re-issued on every pass, so a
 * transient storage failure or a late re-PUT is cleaned up within a day.
 */
export const SWEEP_MIN_AGE_MS = 60 * 60 * 1000;
export const SWEEP_MAX_AGE_MS = 25 * 60 * 60 * 1000;

/** Rows per sweep category per pass. */
export const SWEEP_BATCH_SIZE = 200;

/** Reports per user per minute. */
export const REPORT_RATE_LIMIT = { max: 30, timeWindow: "1 minute" } as const;

/** Open (`pending_upload`) intents one user may hold at once. */
export const MAX_PENDING_UPLOADS_PER_USER = 50;

/** Decompression-bomb guard: images above this many pixels are rejected (50 MP). */
export const MAX_INPUT_PIXELS = 50_000_000;

/** Thumbnail width in px (WebP). */
export const THUMB_WIDTH = 400;

/** Display copy width in px (WebP). */
export const DISPLAY_WIDTH = 1600;

/** Bytes read on confirm to sniff the file signature. */
export const SNIFF_BYTES = 32;


/** `Cache-Control` for derivatives: their keys never change, and the bucket is private. */
export const DERIVATIVE_CACHE_CONTROL = "private, max-age=31536000, immutable";

/** Job name used in logs. */
export const MEDIA_PROCESS_JOB = "media.process";
