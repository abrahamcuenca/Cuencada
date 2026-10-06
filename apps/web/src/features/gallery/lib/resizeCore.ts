/**
 * Decode → downscale → re-encode, shared by the resize worker and the
 * main-thread fallback (see `resizeImage.ts`). No React, no store.
 */
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
 * Decodes `blob` (EXIF orientation applied), and when the policy asks for it,
 * draws it smaller and re-encodes it. Re-encoding drops every metadata block
 * (EXIF/GPS) as a side effect. The bitmap and canvas are freed before returning.
 *
 * @param blob - The picked image.
 * @param policy - When/how much to shrink.
 * @param encode - Output format.
 * @returns The smaller image, or `null` when the original may go as is.
 * @throws {ImageDecodeError} When the image can't be decoded.
 */
export async function decodeAndScale(blob: Blob, policy: ResizePolicy, encode: EncodeOptions): Promise<Blob | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
  } catch {
    throw new ImageDecodeError();
  }
  try {
    const size = targetSize({ width: bitmap.width, height: bitmap.height }, policy);
    if (size === null) return null;
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
