/**
 * {@link StorageService} on Linode Object Storage via the AWS S3 SDK.
 *
 * One `S3Client` per instance, created on first use. When the S3 settings are
 * incomplete the app still boots; every storage call then throws
 * `SERVICE_UNAVAILABLE` instead.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { AppConfig } from "../../config.js";
import { type Clock, systemClock } from "../clock.js";
import { AppError } from "../errors.js";
import type {
  ObjectHead,
  PresignedGet,
  PresignedPut,
  PresignGetInput,
  PresignPutInput,
  PutObjectInput,
  StorageService
} from "./types.js";

/** Default lifetime of presigned URLs. */
export const DEFAULT_PRESIGN_SECONDS = 300;
/** Upper bound for presigned URL lifetime (S3 SigV4 allows 7 days; we never need that). */
const MAX_PRESIGN_SECONDS = 60 * 60 * 24;

/** The S3 settings from {@link AppConfig}. */
export type S3Settings = Pick<
  AppConfig,
  "S3_ENDPOINT" | "S3_REGION" | "S3_BUCKET" | "S3_ACCESS_KEY_ID" | "S3_SECRET_ACCESS_KEY"
>;

/** `true` when every setting needed to talk to the bucket is present. */
export function isS3Configured(settings: S3Settings): boolean {
  return (
    settings.S3_ENDPOINT !== "" &&
    settings.S3_BUCKET !== "" &&
    settings.S3_ACCESS_KEY_ID !== "" &&
    settings.S3_SECRET_ACCESS_KEY !== ""
  );
}

function clampExpiry(seconds: number | undefined): number {
  const value = seconds ?? DEFAULT_PRESIGN_SECONDS;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_PRESIGN_SECONDS);
}

function isNotFound(error: unknown): boolean {
  if (!(error instanceof S3ServiceException)) return false;
  return error.name === "NotFound" || error.name === "NoSuchKey" || error.$metadata.httpStatusCode === 404;
}

/** S3-compatible object storage for the private media bucket. */
export class S3Storage implements StorageService {
  readonly #settings: S3Settings;
  readonly #clock: Clock;
  #client: S3Client | undefined;

  /**
   * @param settings - S3 endpoint, region, bucket and credentials.
   * @param clock - Time source for signing dates and `expiresAt` (inject in tests).
   */
  constructor(settings: S3Settings, clock: Clock = systemClock) {
    this.#settings = settings;
    this.#clock = clock;
  }

  #getClient(): S3Client {
    if (!isS3Configured(this.#settings)) {
      throw new AppError("SERVICE_UNAVAILABLE", "El almacenamiento de fotos todavía no está configurado.");
    }
    this.#client ??= new S3Client({
      endpoint: this.#settings.S3_ENDPOINT,
      region: this.#settings.S3_REGION,
      credentials: {
        accessKeyId: this.#settings.S3_ACCESS_KEY_ID,
        secretAccessKey: this.#settings.S3_SECRET_ACCESS_KEY
      },
      forcePathStyle: false,
      // Since SDK 3.729 the default ("WHEN_SUPPORTED") adds a CRC32 checksum
      // computed at signing time to presigned PUTs and checksum headers to
      // server uploads. Browsers then upload bytes that do not match the
      // signed checksum, and S3-compatible stores (Linode/Ceph RGW) reject it.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED"
    });
    return this.#client;
  }

  /**
   * Presigned PUT whose signature covers `content-type` and `content-length`,
   * so the provider rejects a different type or size.
   */
  async presignPut(input: PresignPutInput): Promise<PresignedPut> {
    const client = this.#getClient();
    const expiresIn = clampExpiry(input.expiresInSeconds);
    const now = this.#clock.now();
    const url = await getSignedUrl(
      client,
      new PutObjectCommand({
        Bucket: this.#settings.S3_BUCKET,
        Key: input.key,
        ContentType: input.contentType,
        ContentLength: input.contentLength
      }),
      { expiresIn, signingDate: now, signableHeaders: new Set(["content-type", "content-length"]) }
    );
    return {
      url,
      method: "PUT",
      requiredHeaders: { "content-type": input.contentType },
      signed: { contentType: input.contentType, contentLength: input.contentLength },
      expiresAt: new Date(now.getTime() + expiresIn * 1000)
    };
  }

  /** Presigned GET for a private object. */
  async presignGet(input: PresignGetInput): Promise<PresignedGet> {
    const client = this.#getClient();
    const expiresIn = clampExpiry(input.expiresInSeconds);
    const now = this.#clock.now();
    const url = await getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: this.#settings.S3_BUCKET,
        Key: input.key,
        ...(input.responseContentDisposition === undefined
          ? {}
          : { ResponseContentDisposition: input.responseContentDisposition })
      }),
      { expiresIn, signingDate: now }
    );
    return { url, expiresAt: new Date(now.getTime() + expiresIn * 1000) };
  }

  /** Object metadata, or `null` when the key does not exist. */
  async head(key: string): Promise<ObjectHead | null> {
    const client = this.#getClient();
    try {
      const result = await client.send(new HeadObjectCommand({ Bucket: this.#settings.S3_BUCKET, Key: key }));
      return {
        key,
        contentLength: result.ContentLength ?? 0,
        contentType: result.ContentType ?? null,
        etag: result.ETag ?? null,
        lastModified: result.LastModified ?? null
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /** Bytes `[start, endInclusive]` of an object (HTTP Range). */
  async getRange(key: string, start: number, endInclusive: number): Promise<Uint8Array> {
    if (!Number.isInteger(start) || !Number.isInteger(endInclusive) || start < 0 || endInclusive < start) {
      throw new RangeError(`invalid range ${start}-${endInclusive}`);
    }
    const client = this.#getClient();
    const result = await client.send(
      new GetObjectCommand({ Bucket: this.#settings.S3_BUCKET, Key: key, Range: `bytes=${start}-${endInclusive}` })
    );
    if (!result.Body) return new Uint8Array();
    return result.Body.transformToByteArray();
  }

  /** Upload bytes from the server (thumbnails, display copies). */
  async put(input: PutObjectInput): Promise<void> {
    const client = this.#getClient();
    await client.send(
      new PutObjectCommand({
        Bucket: this.#settings.S3_BUCKET,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        ContentLength: input.body.byteLength,
        ...(input.cacheControl === undefined ? {} : { CacheControl: input.cacheControl })
      })
    );
  }

  /** Delete an object; a missing key is not an error (S3 semantics). */
  async delete(key: string): Promise<void> {
    const client = this.#getClient();
    await client.send(new DeleteObjectCommand({ Bucket: this.#settings.S3_BUCKET, Key: key }));
  }

  /** Release the underlying HTTP agent (called on app close). */
  destroy(): void {
    this.#client?.destroy();
    this.#client = undefined;
  }
}
