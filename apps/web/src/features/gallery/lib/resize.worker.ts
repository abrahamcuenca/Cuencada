/**
 * Off-main-thread image downscale (see `resizeImage.ts`). One request per
 * worker: the page creates it, posts one job, reads one answer and
 * terminates it, so the decoded bitmap's memory goes away with the worker.
 */
import type { ImageSize } from "./imageSize";
import { decodeAndScale, type EncodeOptions, ImageDecodeError, type ResizePolicy } from "./resizeCore";

/** Message the page sends. */
export interface ResizeWorkerRequest {
  blob: Blob;
  policy: ResizePolicy;
  encode: EncodeOptions;
  /** Size from the header, when known. */
  stored: ImageSize | null;
}

/** Message the worker answers with. */
export type ResizeWorkerResponse = { ok: true; blob: Blob | null } | { ok: false; decodeError: boolean };

self.addEventListener("message", (event: MessageEvent<ResizeWorkerRequest>) => {
  const { blob, policy, encode, stored } = event.data;
  decodeAndScale(blob, policy, encode, stored).then(
    (result) => self.postMessage({ ok: true, blob: result } satisfies ResizeWorkerResponse),
    (error: unknown) => self.postMessage({ ok: false, decodeError: error instanceof ImageDecodeError } satisfies ResizeWorkerResponse)
  );
});
