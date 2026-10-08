/**
 * Client-side downscale of very large photos before upload. Phones save
 * 48–200 MP photos, but the server caps decoded images (50 MP gallery,
 * 24 MP avatars), so those would be refused after a long upload.
 *
 * - The size is read from the header first (no decode); an image within
 *   the limits is uploaded untouched, byte for byte.
 * - Otherwise it is decoded (`createImageBitmap`, EXIF orientation applied),
 *   drawn smaller and re-encoded as JPEG, off the main thread in a worker
 *   with an OffscreenCanvas when the browser supports it, else on the main
 *   thread. Re-encoding also strips EXIF/GPS (the server strips it anyway).
 * - One image at a time, so a batch of huge photos never holds several
 *   decoded bitmaps in memory at once.
 */
import { IMAGE_HEADER_BYTES, readImageSize } from "./imageSize";
import type { SquareCropSpec } from "./cropCore";
import { decode, decodeAndCrop, decodeAndScale, type EncodeOptions, ImageDecodeError, type ResizePolicy, targetSize } from "./resizeCore";
import type { ResizeCropRequest, ResizeScaleRequest, ResizeWorkerRequest, ResizeWorkerResponse } from "./resize.worker";

export { ImageDecodeError } from "./resizeCore";

/** Gallery photos above this many pixels are downscaled… */
export const GALLERY_RESIZE_TRIGGER_PIXELS = 40_000_000;
/**
 * …to at most this many. iOS WebKit refuses canvases above 16,777,216 px, so
 * the target stays under that on every device (server cap: 50 MP).
 */
export const GALLERY_RESIZE_TARGET_PIXELS = 16_000_000;
/** Server cap for decoded gallery photos. */
export const GALLERY_SERVER_MAX_PIXELS = 50_000_000;
/** Avatars: long edge at most this many pixels (server cap: 24 MP). */
export const AVATAR_MAX_EDGE = 2048;
/** Server cap for decoded avatars. */
export const AVATAR_SERVER_MAX_PIXELS = 24_000_000;

/** What to shrink, how to encode it, and what the server accepts as is. */
export interface ResizeOptions {
  policy: ResizePolicy;
  encode: EncodeOptions;
  /** Above this, the original would be refused too, so a failed resize is an error. */
  serverMaxPixels: number;
}

/** Gallery policy and format. */
export const GALLERY_RESIZE: ResizeOptions = {
  policy: { kind: "maxPixels", triggerPixels: GALLERY_RESIZE_TRIGGER_PIXELS, targetPixels: GALLERY_RESIZE_TARGET_PIXELS },
  encode: { type: "image/jpeg", quality: 0.92 },
  serverMaxPixels: GALLERY_SERVER_MAX_PIXELS
};

/** Avatar policy and format. */
export const AVATAR_RESIZE: ResizeOptions = {
  policy: { kind: "maxEdge", maxEdge: AVATAR_MAX_EDGE },
  encode: { type: "image/jpeg", quality: 0.9 },
  serverMaxPixels: AVATAR_SERVER_MAX_PIXELS
};

/** Subtle note under the gallery upload rules. */
export const LARGE_PHOTO_NOTE = "Reducimos fotos muy grandes para subirlas más rápido.";

let queue: Promise<unknown> = Promise.resolve();

/** Runs `task` after every earlier resize has settled (one decoded image in memory at a time). */
function oneAtATime<TResult>(task: () => Promise<TResult>): Promise<TResult> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

async function headerSize(file: Blob): Promise<ReturnType<typeof readImageSize>> {
  try {
    return readImageSize(new Uint8Array(await file.slice(0, IMAGE_HEADER_BYTES).arrayBuffer()));
  } catch {
    return null;
  }
}

function canUseWorker(): boolean {
  return typeof Worker === "function" && typeof OffscreenCanvas === "function";
}

/** Runs the decode/scale in a one-shot worker; rejects (for the main-thread fallback) on any worker problem. */
function inWorker(request: ResizeWorkerRequest): Promise<Blob | null> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./resize.worker.ts", import.meta.url), { type: "module" });
    const done = (): void => worker.terminate();
    worker.addEventListener("message", (event: MessageEvent<ResizeWorkerResponse>) => {
      done();
      if (event.data.ok) resolve(event.data.blob);
      else reject(event.data.decodeError ? new ImageDecodeError() : new Error("worker failed"));
    });
    worker.addEventListener("error", () => {
      done();
      reject(new Error("worker failed"));
    });
    worker.postMessage(request);
  });
}

function renamed(name: string, type: string): string {
  const extension = type === "image/jpeg" ? "jpg" : (type.split("/")[1] ?? "img");
  const dot = name.lastIndexOf(".");
  return `${dot > 0 ? name.slice(0, dot) : name}.${extension}`;
}

/**
 * Shrinks `file` when it is above the policy's limit.
 *
 * @param file - A picked JPEG/PNG/WebP.
 * @param options - {@link GALLERY_RESIZE} or {@link AVATAR_RESIZE}.
 * @returns A new, smaller JPEG `File`, or `null` when the original should be uploaded as is
 *   (within limits, or the resize failed but the server would take the original).
 * @throws {ImageDecodeError} When the resize failed and the original would be refused too
 *   (above `serverMaxPixels`), or the file can't be decoded and its size is unknown.
 */
export async function shrinkImageIfNeeded(file: File, options: ResizeOptions): Promise<File | null> {
  const known = await headerSize(file);
  if (known !== null && targetSize(known, options.policy) === null) return null;
  /** Best effort: the original goes as is when the server would take it, else a clear error. */
  const originalOrRefuse = (): null => {
    if (known !== null && known.width * known.height > options.serverMaxPixels) throw new ImageDecodeError();
    return null;
  };
  if (typeof createImageBitmap !== "function") return originalOrRefuse();

  let blob: Blob | null;
  try {
    blob = await oneAtATime(async () => {
      const request: ResizeScaleRequest = { blob: file, policy: options.policy, encode: options.encode, stored: known };
      if (canUseWorker()) {
        try {
          return await inWorker(request);
        } catch {
          // Older WebViews lack createImageBitmap/OffscreenCanvas inside workers: do it here instead.
        }
      }
      return decodeAndScale(file, options.policy, options.encode, known);
    });
  } catch (error) {
    // A canvas the browser refuses (iOS caps canvas area), an encode failure, low memory…:
    // never worse than before the downscale existed.
    if (known !== null) return originalOrRefuse();
    // Unknown size: only an undecodable file is an error; the server judges the rest.
    if (error instanceof ImageDecodeError) throw error;
    return null;
  }
  if (blob === null) return null;
  return new File([blob], renamed(file.name, options.encode.type), { type: options.encode.type, lastModified: file.lastModified });
}

/**
 * Decodes `file` for an on-screen preview (EXIF orientation applied), at most
 * `maxEdge` on the long edge when the header size is known, so a 200 MP photo
 * never sits in memory at full size.
 *
 * @param file - The picked image.
 * @param maxEdge - Longest preview edge (px).
 * @throws {ImageDecodeError} When the browser can't decode it (or lacks `createImageBitmap`).
 */
export async function decodeForPreview(file: Blob, maxEdge: number): Promise<ImageBitmap> {
  if (typeof createImageBitmap !== "function") throw new ImageDecodeError();
  const known = await headerSize(file);
  const planned = known === null ? null : targetSize(known, { kind: "maxEdge", maxEdge });
  try {
    return await decode(file, planned);
  } catch {
    throw new ImageDecodeError();
  }
}

/** Side of the square JPEG the `ImageCropper` produces (WP-4.3). */
export const CROP_OUTPUT_SIZE = 1024;

/** JPEG quality of the cropped photo (the server re-encodes to WebP anyway). */
export const CROP_JPEG_QUALITY = 0.9;

/**
 * Renders the cropper's result: `file` decoded (EXIF orientation applied),
 * rotated, cropped to the square in `crop` and re-encoded as a
 * {@link CROP_OUTPUT_SIZE}² JPEG without metadata. Runs in the resize worker
 * when the browser supports OffscreenCanvas there, else on the main thread.
 * One image at a time, like {@link shrinkImageIfNeeded}.
 *
 * @param file - The picked JPEG/PNG/WebP.
 * @param crop - Rotation and crop from the cropper (fractions of the rotated image).
 * @returns A new JPEG `File`.
 * @throws {ImageDecodeError} When the file can't be decoded; other errors when the canvas fails.
 */
export async function cropImageToSquare(file: File, crop: SquareCropSpec): Promise<File> {
  const known = await headerSize(file);
  const encode: EncodeOptions = { type: "image/jpeg", quality: CROP_JPEG_QUALITY };
  const blob = await oneAtATime(async () => {
    const request: ResizeCropRequest = { kind: "crop", blob: file, crop, output: CROP_OUTPUT_SIZE, encode, stored: known };
    if (canUseWorker()) {
      try {
        const result = await inWorker(request);
        if (result !== null) return result;
      } catch (error) {
        if (error instanceof ImageDecodeError) throw error;
        // No OffscreenCanvas/createImageBitmap in this worker: do it here instead.
      }
    }
    return decodeAndCrop(file, crop, CROP_OUTPUT_SIZE, encode, known);
  });
  return new File([blob], renamed(file.name, encode.type), { type: encode.type, lastModified: file.lastModified });
}
