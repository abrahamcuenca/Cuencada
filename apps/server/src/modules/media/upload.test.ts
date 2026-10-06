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
  makePng,
  makeWebp,
  uploadMedia
} from "../../../test/helpers/media.js";
import type { App } from "../../app.js";
import { auditLogs, mediaItems } from "../../db/schema/index.js";
import { systemClock } from "../../lib/clock.js";
import { S3Storage } from "../../lib/storage/s3.js";
import { DERIVATIVE_CACHE_CONTROL, UPLOAD_URL_SECONDS } from "./constants.js";

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

  it("marks a video ready without transcoding and reads its duration", async () => {
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
      displayKey: mp4Row.objectKey,
      durationSeconds: 42
    });
    expect(mp4Row.objectKey).toBe(`cuencadas/2026/originals/${mp4.mediaId}.mp4`);
    expect(await mediaRow(mov.mediaId)).toMatchObject({ uploadStatus: "ready", durationSeconds: 7 });
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
    expect(result.confirmBody).toMatchObject({ error: { code: "UPLOAD_INVALID" } });
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
    expect(response.json()).toMatchObject({ error: { code: "UPLOAD_INVALID" } });
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
    expect([...storage.objects.keys()].filter((key) => !key.includes("/originals/"))).toEqual([]);
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
    expect([...storage.objects.keys()].filter((key) => !key.includes("/originals/"))).toEqual([]);
  });
});

describe("startup re-enqueue", () => {
  it("processes items left in processing when the app starts", async () => {
    const storage = new FakeStorage();
    const cuencada = await createCuencada();
    const png = await makePng();
    const stuck = await insertMedia({
      cuencadaId: cuencada.id,
      mimeType: "image/png",
      byteSize: png.byteLength,
      thumbKey: null,
      displayKey: null,
      width: null,
      height: null,
      uploadStatus: "processing"
    });
    await storage.put({ key: stuck.objectKey, body: png, contentType: "image/png" });
    const deleted = await insertMedia({ cuencadaId: cuencada.id, uploadStatus: "processing", deletedAt: new Date() });

    app = await createTestApp({ storage });

    await vi.waitFor(async () => expect((await mediaRow(stuck.id)).uploadStatus).toBe("ready"), { timeout: 5000 });
    await app.jobs.onIdle();
    expect(await mediaRow(stuck.id)).toMatchObject({ uploadStatus: "ready", width: 40, height: 30 });
    expect((await mediaRow(deleted.id)).uploadStatus).toBe("processing");
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
