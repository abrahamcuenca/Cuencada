/**
 * Decode → downscale → re-encode, shared by the resize worker and the
 * main-thread fallback (see `resizeImage.ts`). No React, no store.
 */
import { drawSquareCrop, type SquareCropSpec } from "./cropCore";
import type { ImageSize } from "./imageSize";

/** When and how much to shrink. */
export type ResizePolicy =
  /** Gallery: only above `triggerPixels` (width × height), down to about `targetPixels`, aspect kept. */
  | { kind: "maxPixels"; triggerPixels: number; targetPixels: number }
  /** Avatar: long edge at most `maxEdge` px. */
  | { kind: "maxEdge"; maxEdge: number };

/** Output format. JPEG decodes everywhere and the server re-encodes anyway. */
export interface EncodeOptions {
  type: "image/jpeg";
  quality: number;
}

/** The file could not be decoded as an image (corrupt, or a format this browser can't read). */
export class ImageDecodeError extends Error {
  constructor() {
    super("No pudimos leer esta foto. Prueba con otra o guárdala de nuevo como JPG.");
    this.name = "ImageDecodeError";
  }
}

/**
 * @param size - The image's pixel size.
 * @param policy - The resize rule.
 * @returns The size to scale to, or `null` when the image may go as is.
 */
export function targetSize(size: ImageSize, policy: ResizePolicy): ImageSize | null {
  const { width, height } = size;
  if (policy.kind === "maxPixels") {
    if (width * height <= policy.triggerPixels) return null;
    const scale = Math.sqrt(policy.targetPixels / (width * height));
    return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
  }
  const longEdge = Math.max(width, height);
  if (longEdge <= policy.maxEdge) return null;
  const scale = policy.maxEdge / longEdge;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

type Canvas2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

/** An OffscreenCanvas where available (workers, modern browsers), else a detached `<canvas>`. */
function makeCanvas(size: ImageSize): { context: Canvas2D; encode: (options: EncodeOptions) => Promise<Blob>; free: () => void } {
  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(size.width, size.height);
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("2D canvas unavailable");
    return {
      context,
      encode: (options) => canvas.convertToBlob(options),
      free: () => {
        canvas.width = 0;
        canvas.height = 0;
      }
    };
  }
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("2D canvas unavailable");
  return {
    context,
    encode: (options) =>
      new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => (blob === null ? reject(new Error("encode failed")) : resolve(blob)), options.type, options.quality);
      }),
    free: () => {
      canvas.width = 0;
      canvas.height = 0;
    }
  };
}

/**
 * The canvas size for a decoded image the policy already decided to shrink:
 * the policy's cap without the trigger (a bitmap the decoder already reduced is
 * still drawn, never "kept as is").
 */
function fitSize(size: ImageSize, policy: ResizePolicy): ImageSize {
  const { width, height } = size;
  const scale =
    policy.kind === "maxPixels"
      ? Math.min(1, Math.sqrt(policy.targetPixels / (width * height)))
      : Math.min(1, policy.maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

/**
 * Decodes with EXIF orientation applied. When the target is known (from the
 * header), asks the decoder for that width directly (`resizeWidth`, aspect
 * kept), so a 200 MP photo never sits in memory at full size. Decoders that
 * refuse the resize options get a plain decode.
 */
export async function decode(blob: Blob, target: ImageSize | null): Promise<ImageBitmap> {
  if (target !== null) {
    try {
      return await createImageBitmap(blob, { imageOrientation: "from-image", resizeWidth: target.width, resizeQuality: "high" });
    } catch {
      // Older WebKit: no resize options; fall through to a full decode.
    }
  }
  return createImageBitmap(blob, { imageOrientation: "from-image" });
}

/** Long edge the crop job decodes at most (memory bound; the output is 1024 px). */
export const CROP_DECODE_MAX_EDGE = 4096;

/**
 * Decodes `blob` (EXIF orientation applied, at most
 * {@link CROP_DECODE_MAX_EDGE} on the long edge when the header size is
 * known), then draws the rotated square crop onto an `output × output`
 * canvas and encodes it. Re-encoding drops every metadata block (EXIF/GPS).
 * The bitmap and canvas are freed before returning.
 *
 * @param blob - The picked image.
 * @param spec - Rotation and crop, in fractions of the rotated image.
 * @param output - Output side (px).
 * @param encode - Output format.
 * @param stored - Size read from the header, when known.
 * @throws {ImageDecodeError} When the image can't be decoded; other errors for canvas or encode failures.
 */
export async function decodeAndCrop(
  blob: Blob,
  spec: SquareCropSpec,
  output: number,
  encode: EncodeOptions,
  stored: ImageSize | null = null
): Promise<Blob> {
  const planned = stored === null ? null : targetSize(stored, { kind: "maxEdge", maxEdge: CROP_DECODE_MAX_EDGE });
  let bitmap: ImageBitmap;
  try {
    bitmap = await decode(blob, planned);
  } catch {
    throw new ImageDecodeError();
  }
  try {
    const canvas = makeCanvas({ width: output, height: output });
    try {
      drawSquareCrop(canvas.context, bitmap, { width: bitmap.width, height: bitmap.height }, spec, output);
      return await canvas.encode(encode);
    } finally {
      canvas.free();
    }
  } finally {
    bitmap.close();
  }
}

/**
 * Decodes `blob` (EXIF orientation applied), and when the policy asks for it,
 * draws it smaller and re-encodes it. Re-encoding drops every metadata block
 * (EXIF/GPS) as a side effect. The bitmap and canvas are freed before returning.
 *
 * @param blob - The picked image.
 * @param policy - When/how much to shrink.
 * @param encode - Output format.
 * @param stored - Size read from the header, when known (lets the decoder downscale directly).
 * @returns The smaller image, or `null` when the original may go as is.
 * @throws {ImageDecodeError} When the image can't be decoded; other errors for canvas or encode failures.
 */
export async function decodeAndScale(blob: Blob, policy: ResizePolicy, encode: EncodeOptions, stored: ImageSize | null = null): Promise<Blob | null> {
  const planned = stored === null ? null : targetSize(stored, policy);
  if (stored !== null && planned === null) return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await decode(blob, planned);
  } catch {
    throw new ImageDecodeError();
  }
  try {
    const decoded = { width: bitmap.width, height: bitmap.height };
    // Unknown header: decide from the decoded size.
    if (planned === null && targetSize(decoded, policy) === null) return null;
    const size = fitSize(decoded, policy);
    const canvas = makeCanvas(size);
    try {
      canvas.context.imageSmoothingEnabled = true;
      canvas.context.imageSmoothingQuality = "high";
      canvas.context.drawImage(bitmap, 0, 0, size.width, size.height);
      return await canvas.encode(encode);
    } finally {
      canvas.free();
    }
  } finally {
    bitmap.close();
  }
}
