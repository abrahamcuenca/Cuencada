/**
 * Direct browser → bucket upload with progress (XHR: `fetch` has no upload
 * progress events in Safari). [SEC]
 * - Only the headers the server signed are sent; forbidden headers such as
 *   `Content-Length` (the browser sets it from the body) are skipped.
 * - No cookies and no `Authorization`: the bearer token never goes to the bucket.
 * - Errors carry a status and a Spanish message, never the presigned URL.
 */

/** Header names a page may not set (Fetch spec "forbidden request headers"), lower-case. */
const FORBIDDEN_HEADERS = new Set([
  "accept-charset",
  "accept-encoding",
  "access-control-request-headers",
  "access-control-request-method",
  "connection",
  "content-length",
  "cookie",
  "cookie2",
  "date",
  "dnt",
  "expect",
  "host",
  "keep-alive",
  "origin",
  "referer",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
  "authorization"
]);

/** Why a direct upload failed. */
export type TransferFailure = "aborted" | "network" | "expired" | "rejected" | "unavailable";

const MESSAGES: Record<TransferFailure, string> = {
  aborted: "Subida cancelada.",
  network: "Se perdió la conexión mientras se subía. Inténtalo otra vez.",
  expired: "El permiso de subida venció. Inténtalo otra vez.",
  rejected: "El almacenamiento rechazó el archivo. Inténtalo otra vez.",
  unavailable: "El almacenamiento no respondió. Inténtalo en un momento."
};

/** Failure of {@link putToPresignedUrl}. `message` is user-safe Spanish and never contains the URL. */
export class UploadTransferError extends Error {
  readonly failure: TransferFailure;
  readonly status: number | null;

  constructor(failure: TransferFailure, status: number | null) {
    super(MESSAGES[failure]);
    this.name = failure === "aborted" ? "AbortError" : "UploadTransferError";
    this.failure = failure;
    this.status = status;
  }
}

/** Options for {@link putToPresignedUrl}. */
export interface PutOptions {
  url: string;
  /** The intent's signed headers (`CreateUploadResponse.headers`). */
  headers: Readonly<Record<string, string>>;
  body: Blob;
  signal: AbortSignal;
  /** Fraction uploaded, 0..1. */
  onProgress: (fraction: number) => void;
}

/**
 * Headers from the intent that the browser is allowed to send.
 *
 * @param headers - The signed headers.
 * @returns The entries to pass to `setRequestHeader`.
 */
export function sendableHeaders(headers: Readonly<Record<string, string>>): [string, string][] {
  return Object.entries(headers).filter(([name]) => {
    const lower = name.toLowerCase();
    return !FORBIDDEN_HEADERS.has(lower) && !lower.startsWith("proxy-") && !lower.startsWith("sec-");
  });
}

function failureForStatus(status: number): TransferFailure {
  if (status === 403) return "expired";
  if (status >= 500 || status === 429) return "unavailable";
  return "rejected";
}

/**
 * PUTs a file to a presigned URL.
 *
 * @param options - URL, signed headers, body, abort signal and progress callback.
 * @returns Resolves on a 2xx.
 * @throws {UploadTransferError} On abort, network error or a non-2xx status.
 */
export function putToPresignedUrl({ url, headers, body, signal, onProgress }: PutOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new UploadTransferError("aborted", null));
      return;
    }
    const xhr = new XMLHttpRequest();
    const onAbort = (): void => xhr.abort();
    const done = (): void => signal.removeEventListener("abort", onAbort);

    xhr.open("PUT", url, true);
    xhr.withCredentials = false;
    for (const [name, value] of sendableHeaders(headers)) xhr.setRequestHeader(name, value);

    xhr.upload.onprogress = (event: ProgressEvent): void => {
      if (event.lengthComputable && event.total > 0) onProgress(Math.min(1, event.loaded / event.total));
    };
    xhr.onload = (): void => {
      done();
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(1);
        resolve();
      } else {
        reject(new UploadTransferError(failureForStatus(xhr.status), xhr.status));
      }
    };
    xhr.onerror = (): void => {
      done();
      reject(new UploadTransferError("network", null));
    };
    xhr.ontimeout = xhr.onerror;
    xhr.onabort = (): void => {
      done();
      reject(new UploadTransferError("aborted", null));
    };

    signal.addEventListener("abort", onAbort, { once: true });
    xhr.send(body);
  });
}
