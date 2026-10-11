/**
 * Event cover keys (WP-5.2 decision 5). All server-generated from ids:
 * - original `events/{eventId}/cover/{uploadId}.{jpg|png|webp}` (what the
 *   browser PUTs; deleted once processed, it may carry EXIF/GPS);
 * - derivatives `events/{eventId}/cover/{uploadId}-{1280|640}.webp`;
 *   `events.cover_key` stores the 1280 one (DB CHECK `events_cover_check`).
 */
import { EVENT_COVER_WIDTHS } from "@cuencada/types";
import type { AvatarMimeType } from "../../db/schema/index.js";

const EXTENSION_BY_MIME = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp"
} as const satisfies Record<AvatarMimeType, string>;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** `events.cover_key` values this module writes. */
const COVER_KEY_PATTERN = new RegExp(`^(events/${UUID}/cover/${UUID})-1280\\.webp$`);

/** Keys of one cover upload. */
export interface CoverKeys {
  original: string;
  w1280: string;
  w640: string;
}

/**
 * Keys for a cover upload.
 *
 * @param eventId - The event (from the row, never input).
 * @param uploadId - The `event_cover_uploads` id.
 * @param mimeType - Declared type (original's extension).
 */
export function coverKeys(eventId: string, uploadId: string, mimeType: AvatarMimeType): CoverKeys {
  const base = `events/${eventId}/cover/${uploadId}`;
  return { original: `${base}.${EXTENSION_BY_MIME[mimeType]}`, w1280: `${base}-1280.webp`, w640: `${base}-640.webp` };
}

/**
 * The derivative key of a stored cover at `width`, or `null` (no cover, or a
 * key this module did not write: never presigned).
 */
export function coverKeyForWidth(coverKey: string | null, width: (typeof EVENT_COVER_WIDTHS)[number]): string | null {
  if (coverKey === null) return null;
  const match = COVER_KEY_PATTERN.exec(coverKey);
  if (match === null) return null;
  return `${match[1]}-${width}.webp`;
}

/** Both derivatives of a stored cover (for deletion), or `[]`. */
export function coverDerivativeKeys(coverKey: string | null): string[] {
  return EVENT_COVER_WIDTHS.map((width) => coverKeyForWidth(coverKey, width)).filter((key): key is string => key !== null);
}
