/**
 * Off-main-thread image downscale (see `resizeImage.ts`). One request per
 * worker: the page creates it, posts one job, reads one answer and
 * terminates it, so the decoded bitmap's memory goes away with the worker.
 */
import { decodeAndScale, type EncodeOptions, ImageDecodeError, type ResizePolicy } from "./resizeCore";

/** Message the page sends. */
export interface ResizeWorkerRequest {
  blob: Blob;
  policy: ResizePolicy;
  encode: EncodeOptions;
}

/** Message the worker answers with. */
export type ResizeWorkerResponse = { ok: true; blob: Blob | null } | { ok: false; decodeError: boolean };

self.addEventListener("message", (event: MessageEvent<ResizeWorkerRequest>) => {
  const { blob, policy, encode } = event.data;
  decodeAndScale(blob, policy, encode).then(
    (result) => self.postMessage({ ok: true, blob: result } satisfies ResizeWorkerResponse),
    (error: unknown) => self.postMessage({ ok: false, decodeError: error instanceof ImageDecodeError } satisfies ResizeWorkerResponse)
  );
});
