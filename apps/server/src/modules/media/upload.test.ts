import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestApp, createTestConfig } from "../../../test/helpers/app.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { bearerFor, createSession, createUser } from "../../../test/helpers/factories.js";
import { FakeStorage } from "../../../test/helpers/fakes.js";
import {
  createCuencada,
  createMember,
  insertMedia,
  keyFromFakeUrl,
  makeDecompressionBombPng,
  makeJpegWithGps,
  makeMp4,
  makeMp4WithLocation,
  makePng,
  makeWebp,
  PLANTED_LOCATION,
  uploadMedia
} from "../../../test/helpers/media.js";
import type { App } from "../../app.js";
import { auditLogs, mediaItems } from "../../db/schema/index.js";
import { systemClock } from "../../lib/clock.js";
import { S3Storage } from "../../lib/storage/s3.js";
import { DAILY_UPLOAD_BYTES, DAILY_UPLOAD_WINDOW_MS, DERIVATIVE_CACHE_CONTROL, SNIFF_BYTES, UPLOAD_URL_SECONDS } from "./constants.js";
import { runMediaCleanup } from "./jobs/mediaCleanup.js";
import { recoverProcessingOnStart } from "./jobs/mediaProcess.js";
import { jobDeps } from "./shared.js";

const MB = 1024 * 1024;
let app: App | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function setup(config: Parameters<typeof createTestApp>[0] = {}): Promise<{ app: App; storage: FakeStorage }> {
  const storage = new FakeStorage();
  app = await createTestApp({ storage, ...config });
  return { app, storage };
}

async function mediaRow(id: string): Promise<typeof mediaItems.$inferSelect> {
  const [row] = await getTestDb().select().from(mediaItems).where(eq(mediaItems.id, id));
  if (row === undefined) throw new Error("no media row");
  return row;
}

function hasGpsIfd(exif: Buffer | undefined): boolean {
  if (exif === undefined) return false;
  return exif.includes(Buffer.from([0x88, 0x25])) || exif.includes(Buffer.from([0x25, 0x88]));
}

describe("POST /api/cuencadas/:year/media/uploads", () => {
  it("creates a pending item with a server-chosen key and a presigned PUT bound to type and size", async () => {
    const { app, storage } = await setup();
    await createCuencada();
    const { user, auth } = await createMember();

    const response = await app.inject({
      method: "POST",
      url: "/api/cuencadas/2026/media/uploads",
      ...auth,
      payload: { fileName: "  Mi foto ✨.JPG ", mimeType: "image/jpeg", byteSize: 1234, caption: " En la playa " }
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<{ mediaId: string; uploadUrl: string; headers: Record<string, string>; expiresAt: string }>();
    expect(Object.keys(body).sort()).toEqual(["expiresAt", "headers", "mediaId", "uploadUrl"]);
    expect(body.headers).toEqual({ "Content-Type": "image/jpeg" });
    expect(Object.keys(body.headers).map((name) => name.toLowerCase())).not.toContain("content-length");
    expect(keyFromFakeUrl(body.uploadUrl)).toBe(`cuencadas/2026/originals/${body.mediaId}.jpg`);

    const signed = storage.presignedPuts.at(-1);
    expect(signed).toMatchObject({ contentType: "image/jpeg", contentLength: 1234, expiresInSeconds: UPLOAD_URL_SECONDS });

    const row = await mediaRow(body.mediaId);
    expect(row).toMatchObject({
      uploadedByUserId: user.id,
      kind: "image",
      fileName: "Mi foto ✨.JPG",
      caption: "En la playa",
      uploadStatus: "pending_upload",
      moderationStatus: "approved",
      objectKey: `cuencadas/2026/originals/${body.mediaId}.jpg`
    });
    expect(row.uploadExpiresAt).not.toBeNull();
  });

  it("presigns against the bucket's virtual-hosted origin with real S3 settings", async () => {
    const config = createTestConfig({
      S3_ENDPOINT: "https://us-southeast-1.linodeobjects.com",
      S3_REGION: "us-southeast-1",
      S3_BUCKET: "cuencada-media",
      S3_ACCESS_KEY_ID: "test-access-key",
      S3_SECRET_ACCESS_KEY: "test-secret-key-value"
    });
    const storage = new S3Storage(config, systemClock);
    try {
      const presigned = await storage.presignPut({ key: "cuencadas/2026/originals/x.jpg", contentType: "image/jpeg", contentLength: 10 });
      expect(new URL(presigned.url).origin).toBe("https://cuencada-media.us-southeast-1.linodeobjects.com");
    } finally {
      storage.destroy();
    }
  });

  it("sets pending_review when approval is required, except for admins", async () => {
    const { app } = await setup({ config: { MEDIA_REQUIRE_APPROVAL: true } });
    await createCuencada();
    const member = await createMember();
    const admin = await createMember({ role: "admin" });
    const payload = { fileName: "a.jpg", mimeType: "image/jpeg", byteSize: 10 };

    const memberUpload = await app.inject({ method: "POST", url: "/api/cuencadas/2026/media/uploads", ...member.auth, payload });
    const adminUpload = await app.inject({ method: "POST", url: "/api/cuencadas/2026/media/uploads", ...admin.auth, payload });

    expect((await mediaRow(memberUpload.json<{ mediaId: string }>().mediaId)).moderationStatus).toBe("pending_review");
    expect((await mediaRow(adminUpload.json<{ mediaId: string }>().mediaId)).moderationStatus).toBe("approved");
  });

  it.each([
    ["a disallowed MIME type", { fileName: "a.heic", mimeType: "image/heic", byteSize: 10 }],
    ["an image over 25 MB", { fileName: "a.jpg", mimeType: "image/jpeg", byteSize: 25 * MB + 1 }],
    ["a video over 300 MB", { fileName: "a.mp4", mimeType: "video/mp4", byteSize: 300 * MB + 1 }],
    ["an empty file", { fileName: "a.jpg", mimeType: "image/jpeg", byteSize: 0 }],
    ["a file name with a path", { fileName: "../a.jpg", mimeType: "image/jpeg", byteSize: 10 }],
    ["a file name with a bidi override", { fileName: `a${String.fromCodePoint(0x202e)}gpj.exe`, mimeType: "image/jpeg", byteSize: 10 }]
  ])("rejects %s with 400 VALIDATION", async (_label, payload) => {
    const { app } = await setup();
    await createCuencada();
    const { auth } = await createMember();

    const response = await app.inject({ method: "POST", url: "/api/cuencadas/2026/media/uploads", ...auth, payload });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "VALIDATION" } });
    expect(await getTestDb().select().from(mediaItems)).toHaveLength(0);
  });

  it("answers 401 without a token and 403 while a password change is pending", async () => {
    const { app } = await setup();
    await createCuencada();
    const payload = { fileName: "a.jpg", mimeType: "image/jpeg", byteSize: 10 };
    const pending = await createUser({ mustChangePassword: true });
    const pendingAuth = await bearerFor(pending, await createSession(pending.id));

    const anonymous = await app.inject({ method: "POST", url: "/api/cuencadas/2026/media/uploads", payload });
    const mustChange = await app.inject({ method: "POST", url: "/api/cuencadas/2026/media/uploads", ...pendingAuth, payload });

    expect(anonymous.statusCode).toBe(401);
    expect(mustChange.statusCode).toBe(403);
    expect(mustChange.json()).toMatchObject({ error: { code: "PASSWORD_CHANGE_REQUIRED" } });
  });

  it("answers 404 for a missing or unpublished Cuencada", async () => {
    const { app } = await setup();
    await createCuencada({ year: 2025, isPublished: false });
    const { auth } = await createMember();
    const payload = { fileName: "a.jpg", mimeType: "image/jpeg", byteSize: 10 };

    const draft = await app.inject({ method: "POST", url: "/api/cuencadas/2025/media/uploads", ...auth, payload });
    const missing = await app.inject({ method: "POST", url: "/api/cuencadas/2024/media/uploads", ...auth, payload });

    expect(draft.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
  });

  it("rate-limits intents per user at 30 per minute", async () => {
    const { app } = await setup();
    await createCuencada();
    const first = await createMember();
    const second = await createMember();
    const payload = { fileName: "a.jpg", mimeType: "image/jpeg", byteSize: 10 };

    const statuses: number[] = [];
    for (let index = 0; index < 31; index += 1) {
      const response = await app.inject({ method: "POST", url: "/api/cuencadas/2026/media/uploads", ...first.auth, payload });
      statuses.push(response.statusCode);
    }
    const other = await app.inject({ method: "POST", url: "/api/cuencadas/2026/media/uploads", ...second.auth, payload });

    expect(statuses.slice(0, 30).every((status) => status === 201)).toBe(true);
    expect(statuses[30]).toBe(429);
    expect(other.statusCode).toBe(201);
  });
});

describe("POST /api/media/:id/confirm and processing", () => {
  it("processes a JPEG: auto-orients, strips EXIF/GPS, writes 400px and 1600px WebP copies", async () => {
    const { app, storage } = await setup();
    await createCuencada();
    const { user, auth } = await createMember();
    const original = await makeJpegWithGps(64, 32);
    const originalMeta = await sharp(original).metadata();
    expect(hasGpsIfd(originalMeta.exif)).toBe(true);

    const result = await uploadMedia(app, storage, auth, original);

    expect(result.confirmStatus).toBe(200);
    expect(result.confirmBody).toMatchObject({ id: result.mediaId, uploadStatus: "processing", isMine: true });
    const row = await mediaRow(result.mediaId);
    expect(row).toMatchObject({
      uploadStatus: "ready",
      moderationStatus: "approved",
      width: 32,
      height: 64,
      thumbKey: `cuencadas/2026/thumbs/${result.mediaId}.webp`,
      displayKey: `cuencadas/2026/display/${result.mediaId}.webp`,
      processingError: null
    });
    for (const key of [row.thumbKey, row.displayKey]) {
      const stored = storage.objects.get(key ?? "");
      expect(stored?.contentType).toBe("image/webp");
      const meta = await sharp(stored?.body).metadata();
      expect(meta.format).toBe("webp");
      expect(meta.exif).toBeUndefined();
      expect(meta.orientation).toBeUndefined();
      expect(meta.width).toBe(32);
      expect(meta.height).toBe(64);
      expect(Buffer.from(stored?.body ?? []).includes(Buffer.from("SecretCam"))).toBe(false);
    }

    const audit = await getTestDb()
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "media.uploaded"), eq(auditLogs.entityId, result.mediaId)));
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorUserId).toBe(user.id);
    // The original (with its GPS EXIF) is gone; only the sanitized copies remain.
    expect(storage.objects.has(result.key)).toBe(false);
    expect([...storage.objects.keys()].sort()).toEqual([row.displayKey, row.thumbKey].sort());
  });

  it("stores derivatives with immutable private caching and bounded widths", async () => {
    const storage = new FakeStorage();
    const puts: Array<{ key: string; cacheControl: string | undefined }> = [];
    const original = storage.put.bind(storage);
    storage.put = async (input) => {
      puts.push({ key: input.key, cacheControl: input.cacheControl });
      await original(input);
    };
    app = await createTestApp({ storage });
    await createCuencada();
    const { auth } = await createMember();

    const result = await uploadMedia(app, storage, auth, await makeWebp(2000, 1000), { mimeType: "image/webp", fileName: "a.webp" });

    const derivativePuts = puts.filter((put) => !put.key.includes("/originals/"));
    expect(derivativePuts).toHaveLength(2);
    expect(derivativePuts.every((put) => put.cacheControl === DERIVATIVE_CACHE_CONTROL)).toBe(true);
    const row = await mediaRow(result.mediaId);
    const thumb = await sharp(storage.objects.get(row.thumbKey ?? "")?.body).metadata();
    const display = await sharp(storage.objects.get(row.displayKey ?? "")?.body).metadata();
    expect([thumb.width, thumb.height]).toEqual([400, 200]);
    expect([display.width, display.height]).toEqual([1600, 800]);
    expect([row.width, row.height]).toEqual([2000, 1000]);
  });

  it("keeps an approval-first upload in pending_review after processing", async () => {
    const { app, storage } = await setup({ config: { MEDIA_REQUIRE_APPROVAL: true } });
    await createCuencada();
    const { auth } = await createMember();

    const result = await uploadMedia(app, storage, auth, await makePng(), { mimeType: "image/png", fileName: "a.png" });

    expect(await mediaRow(result.mediaId)).toMatchObject({ uploadStatus: "ready", moderationStatus: "pending_review" });
  });

  it("serves a scrubbed copy of a video under its own display key and deletes the original", async () => {
    const { app, storage } = await setup();
    await createCuencada();
    const { auth } = await createMember();

    const mp4 = await uploadMedia(app, storage, auth, makeMp4("isom", 42), { mimeType: "video/mp4", fileName: "v.mp4" });
    const mov = await uploadMedia(app, storage, auth, makeMp4("qt  ", 7), { mimeType: "video/quicktime", fileName: "v.mov" });

    const mp4Row = await mediaRow(mp4.mediaId);
    expect(mp4Row).toMatchObject({
      kind: "video",
      uploadStatus: "ready",
      thumbKey: null,
      displayKey: `cuencadas/2026/display/${mp4.mediaId}.mp4`,
      durationSeconds: 42
    });
    expect(storage.objects.get(mp4Row.displayKey ?? "")?.contentType).toBe("video/mp4");
    expect(storage.objects.has(mp4.key)).toBe(false);
    const movRow = await mediaRow(mov.mediaId);
    expect(movRow).toMatchObject({ uploadStatus: "ready", durationSeconds: 7, displayKey: `cuencadas/2026/display/${mov.mediaId}.mov` });
    expect(storage.objects.get(movRow.displayKey ?? "")?.contentType).toBe("video/quicktime");
  });

  it("strips location and device metadata from an iPhone-style video (M1)", async () => {
    const { app, storage } = await setup();
    await createCuencada();
    const { auth } = await createMember();
    const other = await createMember();
    const fixture = makeMp4WithLocation("qt  ");

    const result = await uploadMedia(app, storage, auth, fixture.bytes, { mimeType: "video/quicktime", fileName: "IMG_0001.MOV" });

    expect(result.confirmStatus).toBe(200);
    const row = await mediaRow(result.mediaId);
    expect(row.uploadStatus).toBe("ready");
    const served = Buffer.from(storage.objects.get(row.displayKey ?? "")?.body ?? []);
    expect(served.length).toBe(fixture.bytes.length);
    for (const secret of [PLANTED_LOCATION, "+20.9674", "\xa9xyz", "ISO6709", "xmpmeta", "iPhone 15 Pro"]) {
      expect(served.includes(Buffer.from(secret, "latin1"))).toBe(false);
    }
    expect(served.readUInt32BE(fixture.stcoEntryOffset)).toBe(fixture.mdatPayloadOffset);
    expect(served.subarray(fixture.mdatPayloadOffset, fixture.mdatPayloadOffset + fixture.payload.length)).toEqual(fixture.payload);
    expect(storage.objects.has(result.key)).toBe(false);

    const list = await app.inject({ method: "GET", url: "/api/cuencadas/2026/media", ...other.auth });
    const item = list.json<{ items: Array<{ id: string; displayUrl: string | null; thumbUrl: string | null }> }>().items[0];
    expect(item?.id).toBe(result.mediaId);
    expect(item?.thumbUrl).toBeNull();
    expect(decodeURIComponent(new URL(String(item?.displayUrl)).pathname)).toBe(`/cuencadas/2026/display/${result.mediaId}.mov`);
  });

  it("re-checks the bytes in the job: a video swapped after confirm fails and nothing is served (L1)", async () => {
    const storage = new FakeStorage();
    let swap: Uint8Array | null = null;
    const realGetRange = storage.getRange.bind(storage);
    storage.getRange = async (key, start, endInclusive) => {
      if (swap !== null && endInclusive > SNIFF_BYTES) {
        await storage.put({ key, body: swap, contentType: "video/mp4" });
        swap = null;
      }
      return realGetRange(key, start, endInclusive);
    };
    app = await createTestApp({ storage });
    await createCuencada();
    const { auth } = await createMember();
    const valid = makeMp4("isom", 3);
    swap = Buffer.alloc(valid.length, 0x3c); // "<<<<": same length, not a video

    const result = await uploadMedia(app, storage, auth, valid, { mimeType: "video/mp4", fileName: "v.mp4" });

    expect(result.confirmStatus).toBe(200);
    expect(await mediaRow(result.mediaId)).toMatchObject({ uploadStatus: "failed", processingError: "signature_mismatch", displayKey: null });
    expect(storage.objects.size).toBe(0);
  });

  it.each([
    ["a PNG declared as JPEG", async () => makePng(), "image/jpeg"],
    ["a text file renamed .jpg", async () => Buffer.from("hola, esto es texto y no una foto"), "image/jpeg"],
    ["a QuickTime file declared as MP4", async () => makeMp4("qt  "), "video/mp4"]
  ] as const)("rejects %s with 400 UPLOAD_INVALID, marks it failed and deletes the object", async (_label, makeBody, mimeType) => {
    const { app, storage } = await setup();
    await createCuencada();
    const { auth } = await createMember();

    const result = await uploadMedia(app, storage, auth, await makeBody(), { mimeType });

    expect(result.confirmStatus).toBe(400);
    expect(result.confirmBody).toMatchObject({
      error: { code: "UPLOAD_INVALID", details: [{ path: "upload", message: "rejected" }] }
    });
    expect(await mediaRow(result.mediaId)).toMatchObject({ uploadStatus: "failed", processingError: "signature_mismatch" });
    expect(storage.objects.has(result.key)).toBe(false);
    const audit = await getTestDb().select().from(auditLogs).where(eq(auditLogs.action, "media.upload_rejected"));
    expect(audit).toHaveLength(1);
    expect(audit[0]?.metadata).toMatchObject({ reason: "signature_mismatch" });
  });

  it("rejects a size mismatch between the intent and the stored object", async () => {
    const { app, storage } = await setup();
    await createCuencada();
    const { auth } = await createMember();
    const jpeg = await makeJpegWithGps();

    const result = await uploadMedia(app, storage, auth, jpeg, { byteSize: jpeg.byteLength + 10 });

    expect(result.confirmStatus).toBe(400);
    expect(await mediaRow(result.mediaId)).toMatchObject({ uploadStatus: "failed", processingError: "size_mismatch" });
    expect(storage.objects.has(result.key)).toBe(false);
  });

  it("rejects a stored Content-Type that differs from the declared one", async () => {
    const { app, storage } = await setup();
    await createCuencada();
    const { auth } = await createMember();

    const result = await uploadMedia(app, storage, auth, await makeJpegWithGps(), { storedContentType: "text/html" });

    expect(result.confirmStatus).toBe(400);
    expect(await mediaRow(result.mediaId)).toMatchObject({ processingError: "content_type_mismatch" });
  });

  it("answers 400 and keeps the item pending when the object has not arrived yet", async () => {
    const { app } = await setup();
    await createCuencada();
    const { auth } = await createMember();
    const intent = await app.inject({
      method: "POST",
      url: "/api/cuencadas/2026/media/uploads",
      ...auth,
      payload: { fileName: "a.jpg", mimeType: "image/jpeg", byteSize: 10 }
    });
    const { mediaId } = intent.json<{ mediaId: string }>();

    const response = await app.inject({ method: "POST", url: `/api/media/${mediaId}/confirm`, ...auth });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "UPLOAD_INVALID", details: [{ path: "upload", message: "not_received" }] }
    });
    expect((await mediaRow(mediaId)).uploadStatus).toBe("pending_upload");
  });

  it("rejects a decompression bomb during processing without decoding it", async () => {
    const { app, storage } = await setup();
    await createCuencada();
    const { auth } = await createMember();

    const result = await uploadMedia(app, storage, auth, makeDecompressionBombPng(), { mimeType: "image/png", fileName: "b.png" });

    expect(result.confirmStatus).toBe(200);
    const row = await mediaRow(result.mediaId);
    expect(row).toMatchObject({ uploadStatus: "failed", processingError: "pixel_limit_exceeded", thumbKey: null });
    // L3: the original of a failed item is deleted too.
    expect(storage.objects.size).toBe(0);
  });

  it("is idempotent once accepted and answers 404 to anyone but the uploader", async () => {
    const { app, storage } = await setup();
    await createCuencada();
    const owner = await createMember();
    const other = await createMember();
    const admin = await createMember({ role: "admin" });
    const result = await uploadMedia(app, storage, owner.auth, await makePng(), { mimeType: "image/png" });

    const again = await app.inject({ method: "POST", url: `/api/media/${result.mediaId}/confirm`, ...owner.auth });
    const byOther = await app.inject({ method: "POST", url: `/api/media/${result.mediaId}/confirm`, ...other.auth });
    const byAdmin = await app.inject({ method: "POST", url: `/api/media/${result.mediaId}/confirm`, ...admin.auth });
    const anonymous = await app.inject({ method: "POST", url: `/api/media/${result.mediaId}/confirm` });

    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ uploadStatus: "ready" });
    expect(byOther.statusCode).toBe(404);
    expect(byAdmin.statusCode).toBe(404);
    expect(anonymous.statusCode).toBe(401);
    expect(await getTestDb().select().from(auditLogs).where(eq(auditLogs.action, "media.uploaded"))).toHaveLength(1);
  });

  it("rejects a confirm body with unknown keys and a malformed id", async () => {
    const { app } = await setup();
    const { auth } = await createMember();

    const withBody = await app.inject({
      method: "POST",
      url: "/api/media/6f1d3b0e-2c4a-4b8e-9f00-1234567890ab/confirm",
      ...auth,
      payload: { checksum: "x" }
    });
    const badId = await app.inject({ method: "POST", url: "/api/media/not-a-uuid/confirm", ...auth });

    expect(withBody.statusCode).toBe(400);
    expect(badId.statusCode).toBe(400);
  });

  it("discards derivatives when the item is deleted while processing", async () => {
    const storage = new FakeStorage();
    let deleteDuringPut: (() => Promise<void>) | null = null;
    const original = storage.put.bind(storage);
    storage.put = async (input) => {
      if (deleteDuringPut !== null && input.key.includes("/thumbs/")) {
        const run = deleteDuringPut;
        deleteDuringPut = null;
        await run();
      }
      await original(input);
    };
    app = await createTestApp({ storage });
    const testApp = app;
    await createCuencada();
    const { auth } = await createMember();
    const result = await uploadMedia(testApp, storage, auth, await makePng(), { mimeType: "image/png", confirm: false });
    deleteDuringPut = async () => {
      await getTestDb().update(mediaItems).set({ deletedAt: new Date() }).where(eq(mediaItems.id, result.mediaId));
    };

    const confirm = await testApp.inject({ method: "POST", url: `/api/media/${result.mediaId}/confirm`, ...auth });
    await testApp.jobs.onIdle();

    expect(confirm.statusCode).toBe(200);
    const row = await mediaRow(result.mediaId);
    expect(row.uploadStatus).toBe("processing");
    expect(storage.objects.size).toBe(0);
  });

  it("leaves no objects when the uploader deletes through the API while the job runs", async () => {
    const storage = new FakeStorage();
    let deleteDuringPut: (() => Promise<void>) | null = null;
    const original = storage.put.bind(storage);
    storage.put = async (input) => {
      await original(input);
      if (deleteDuringPut !== null && input.key.includes("/display/")) {
        const run = deleteDuringPut;
        deleteDuringPut = null;
        await run();
      }
    };
    app = await createTestApp({ storage });
    const testApp = app;
    await createCuencada();
    const { auth } = await createMember();
    const result = await uploadMedia(testApp, storage, auth, await makePng(), { mimeType: "image/png", confirm: false });
    let deleteStatus = 0;
    deleteDuringPut = async () => {
      const response = await testApp.inject({ method: "DELETE", url: `/api/media/${result.mediaId}`, ...auth });
      deleteStatus = response.statusCode;
    };

    await testApp.inject({ method: "POST", url: `/api/media/${result.mediaId}/confirm`, ...auth });
    await testApp.jobs.onIdle();

    expect(deleteStatus).toBe(204);
    expect((await mediaRow(result.mediaId)).deletedAt).not.toBeNull();
    expect(storage.objects.size).toBe(0);
  });

  it("answers 404 to a confirm after the cleanup claimed the abandoned upload, and the object is gone", async () => {
    const { app, storage } = await setup();
    await createCuencada();
    const { auth } = await createMember();
    const result = await uploadMedia(app, storage, auth, await makePng(), { mimeType: "image/png", confirm: false });
    await getTestDb().update(mediaItems).set({ uploadExpiresAt: new Date(0) }).where(eq(mediaItems.id, result.mediaId));
    await runMediaCleanup({ db: getTestDb(), storage, clock: systemClock, log: app.log });

    const confirm = await app.inject({ method: "POST", url: `/api/media/${result.mediaId}/confirm`, ...auth });

    expect(confirm.statusCode).toBe(404);
    expect(storage.objects.has(result.key)).toBe(false);
  });

  it("rate-limits confirms per user at 60 per minute", async () => {
    const { app } = await setup();
    const { auth } = await createMember();
    const statuses: number[] = [];
    for (let index = 0; index < 61; index += 1) {
      const response = await app.inject({ method: "POST", url: "/api/media/6f1d3b0e-2c4a-4b8e-9f00-1234567890ab/confirm", ...auth });
      statuses.push(response.statusCode);
    }
    expect(statuses.slice(0, 60).every((status) => status === 404)).toBe(true);
    expect(statuses[60]).toBe(429);
  });
});

describe("startup recovery", () => {
  const MINUTE_AGO = (): Date => new Date(Date.now() - 60_000);

  async function stuckItem(
    cuencadaId: string,
    storage: FakeStorage,
    overrides: Partial<Parameters<typeof insertMedia>[0]> = {}
  ): Promise<typeof mediaItems.$inferSelect> {
    const png = await makePng();
    const row = await insertMedia({
      cuencadaId,
      mimeType: "image/png",
      byteSize: png.byteLength,
      thumbKey: null,
      displayKey: null,
      width: null,
      height: null,
      uploadStatus: "processing",
      confirmedAt: MINUTE_AGO(),
      ...overrides
    });
    await storage.put({ key: row.objectKey, body: png, contentType: "image/png" });
    return row;
  }

  it("fails items that had started (marker) as interrupted, deletes their objects and never re-reads them (L2)", async () => {
    const storage = new FakeStorage();
    const cuencada = await createCuencada();
    const started = await stuckItem(cuencada.id, storage, { processingError: "started" });
    const deleted = await insertMedia({ cuencadaId: cuencada.id, uploadStatus: "processing", confirmedAt: MINUTE_AGO(), deletedAt: new Date() });
    const getRangeCalls: string[] = [];
    const realGetRange = storage.getRange.bind(storage);
    storage.getRange = async (key, start, end) => {
      getRangeCalls.push(key);
      return realGetRange(key, start, end);
    };

    app = await createTestApp({ storage });

    await vi.waitFor(async () => expect((await mediaRow(started.id)).uploadStatus).toBe("failed"), { timeout: 5000 });
    await app.jobs.onIdle();
    expect(await mediaRow(started.id)).toMatchObject({ uploadStatus: "failed", processingError: "interrupted" });
    expect(storage.objects.has(started.objectKey)).toBe(false);
    expect(getRangeCalls).toEqual([]);
    expect((await mediaRow(deleted.id)).uploadStatus).toBe("processing");
  });

  it("re-queues items that were confirmed but never started", async () => {
    const storage = new FakeStorage();
    const cuencada = await createCuencada();
    const queued = await stuckItem(cuencada.id, storage);

    app = await createTestApp({ storage });

    await vi.waitFor(async () => expect((await mediaRow(queued.id)).uploadStatus).toBe("ready"), { timeout: 5000 });
    await app.jobs.onIdle();
    expect(await mediaRow(queued.id)).toMatchObject({ uploadStatus: "ready", processingError: null, width: 40, height: 30 });
  });

  it("ignores items confirmed after the module started (a confirm right after boot is not failed)", async () => {
    const storage = new FakeStorage();
    app = await createTestApp({ storage });
    await app.jobs.onIdle();
    const cuencada = await createCuencada();
    const startedAt = new Date(Date.now() - 1000);
    const fresh = await stuckItem(cuencada.id, storage, { processingError: "started", confirmedAt: new Date() });

    const result = await recoverProcessingOnStart(jobDeps(app), startedAt);

    expect(result).toEqual({ requeued: 0, failed: 0 });
    expect(await mediaRow(fresh.id)).toMatchObject({ uploadStatus: "processing", processingError: "started" });
    expect(storage.objects.has(fresh.objectKey)).toBe(true);
  });

  it("deletes a video's scrubbed display copy when failing it as interrupted", async () => {
    const storage = new FakeStorage();
    const cuencada = await createCuencada();
    const id = "6f1d3b0e-2c4a-4b8e-9f00-1234567890ab";
    const original = `cuencadas/2026/originals/${id}.mov`;
    const display = `cuencadas/2026/display/${id}.mov`;
    await insertMedia({
      id,
      cuencadaId: cuencada.id,
      kind: "video",
      mimeType: "video/quicktime",
      objectKey: original,
      thumbKey: null,
      displayKey: null,
      uploadStatus: "processing",
      processingError: "started",
      confirmedAt: MINUTE_AGO()
    });
    for (const key of [original, display]) await storage.put({ key, body: new Uint8Array([1]), contentType: "video/quicktime" });

    app = await createTestApp({ storage });

    await vi.waitFor(async () => expect((await mediaRow(id)).uploadStatus).toBe("failed"), { timeout: 5000 });
    expect(storage.objects.size).toBe(0);
  });
});

describe("upload quotas", () => {
  it("caps open intents at 50 per user (TL7)", async () => {
    const { app } = await setup();
    const cuencada = await createCuencada();
    const { user, auth } = await createMember();
    for (let index = 0; index < 50; index += 1) {
      await insertMedia({ cuencadaId: cuencada.id, uploadedByUserId: user.id, uploadStatus: "pending_upload", byteSize: 10 });
    }

    const response = await app.inject({
      method: "POST",
      url: "/api/cuencadas/2026/media/uploads",
      ...auth,
      payload: { fileName: "a.jpg", mimeType: "image/jpeg", byteSize: 10 }
    });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
  });

  it("enforces the rolling 24 h byte budget, ignoring failed and older items (L4)", async () => {
    const { app } = await setup();
    const cuencada = await createCuencada();
    const { user, auth } = await createMember();
    const big = 300 * MB;
    const base = { cuencadaId: cuencada.id, uploadedByUserId: user.id, kind: "video", mimeType: "video/mp4", byteSize: big } as const;
    for (let index = 0; index < 12; index += 1) await insertMedia({ ...base }); // 3600 MB today
    await insertMedia({ ...base, uploadStatus: "failed" });
    await insertMedia({ ...base, createdAt: new Date(Date.now() - DAILY_UPLOAD_WINDOW_MS - 60_000) });
    await insertMedia({ ...base, deletedAt: new Date() }); // deleted still counts: 3900 MB
    const intent = (byteSize: number) =>
      app.inject({
        method: "POST",
        url: "/api/cuencadas/2026/media/uploads",
        ...auth,
        payload: { fileName: "a.mp4", mimeType: "video/mp4", byteSize }
      });

    expect(DAILY_UPLOAD_BYTES).toBe(4096 * MB);
    const over = await intent(DAILY_UPLOAD_BYTES - 3900 * MB + 1);
    const fits = await intent(DAILY_UPLOAD_BYTES - 3900 * MB);
    const nowOver = await intent(1);

    expect(over.statusCode).toBe(429);
    expect(over.json()).toMatchObject({ error: { code: "RATE_LIMITED", message: expect.stringContaining("límite") } });
    expect(fits.statusCode).toBe(201);
    expect(nowOver.statusCode).toBe(429);
  });

  it("exempts admins from the byte budget", async () => {
    const { app } = await setup();
    const cuencada = await createCuencada();
    const { user, auth } = await createMember({ role: "admin" });
    const base = { cuencadaId: cuencada.id, uploadedByUserId: user.id, kind: "video", mimeType: "video/mp4", byteSize: 300 * MB } as const;
    for (let index = 0; index < 14; index += 1) await insertMedia({ ...base }); // 4200 MB, over the member budget

    const response = await app.inject({
      method: "POST",
      url: "/api/cuencadas/2026/media/uploads",
      ...auth,
      payload: { fileName: "a.mp4", mimeType: "video/mp4", byteSize: 300 * MB }
    });

    expect(response.statusCode).toBe(201);
  });
});

describe("logging", () => {
  it("never logs object keys, presigned URLs, captions or report details", async () => {
    const lines: string[] = [];
    const storage = new FakeStorage();
    app = await createTestApp({ storage, logStream: { write: (line) => lines.push(line) } });
    await createCuencada();
    const owner = await createMember();
    const other = await createMember();

    const good = await uploadMedia(app, storage, owner.auth, await makeJpegWithGps(), { caption: "Pie de foto privado" });
    await uploadMedia(app, storage, owner.auth, Buffer.from("texto"), { fileName: "secreto.jpg" });
    await uploadMedia(app, storage, owner.auth, makeDecompressionBombPng(), { mimeType: "image/png" });
    await app.inject({ method: "GET", url: "/api/cuencadas/2026/media", ...owner.auth });
    const report = await app.inject({
      method: "POST",
      url: `/api/media/${good.mediaId}/report`,
      ...other.auth,
      payload: { reason: "privacy", details: "Detalle privado del reporte" }
    });
    const removed = await app.inject({ method: "DELETE", url: `/api/media/${good.mediaId}`, ...owner.auth });

    expect(good.confirmStatus).toBe(200);
    expect(report.statusCode).toBe(204);
    expect(removed.statusCode).toBe(204);

    const output = lines.join("\n");
    expect(output).toContain("media upload rejected");
    expect(output).toContain("media processing failed");
    for (const secret of ["/originals/", "/thumbs/", "/display/", "fake-storage.test", "X-Fake-Signature", "Pie de foto", "Detalle privado", "secreto.jpg"]) {
      expect(output).not.toContain(secret);
    }
  });
});
