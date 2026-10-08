/**
 * Off-main-thread image downscale and square crop (see `resizeImage.ts`).
 * One request per worker: the page creates it, posts one job, reads one
 * answer and terminates it, so the decoded bitmap's memory goes away with
 * the worker. Same-origin module worker (`worker-src 'self'`).
 */
import type { SquareCropSpec } from "./cropCore";
import type { ImageSize } from "./imageSize";
import { decodeAndCrop, decodeAndScale, type EncodeOptions, ImageDecodeError, type ResizePolicy } from "./resizeCore";

/** Downscale job (gallery and avatar uploads). */
export interface ResizeScaleRequest {
  kind?: "scale";
  blob: Blob;
  policy: ResizePolicy;
  encode: EncodeOptions;
  /** Size from the header, when known. */
  stored: ImageSize | null;
}

/** Square crop job (WP-4.3 `ImageCropper`). */
export interface ResizeCropRequest {
  kind: "crop";
  blob: Blob;
  crop: SquareCropSpec;
  /** Output side (px). */
  output: number;
  encode: EncodeOptions;
  stored: ImageSize | null;
}

/** Message the page sends. */
export type ResizeWorkerRequest = ResizeScaleRequest | ResizeCropRequest;

/** Message the worker answers with. */
export type ResizeWorkerResponse = { ok: true; blob: Blob | null } | { ok: false; decodeError: boolean };

/** Runs one job (exported for tests). */
export function runResizeJob(request: ResizeWorkerRequest): Promise<Blob | null> {
  if (request.kind === "crop") return decodeAndCrop(request.blob, request.crop, request.output, request.encode, request.stored);
  return decodeAndScale(request.blob, request.policy, request.encode, request.stored);
}

self.addEventListener("message", (event: MessageEvent<ResizeWorkerRequest>) => {
  runResizeJob(event.data).then(
    (result) => self.postMessage({ ok: true, blob: result } satisfies ResizeWorkerResponse),
    (error: unknown) => self.postMessage({ ok: false, decodeError: error instanceof ImageDecodeError } satisfies ResizeWorkerResponse)
  );
});
