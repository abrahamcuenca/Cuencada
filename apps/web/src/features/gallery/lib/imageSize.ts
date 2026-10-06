/**
 * Pixel size of a JPEG, PNG or WebP read from its header bytes, without
 * decoding the image. Used to decide cheaply whether a photo must be
 * downscaled before upload (decoding a 100 MP photo just to measure it would
 * cost hundreds of MB on a phone). Dimensions are as stored (EXIF rotation
 * doesn't change the pixel count).
 */

/** Width and height in pixels. */
export interface ImageSize {
  width: number;
  height: number;
}

/** How many leading bytes {@link readImageSize} needs at most (JPEG EXIF can push SOF past 64 KB). */
export const IMAGE_HEADER_BYTES = 512 * 1024;

function u16be(b: Uint8Array, i: number): number {
  return ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
}

function u32be(b: Uint8Array, i: number): number {
  return (((b[i] ?? 0) << 24) >>> 0) + (((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0));
}

function u24le(b: Uint8Array, i: number): number {
  return (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16);
}

function ascii(b: Uint8Array, i: number, length: number): string {
  return String.fromCharCode(...b.subarray(i, i + length));
}

function valid(size: ImageSize): ImageSize | null {
  return size.width > 0 && size.height > 0 ? size : null;
}

function pngSize(b: Uint8Array): ImageSize | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 24 || !signature.every((byte, i) => b[i] === byte) || ascii(b, 12, 4) !== "IHDR") return null;
  return valid({ width: u32be(b, 16), height: u32be(b, 20) });
}

/** SOFn markers that carry the frame size (not DHT C4, JPG C8, DAC CC). */
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function jpegSize(b: Uint8Array): ImageSize | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1] ?? 0;
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2; // standalone markers carry no length
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end of image / start of scan before any SOF
    const length = u16be(b, i + 2);
    if (length < 2) return null;
    if (isStartOfFrame(marker)) {
      if (i + 8 >= b.length) return null;
      return valid({ height: u16be(b, i + 5), width: u16be(b, i + 7) });
    }
    i += 2 + length;
  }
  return null;
}

function webpSize(b: Uint8Array): ImageSize | null {
  if (b.length < 30 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") return null;
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8 ") {
    return valid({ width: (((b[27] ?? 0) << 8) | (b[26] ?? 0)) & 0x3fff, height: (((b[29] ?? 0) << 8) | (b[28] ?? 0)) & 0x3fff });
  }
  if (chunk === "VP8L") {
    const b0 = b[21] ?? 0;
    const b1 = b[22] ?? 0;
    const b2 = b[23] ?? 0;
    const b3 = b[24] ?? 0;
    return valid({ width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) });
  }
  if (chunk === "VP8X") return valid({ width: 1 + u24le(b, 24), height: 1 + u24le(b, 27) });
  return null;
}

/**
 * @param bytes - The first bytes of the file (up to {@link IMAGE_HEADER_BYTES}).
 * @returns The stored pixel size, or `null` when the header isn't recognised.
 */
export function readImageSize(bytes: Uint8Array): ImageSize | null {
  return pngSize(bytes) ?? jpegSize(bytes) ?? webpSize(bytes);
}
