/**
 * Avatar helpers: server-generated object keys, magic-byte sniffing, sharp
 * processing (auto-rotate, strip metadata, cropped square WebP; shared with
 * the tree photos of WP-4.3 through `processSquareImage`) and presigned
 * avatar URLs for responses.
 *
 * `avatarUrlFor` is the public export other tracks (T3 RSVP, T6 family,
 * T7 chat) use to turn `profiles.avatar_key` into a URL.
 */
import { clampCropRect, type ImageCropRect } from "@cuencada/types";
import type { AvatarMimeType } from "../../db/schema/index.js";
import sharp from "sharp";
import type { FastifyBaseLogger } from "fastify";
import type { StorageService } from "../../lib/storage/types.js";
import {
  AVATAR_MAX_INPUT_PIXELS,
  AVATAR_PROCESSING_CONCURRENCY,
  AVATAR_URL_TTL_SECONDS,
  AVATAR_WEBP_QUALITY,
  AvatarSize
} from "./constants.js";
import { Semaphore } from "./semaphore.js";
import { errorName } from "./shared.js";
import { normalizeContentType, signatureMatches, sniffMediaType } from "../media/files.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** `profiles.avatar_key` values this module writes: `avatars/{userId}/{uploadId}-256.webp`. */
const AVATAR_KEY_PATTERN = new RegExp(`^avatars/(${UUID})/(${UUID})-${AvatarSize.Large}\\.webp$`);

const EXTENSION_BY_MIME = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp"
} as const satisfies Record<AvatarMimeType, string>;

/** sharp's `metadata().format` for each accepted MIME type. */
const SHARP_FORMAT_BY_MIME = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp"
} as const satisfies Record<AvatarMimeType, string>;

/** Object keys of one avatar upload. Always built from server-side ids. */
export interface AvatarKeys {
  /** What the browser PUTs; deleted once processed (it may carry EXIF/GPS). */
  original: string;
  /** 256 px WebP; stored in `profiles.avatar_key`. */
  large: string;
  /** 64 px WebP; derived from the large key. */
  small: string;
}

/**
 * Build the keys for an avatar upload.
 *
 * @param userId - Owner (path segment; never client input).
 * @param uploadId - `avatar_uploads.id`.
 * @param mimeType - Declared type (decides the original's extension).
 */
export function avatarKeys(userId: string, uploadId: string, mimeType: AvatarMimeType): AvatarKeys {
  const base = `avatars/${userId}/${uploadId}`;
  return {
    original: `${base}.${EXTENSION_BY_MIME[mimeType]}`,
    large: `${base}-${AvatarSize.Large}.webp`,
    small: `${base}-${AvatarSize.Small}.webp`
  };
}

/**
 * The derivative keys behind a stored `avatar_key`, or `null` when the value
 * is not one this module wrote (e.g. a legacy `photo_url` value). Callers
 * must never presign or delete a key that fails this check.
 *
 * @param avatarKey - `profiles.avatar_key`.
 */
export function derivativeKeysFor(avatarKey: string | null): Pick<AvatarKeys, "large" | "small"> | null {
  if (avatarKey === null) return null;
  const match = AVATAR_KEY_PATTERN.exec(avatarKey);
  if (match === null) return null;
  return {
    large: avatarKey,
    small: avatarKey.replace(`-${AvatarSize.Large}.webp`, `-${AvatarSize.Small}.webp`)
  };
}

/** Re-exported from the media module (single implementation; drops parameters, lowercases). */
export { normalizeContentType };

/**
 * Detect which avatar type the leading bytes belong to (media module's
 * sniffer, restricted to the avatar image types).
 *
 * @param bytes - Leading bytes of a file.
 * @returns The sniffed type, or `null` when it is not an accepted avatar image.
 */
export function sniffAvatarType(bytes: Uint8Array): AvatarMimeType | null {
  const sniffed = sniffMediaType(bytes);
  return sniffed !== null && isAvatarMimeType(sniffed) ? sniffed : null;
}

/**
 * True when the leading bytes are exactly the declared image type
 * (JPEG `FF D8 FF`, PNG signature, WebP `RIFF????WEBP`), via the media module.
 *
 * @param declared - MIME type from the upload intent.
 * @param bytes - At least the first 12 bytes of the object.
 */
export function avatarSignatureMatches(declared: AvatarMimeType, bytes: Uint8Array): boolean {
  return signatureMatches(declared, bytes);
}

function isAvatarMimeType(value: string): value is AvatarMimeType {
  return value in EXTENSION_BY_MIME;
}

/** Why processing refused an image (logged and audited as a code, never the raw error). */
export const AvatarProcessingFailure = {
  PixelLimitExceeded: "pixel_limit_exceeded",
  FormatMismatch: "format_mismatch",
  DecodeFailed: "decode_failed"
} as const;
export type AvatarProcessingFailure = (typeof AvatarProcessingFailure)[keyof typeof AvatarProcessingFailure];

/** Processed avatar derivatives (WebP, no metadata). */
export interface ProcessedAvatar {
  large: Buffer;
  small: Buffer;
}

/** Result of {@link processAvatar}. */
export type AvatarProcessingResult =
  | { ok: true; avatar: ProcessedAvatar }
  | { ok: false; failure: AvatarProcessingFailure };

/** What {@link processSquareImage} renders. */
export interface SquareImageOptions {
  /**
   * Square sides to encode (px), **largest first**: the upload is decoded
   * once into a raw square of `sizes[0]`, and every size is encoded from it.
   */
  sizes: readonly [number, ...number[]];
  /**
   * Optional crop in source pixels after EXIF rotation. It is clamped with
   * `clampCropRect` against the oriented dimensions before `extract()`, so
   * an oversized or out-of-bounds rect never reaches sharp unclamped. Without
   * it the image is centre-cropped to a square.
   */
  crop?: ImageCropRect;
}

/** Result of {@link processSquareImage}: one WebP per requested size, in order. */
export type SquareImageResult = { ok: true; images: Buffer[] } | { ok: false; failure: AvatarProcessingFailure };

function sharpInput(input: Uint8Array): ReturnType<typeof sharp> {
  return sharp(input, {
    limitInputPixels: AVATAR_MAX_INPUT_PIXELS,
    failOn: "error"
  });
}

function isPixelLimitError(error: unknown): boolean {
  return error instanceof Error && /pixel limit/i.test(error.message);
}

/**
 * Process-wide cap on concurrent avatar and tree-photo decodes (see
 * {@link AVATAR_PROCESSING_CONCURRENCY}). Exported for tests.
 */
export const avatarProcessingSlots = new Semaphore(AVATAR_PROCESSING_CONCURRENCY);

/**
 * Decode, auto-rotate (EXIF orientation), crop to a square (the clamped
 * `crop`, else the centre) and encode each size as WebP. sharp writes **no
 * metadata** unless asked, so EXIF (incl. GPS), XMP, IPTC, ICC and
 * orientation tags are all dropped. Only the first frame of an animated
 * image is used.
 *
 * Shared by avatars (256/64) and tree photos (512/256/64, WP-4.3). The upload
 * is **decoded once** and runs under the shared semaphore, so a burst of
 * confirms cannot pin every libuv thread.
 *
 * @param input - The whole uploaded file.
 * @param declared - The type the magic bytes already matched.
 * @param options - Sizes and optional crop.
 */
export async function processSquareImage(
  input: Uint8Array,
  declared: AvatarMimeType,
  options: SquareImageOptions
): Promise<SquareImageResult> {
  return avatarProcessingSlots.run(() => processSquareImageNow(input, declared, options));
}

/**
 * Oriented (post-`rotate()`) dimensions from the header, refusing anything
 * above the pixel cap before a decode is attempted.
 */
function orientedSize(metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>): { width: number; height: number } | null {
  const width = metadata.autoOrient?.width ?? metadata.width;
  const height = metadata.autoOrient?.height ?? metadata.height;
  if (width === undefined || height === undefined || width < 1 || height < 1) return null;
  return { width, height };
}

async function processSquareImageNow(
  input: Uint8Array,
  declared: AvatarMimeType,
  options: SquareImageOptions
): Promise<SquareImageResult> {
  const [primary, ...rest] = options.sizes;
  try {
    // Header only (no pixel decode): format and size checks before the expensive step.
    const metadata = await sharpInput(input).metadata();
    if (metadata.format !== SHARP_FORMAT_BY_MIME[declared]) {
      return { ok: false, failure: AvatarProcessingFailure.FormatMismatch };
    }
    const size = orientedSize(metadata);
    if (size === null) return { ok: false, failure: AvatarProcessingFailure.DecodeFailed };
    if (size.width * size.height > AVATAR_MAX_INPUT_PIXELS) {
      return { ok: false, failure: AvatarProcessingFailure.PixelLimitExceeded };
    }
    // `.rotate()` first: the crop rect is in oriented pixels (sharp extracts after auto-orient).
    let pipeline = sharpInput(input).rotate();
    if (options.crop !== undefined) pipeline = pipeline.extract(clampCropRect(options.crop, size.width, size.height));
    const square = await pipeline
      .resize(primary, primary, { fit: "cover", position: "centre" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const fromSquare = (): ReturnType<typeof sharp> =>
      sharp(square.data, {
        raw: { width: square.info.width, height: square.info.height, channels: square.info.channels }
      });
    const images = await Promise.all([
      fromSquare().webp({ quality: AVATAR_WEBP_QUALITY }).toBuffer(),
      ...rest.map((side) =>
        fromSquare()
          .resize(side, side, { fit: "cover", position: "centre" })
          .webp({ quality: AVATAR_WEBP_QUALITY })
          .toBuffer()
      )
    ]);
    return { ok: true, images };
  } catch (error) {
    return {
      ok: false,
      failure: isPixelLimitError(error)
        ? AvatarProcessingFailure.PixelLimitExceeded
        : AvatarProcessingFailure.DecodeFailed
    };
  }
}

/**
 * Process an avatar: {@link processSquareImage} at 256 and 64 px, with an
 * optional crop rect (clamped server-side).
 *
 * @param input - The whole uploaded file.
 * @param declared - The type the magic bytes already matched.
 * @param crop - Optional crop in oriented source pixels.
 */
export async function processAvatar(
  input: Uint8Array,
  declared: AvatarMimeType,
  crop?: ImageCropRect
): Promise<AvatarProcessingResult> {
  const result = await processSquareImage(input, declared, {
    sizes: [AvatarSize.Large, AvatarSize.Small],
    ...(crop === undefined ? {} : { crop })
  });
  if (!result.ok) return result;
  const [large, small] = result.images;
  if (large === undefined || small === undefined) return { ok: false, failure: AvatarProcessingFailure.DecodeFailed };
  return { ok: true, avatar: { large, small } };
}

/** What {@link avatarUrlFor} needs from the app. */
export interface AvatarUrlDeps {
  storage: Pick<StorageService, "presignGet">;
  log: Pick<FastifyBaseLogger, "warn">;
}

/**
 * Presigned GET (1 h) for a member's avatar, or `null` when they have none.
 *
 * Use this everywhere an avatar is shown (directory, RSVP attendees, family
 * tree, chat).
 *
 * **Security: callers must check visibility first.** This function does no
 * authorization: whoever receives the URL can fetch the image for an hour.
 * Only call it for a member the viewer may see (e.g. not for an unlisted
 * member in an attendee list shown to others, nor for a disabled account),
 * and never presign a key taken from client input. It refuses keys this module did not write (`null`), and a
 * storage failure degrades to `null` (logged without the key) rather than
 * failing the whole response.
 *
 * @param app - The Fastify instance (`storage`, `log`).
 * @param avatarKey - `profiles.avatar_key`.
 * @param size - 256 (default) or 64 px.
 */
export async function avatarUrlFor(
  app: AvatarUrlDeps,
  avatarKey: string | null,
  size: AvatarSize = AvatarSize.Large
): Promise<string | null> {
  const keys = derivativeKeysFor(avatarKey);
  if (keys === null) return null;
  try {
    const signed = await app.storage.presignGet({
      key: size === AvatarSize.Small ? keys.small : keys.large,
      expiresInSeconds: AVATAR_URL_TTL_SECONDS
    });
    return signed.url;
  } catch (error) {
    app.log.warn({ errorName: errorName(error) }, "avatar presign failed");
    return null;
  }
}
