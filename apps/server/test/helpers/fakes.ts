import { createHash, randomUUID } from "node:crypto";
import type { Mailer, MailMessage, MailSendResult } from "../../src/lib/mailer/types.js";
import type {
  ObjectHead,
  PresignedGet,
  PresignedPut,
  PresignGetInput,
  PresignPutInput,
  PutObjectInput,
  StorageService
} from "../../src/lib/storage/types.js";

/** A message captured by {@link FakeMailer}. */
export interface SentMail extends MailMessage {
  id: string;
  sentAt: Date;
}

/**
 * In-memory {@link Mailer}: records every message in `outbox` instead of
 * sending it. Assert on `outbox` (or {@link FakeMailer.lastTo}) in tests.
 */
export class FakeMailer implements Mailer {
  readonly outbox: SentMail[] = [];

  /** Record the message and return a fake provider id. */
  async send(message: MailMessage): Promise<MailSendResult> {
    const id = `fake-mail-${randomUUID()}`;
    this.outbox.push({ ...message, id, sentAt: new Date() });
    return { id };
  }

  /** Most recent message sent to `address` (case-insensitive), if any. */
  lastTo(address: string): SentMail | undefined {
    const wanted = address.toLowerCase();
    for (let index = this.outbox.length - 1; index >= 0; index -= 1) {
      const mail = this.outbox[index];
      if (mail && mail.to.toLowerCase() === wanted) return mail;
    }
    return undefined;
  }

  /** Empty the outbox. */
  clear(): void {
    this.outbox.length = 0;
  }
}

/** Object stored by {@link FakeStorage}. */
export interface FakeStoredObject {
  body: Uint8Array;
  contentType: string;
  lastModified: Date;
}

/** Base URL used for fake presigned URLs; never resolvable. */
export const FAKE_STORAGE_BASE_URL = "https://fake-storage.test";

const DEFAULT_EXPIRY_SECONDS = 300;

/**
 * In-memory {@link StorageService}. Presigned URLs point at an unresolvable
 * host; simulate the browser's direct upload with {@link FakeStorage.put}
 * (or {@link FakeStorage.simulateUpload}) after calling `presignPut`.
 */
export class FakeStorage implements StorageService {
  readonly objects = new Map<string, FakeStoredObject>();
  /** Every presigned PUT issued, in order, so tests can assert on bound headers. */
  readonly presignedPuts: Array<PresignPutInput & PresignedPut> = [];

  /** Return a fake presigned PUT URL and remember what was signed. */
  async presignPut(input: PresignPutInput): Promise<PresignedPut> {
    const expiresAt = new Date(Date.now() + (input.expiresInSeconds ?? DEFAULT_EXPIRY_SECONDS) * 1000);
    const presigned: PresignedPut = {
      url: `${FAKE_STORAGE_BASE_URL}/${encodeKey(input.key)}?X-Fake-Signature=put&X-Fake-Expires=${expiresAt.getTime()}`,
      method: "PUT",
      headers: { "content-type": input.contentType, "content-length": String(input.contentLength) },
      expiresAt
    };
    this.presignedPuts.push({ ...input, ...presigned });
    return presigned;
  }

  /** Return a fake presigned GET URL. Does not require the object to exist. */
  async presignGet(input: PresignGetInput): Promise<PresignedGet> {
    const expiresAt = new Date(Date.now() + (input.expiresInSeconds ?? DEFAULT_EXPIRY_SECONDS) * 1000);
    const params = new URLSearchParams({ "X-Fake-Signature": "get", "X-Fake-Expires": String(expiresAt.getTime()) });
    if (input.responseContentDisposition) {
      params.set("response-content-disposition", input.responseContentDisposition);
    }
    return { url: `${FAKE_STORAGE_BASE_URL}/${encodeKey(input.key)}?${params.toString()}`, expiresAt };
  }

  /** Metadata for `key`, or `null` when missing. */
  async head(key: string): Promise<ObjectHead | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      key,
      contentLength: object.body.byteLength,
      contentType: object.contentType,
      etag: `"${createHash("md5").update(object.body).digest("hex")}"`,
      lastModified: object.lastModified
    };
  }

  /** Bytes `[start, endInclusive]` of `key`; throws when the object is missing. */
  async getRange(key: string, start: number, endInclusive: number): Promise<Uint8Array> {
    const object = this.objects.get(key);
    if (!object) throw new Error(`FakeStorage: no object at ${key}`);
    if (start < 0 || endInclusive < start) throw new RangeError(`FakeStorage: invalid range ${start}-${endInclusive}`);
    return object.body.slice(start, endInclusive + 1);
  }

  /** Store a copy of `body` under `key`. */
  async put(input: PutObjectInput): Promise<void> {
    this.objects.set(input.key, {
      body: new Uint8Array(input.body),
      contentType: input.contentType,
      lastModified: new Date()
    });
  }

  /** Remove `key`; missing keys are ignored. */
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  /** Test helper: act as the browser completing a presigned upload. */
  async simulateUpload(key: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.put({ key, body, contentType });
  }
}

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}
