/**
 * TEST-ONLY object storage for the e2e harness [SEC]: a `StorageService`
 * plus a tiny HTTP server on loopback that accepts the browser's presigned
 * PUTs and serves presigned GETs, so the gallery upload → processing →
 * lightbox flow runs without a real bucket or MinIO.
 *
 * It mirrors what the S3 presigner guarantees: URLs carry an HMAC over
 * method, key, expiry, content type and length; a PUT must match the signed
 * `Content-Type` and exact size; expired or tampered URLs get 403. Object
 * keys never touch the filesystem as paths (files are named by the key's
 * SHA-256), so a key cannot escape the storage directory.
 *
 * Like the mail sink it lives outside `apps/server/src` (never built or
 * deployed) and is only constructed by the e2e harness entrypoint.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:https";
import { join } from "node:path";
import type {
  ObjectHead,
  PresignedGet,
  PresignedPut,
  PresignGetInput,
  PresignPutInput,
  PutObjectInput,
  StorageService
} from "../../../apps/server/dist/lib/storage/types.js";

const DEFAULT_EXPIRY_SECONDS = 300;
/** Upper bound for one PUT body; the contract caps videos well below this. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

interface StoredMeta {
  key: string;
  contentType: string;
  contentLength: number;
  etag: string;
  lastModified: string;
  cacheControl: string | null;
}

/** Local object store reachable at `origin`, persisting under `dir`. */
export class LocalObjectStore implements StorageService {
  readonly #origin: string;
  readonly #dir: string;
  readonly #allowedOrigin: string;
  /** Per-process signing secret: URLs from an earlier run never validate. */
  readonly #secret = randomBytes(32);

  /**
   * @param options.origin - Public origin of {@link LocalObjectStore.listen}'s server, e.g. `http://127.0.0.1:3191`.
   * @param options.dir - Directory for object bodies and metadata.
   * @param options.allowedOrigin - The SPA origin allowed by CORS.
   */
  constructor(options: { origin: string; dir: string; allowedOrigin: string }) {
    this.#origin = options.origin;
    this.#dir = options.dir;
    this.#allowedOrigin = options.allowedOrigin;
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
  }

  /** Presign a PUT bound to the content type and exact length. */
  async presignPut(input: PresignPutInput): Promise<PresignedPut> {
    const expiresAt = new Date(Date.now() + (input.expiresInSeconds ?? DEFAULT_EXPIRY_SECONDS) * 1000);
    const params = new URLSearchParams({
      exp: String(expiresAt.getTime()),
      ct: input.contentType,
      len: String(input.contentLength)
    });
    params.set("sig", this.#sign("PUT", input.key, params));
    return {
      url: `${this.#origin}/${encodeKey(input.key)}?${params.toString()}`,
      method: "PUT",
      requiredHeaders: { "content-type": input.contentType },
      signed: { contentType: input.contentType, contentLength: input.contentLength },
      expiresAt
    };
  }

  /** Presign a GET. */
  async presignGet(input: PresignGetInput): Promise<PresignedGet> {
    const expiresAt = new Date(Date.now() + (input.expiresInSeconds ?? DEFAULT_EXPIRY_SECONDS) * 1000);
    const params = new URLSearchParams({ exp: String(expiresAt.getTime()) });
    if (input.responseContentDisposition !== undefined) params.set("rcd", input.responseContentDisposition);
    params.set("sig", this.#sign("GET", input.key, params));
    return { url: `${this.#origin}/${encodeKey(input.key)}?${params.toString()}`, expiresAt };
  }

  /** Metadata, or `null` when missing. */
  async head(key: string): Promise<ObjectHead | null> {
    const meta = this.#readMeta(key);
    if (meta === null) return null;
    return {
      key,
      contentLength: meta.contentLength,
      contentType: meta.contentType,
      etag: meta.etag,
      lastModified: new Date(meta.lastModified)
    };
  }

  /** Bytes `[start, endInclusive]`; throws when missing. */
  async getRange(key: string, start: number, endInclusive: number): Promise<Uint8Array> {
    if (this.#readMeta(key) === null) throw new Error("LocalObjectStore: no such object");
    if (start < 0 || endInclusive < start) throw new RangeError("LocalObjectStore: invalid range");
    return new Uint8Array(readFileSync(this.#bodyPath(key)).subarray(start, endInclusive + 1));
  }

  /** Server-side upload (derivatives, avatars). */
  async put(input: PutObjectInput): Promise<void> {
    this.#write(input.key, Buffer.from(input.body), input.contentType, input.cacheControl ?? null);
  }

  /** Delete; a missing key is not an error. */
  async delete(key: string): Promise<void> {
    rmSync(this.#bodyPath(key), { force: true });
    rmSync(this.#metaPath(key), { force: true });
  }

  /**
   * Start the HTTPS endpoint for presigned URLs on loopback.
   *
   * @param port - TCP port.
   * @param tls - PEM key and certificate (self-signed, see `tls.ts`).
   */
  listen(port: number, tls: { key: string; cert: string }): Promise<Server> {
    const server = createServer(tls, (request, response) => {
      this.#handle(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => resolve(server));
    });
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers.origin === this.#allowedOrigin) {
      response.setHeader("access-control-allow-origin", this.#allowedOrigin);
      response.setHeader("vary", "origin");
    }
    if (request.method === "OPTIONS") {
      response.setHeader("access-control-allow-methods", "GET, PUT");
      response.setHeader("access-control-allow-headers", "content-type, x-forwarded-for");
      response.setHeader("access-control-max-age", "600");
      response.writeHead(204).end();
      return;
    }
    const url = new URL(request.url ?? "/", this.#origin);
    const key = decodeKey(url.pathname.slice(1));
    const method = request.method === "HEAD" ? "GET" : request.method;
    if (key === null || (method !== "GET" && method !== "PUT")) {
      response.writeHead(400).end();
      return;
    }
    if (!this.#verify(method, key, url.searchParams)) {
      response.writeHead(403).end();
      return;
    }
    if (method === "PUT") {
      await this.#handlePut(request, response, key, url.searchParams);
      return;
    }
    const meta = this.#readMeta(key);
    if (meta === null) {
      response.writeHead(404).end();
      return;
    }
    const headers: Record<string, string> = {
      "content-type": meta.contentType,
      "content-length": String(meta.contentLength),
      etag: meta.etag,
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "cross-origin"
    };
    if (meta.cacheControl !== null) headers["cache-control"] = meta.cacheControl;
    const disposition = url.searchParams.get("rcd");
    if (disposition !== null) headers["content-disposition"] = disposition;
    response.writeHead(200, headers);
    if (request.method === "HEAD") response.end();
    else response.end(readFileSync(this.#bodyPath(key)));
  }

  async #handlePut(request: IncomingMessage, response: ServerResponse, key: string, params: URLSearchParams): Promise<void> {
    const signedType = params.get("ct");
    const signedLength = Number(params.get("len"));
    if (request.headers["content-type"] !== signedType) {
      response.writeHead(403).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = chunk as Buffer; // node:http yields Buffers when no encoding is set
      size += buffer.length;
      if (size > MAX_BODY_BYTES || size > signedLength) {
        response.writeHead(400).end();
        request.destroy();
        return;
      }
      chunks.push(buffer);
    }
    if (size !== signedLength || signedType === null) {
      response.writeHead(400).end();
      return;
    }
    const meta = this.#write(key, Buffer.concat(chunks), signedType, null);
    response.writeHead(200, { etag: meta.etag }).end();
  }

  #write(key: string, body: Buffer, contentType: string, cacheControl: string | null): StoredMeta {
    writeFileSync(this.#bodyPath(key), body, { mode: 0o600 });
    const meta: StoredMeta = {
      key,
      contentType,
      contentLength: body.length,
      etag: `"${createHash("md5").update(body).digest("hex")}"`,
      lastModified: new Date().toISOString(),
      cacheControl
    };
    writeFileSync(this.#metaPath(key), JSON.stringify(meta), { mode: 0o600 });
    return meta;
  }

  #readMeta(key: string): StoredMeta | null {
    const path = this.#metaPath(key);
    if (!existsSync(path) || !statSync(path).isFile()) return null;
    return JSON.parse(readFileSync(path, "utf8")) as StoredMeta; // written by #write above
  }

  #bodyPath(key: string): string {
    return join(this.#dir, `${hashKey(key)}.bin`);
  }

  #metaPath(key: string): string {
    return join(this.#dir, `${hashKey(key)}.json`);
  }

  #sign(method: string, key: string, params: URLSearchParams): string {
    const fields = [method, key, params.get("exp") ?? "", params.get("ct") ?? "", params.get("len") ?? "", params.get("rcd") ?? ""];
    return createHmac("sha256", this.#secret).update(fields.join("\n")).digest("base64url");
  }

  #verify(method: string, key: string, params: URLSearchParams): boolean {
    const given = params.get("sig");
    const expires = Number(params.get("exp"));
    if (given === null || !Number.isFinite(expires) || expires < Date.now()) return false;
    const expected = Buffer.from(this.#sign(method, key, params));
    const actual = Buffer.from(given);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function decodeKey(path: string): string | null {
  try {
    const key = path.split("/").map(decodeURIComponent).join("/");
    return key.length > 0 && key.length <= 1024 ? key : null;
  } catch {
    return null;
  }
}
