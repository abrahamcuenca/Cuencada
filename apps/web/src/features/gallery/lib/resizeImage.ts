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
import { decodeAndScale, type EncodeOptions, ImageDecodeError, type ResizePolicy, targetSize } from "./resizeCore";
import type { ResizeWorkerRequest, ResizeWorkerResponse } from "./resize.worker";

export { ImageDecodeError } from "./resizeCore";

/** Gallery photos above this many pixels are downscaled… */
export const GALLERY_RESIZE_TRIGGER_PIXELS = 40_000_000;
/** …to about this many (server cap: 50 MP). */
export const GALLERY_RESIZE_TARGET_PIXELS = 24_000_000;
/** Avatars: long edge at most this many pixels (server cap: 24 MP). */
export const AVATAR_MAX_EDGE = 2048;

/** Gallery policy and format. */
export const GALLERY_RESIZE: { policy: ResizePolicy; encode: EncodeOptions } = {
  policy: { kind: "maxPixels", triggerPixels: GALLERY_RESIZE_TRIGGER_PIXELS, targetPixels: GALLERY_RESIZE_TARGET_PIXELS },
  encode: { type: "image/jpeg", quality: 0.92 }
};

/** Avatar policy and format. */
export const AVATAR_RESIZE: { policy: ResizePolicy; encode: EncodeOptions } = {
  policy: { kind: "maxEdge", maxEdge: AVATAR_MAX_EDGE },
  encode: { type: "image/jpeg", quality: 0.9 }
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
 *   (within limits, or this browser can't decode images off the DOM).
 * @throws {ImageDecodeError} When the image needs shrinking but can't be decoded.
 */
export async function shrinkImageIfNeeded(file: File, options: { policy: ResizePolicy; encode: EncodeOptions }): Promise<File | null> {
  const known = await headerSize(file);
  if (known !== null && targetSize(known, options.policy) === null) return null;
  if (typeof createImageBitmap !== "function") return null;

  const blob = await oneAtATime(async () => {
    const request: ResizeWorkerRequest = { blob: file, policy: options.policy, encode: options.encode };
    if (canUseWorker()) {
      try {
        return await inWorker(request);
      } catch {
        // Older WebViews lack createImageBitmap/OffscreenCanvas inside workers: do it here instead.
      }
    }
    return decodeAndScale(file, options.policy, options.encode);
  });
  if (blob === null) return null;
  return new File([blob], renamed(file.name, options.encode.type), { type: options.encode.type, lastModified: file.lastModified });
}
