/**
 * Pure helpers for media files: display-name sanitizing, object keys and
 * file-signature (magic byte) sniffing. No I/O.
 */
import type { MediaMimeType } from "@cuencada/types";

/** Longest stored display file name, in code points. */
export const FILE_NAME_MAX_LENGTH = 255;

const FALLBACK_FILE_NAME = "archivo";

/** Inclusive code point ranges stripped from display file names. */
const STRIP_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x1f], // C0 controls
  [0x7f, 0x9f], // DEL + C1 controls
  [0x200b, 0x200f], // zero-width spaces/joiners, LRM/RLM
  [0x2028, 0x2029], // line/paragraph separators
  [0x202a, 0x202e], // bidi embeddings/overrides
  [0x2066, 0x2069], // bidi isolates
  [0xfeff, 0xfeff] // BOM
];

function isStripped(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return STRIP_RANGES.some(([low, high]) => code >= low && code <= high);
}

/**
 * Turn a client-supplied file name into safe display metadata: keeps only the
 * last path segment, strips control, bidi and invisible characters, collapses
 * whitespace, NFC-normalizes and caps the length. Never used to build a key.
 *
 * @param raw - File name from the upload intent.
 * @returns A non-empty, bounded display name.
 */
export function sanitizeFileName(raw: string): string {
  const lastSegment = raw.split(/[/\\]/).pop() ?? "";
  const visible = Array.from(lastSegment.normalize("NFC"))
    .filter((char) => !isStripped(char))
    .join("");
  const cleaned = visible.replace(/\s+/g, " ").trim();
  const capped = Array.from(cleaned).slice(0, FILE_NAME_MAX_LENGTH).join("").trim();
  return capped === "" || capped === "." || capped === ".." ? FALLBACK_FILE_NAME : capped;
}

const EXTENSION_BY_MIME = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/quicktime": "mov"
} as const satisfies Record<MediaMimeType, string>;

/** File extension used in object keys for an allowed MIME type. */
export function extensionForMime(mimeType: MediaMimeType): string {
  return EXTENSION_BY_MIME[mimeType];
}

/** Object keys of one media item. Always server-generated from ids. */
export interface MediaKeys {
  original: string;
  thumb: string;
  display: string;
}

/**
 * Build the object keys for a media item.
 *
 * @param year - Cuencada year.
 * @param mediaId - The item's uuid.
 * @param mimeType - Allowed MIME type (decides the original's extension).
 */
export function mediaKeys(year: number, mediaId: string, mimeType: MediaMimeType): MediaKeys {
  const base = `cuencadas/${year}`;
  return {
    original: `${base}/originals/${mediaId}.${extensionForMime(mimeType)}`,
    thumb: `${base}/thumbs/${mediaId}.webp`,
    display: `${base}/display/${mediaId}.webp`
  };
}

/**
 * Normalize a `Content-Type` value for comparison (drops parameters, lowercases).
 *
 * @param value - Raw header value.
 */
export function normalizeContentType(value: string | null): string | null {
  if (value === null) return null;
  const [type] = value.split(";");
  const normalized = (type ?? "").trim().toLowerCase();
  return normalized === "" ? null : normalized;
}

/** ISO-BMFF major brands accepted for `video/mp4`. */
const MP4_BRANDS: ReadonlySet<string> = new Set([
  "isom",
  "iso2",
  "iso3",
  "iso4",
  "iso5",
  "iso6",
  "mp41",
  "mp42",
  "avc1",
  "M4V ",
  "M4VH",
  "M4VP",
  "MSNV",
  "dash",
  "mmp4",
  "f4v "
]);

/** QuickTime major brand. */
const QUICKTIME_BRAND = "qt  ";

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.byteLength < offset + signature.length) return false;
  return signature.every((value, index) => bytes[offset + index] === value);
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  if (bytes.byteLength < start + length) return "";
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

/**
 * Detect which allowed MIME type the leading bytes of a file belong to.
 *
 * - JPEG `FF D8 FF`
 * - PNG `89 50 4E 47 0D 0A 1A 0A`
 * - WebP `RIFF????WEBP`
 * - MP4 / QuickTime: `ftyp` at offset 4 with an allowed major brand
 *
 * @param bytes - At least the first 12 bytes of the object.
 * @returns The sniffed type, or `null` when the signature is not allowed.
 */
export function sniffMediaType(bytes: Uint8Array): MediaMimeType | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  if (ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, 4);
    if (brand === QUICKTIME_BRAND) return "video/quicktime";
    if (MP4_BRANDS.has(brand)) return "video/mp4";
  }
  return null;
}

/**
 * True when the sniffed signature is acceptable for the declared type. A
 * QuickTime upload may carry an MP4 brand (iOS exports both), but an MP4
 * must not be a QuickTime file, and images must match exactly.
 *
 * @param declared - MIME type from the upload intent.
 * @param bytes - Leading bytes of the stored object.
 */
export function signatureMatches(declared: MediaMimeType, bytes: Uint8Array): boolean {
  const sniffed = sniffMediaType(bytes);
  if (sniffed === null) return false;
  if (declared === "video/quicktime") return sniffed === "video/quicktime" || sniffed === "video/mp4";
  return sniffed === declared;
}

/**
 * Read the duration from an ISO-BMFF `moov/mvhd` box, when the `moov` box
 * lies inside `bytes` (files written with "fast start"). Cheap best effort.
 *
 * @param bytes - Leading bytes of an MP4/QuickTime file.
 * @returns Whole seconds, or `null` when not found or implausible.
 */
export function readMp4DurationSeconds(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const moov = findBox(view, 0, bytes.byteLength, "moov");
  if (moov === null) return null;
  const mvhd = findBox(view, moov.contentStart, moov.end, "mvhd");
  if (mvhd === null) return null;
  const at = mvhd.contentStart;
  if (at + 4 > mvhd.end) return null;
  const version = view.getUint8(at);
  let timescale: number;
  let duration: number;
  if (version === 1) {
    if (at + 32 > mvhd.end) return null;
    timescale = view.getUint32(at + 20);
    duration = Number(view.getBigUint64(at + 24));
  } else {
    if (at + 20 > mvhd.end) return null;
    timescale = view.getUint32(at + 12);
    duration = view.getUint32(at + 16);
  }
  if (timescale === 0) return null;
  const seconds = Math.round(duration / timescale);
  // 0xFFFFFFFF means "unknown"; anything above a day is not a family video.
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 24 * 60 * 60) return null;
  return seconds;
}

interface BoxRange {
  contentStart: number;
  end: number;
}

function findBox(view: DataView, start: number, end: number, type: string): BoxRange | null {
  let offset = start;
  while (offset + 8 <= end) {
    let size = view.getUint32(offset);
    const boxType = String.fromCharCode(
      view.getUint8(offset + 4),
      view.getUint8(offset + 5),
      view.getUint8(offset + 6),
      view.getUint8(offset + 7)
    );
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) return null;
      size = Number(view.getBigUint64(offset + 8));
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < header) return null;
    const boxEnd = offset + size;
    if (boxType === type) {
      return boxEnd > end ? null : { contentStart: offset + header, end: boxEnd };
    }
    offset = boxEnd;
  }
  return null;
}
