import { crc32, deflateSync } from "node:zlib";
import type { AvatarUploadResponse, OwnProfile } from "@cuencada/types";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import { type MutableClock, mutableClock } from "../../../test/helpers/cuencadas.js";
import { getTestDb } from "../../../test/helpers/db.js";
import {
  type AuthInjectOptions,
  bearerFor,
  createSession,
  createUser,
  type CreateUserOptions,
  type TestUser
} from "../../../test/helpers/factories.js";
import { FakeStorage } from "../../../test/helpers/fakes.js";
import type { App } from "../../app.js";
import { auditLogs, avatarUploads, profiles } from "../../db/schema/index.js";
import {
  avatarKeys,
  avatarProcessingSlots,
  avatarSignatureMatches,
  avatarUrlFor,
  derivativeKeysFor,
  normalizeContentType,
  processAvatar,
  sniffAvatarType
} from "./avatar.js";
import { AVATAR_MAX_INPUT_PIXELS, AVATAR_PROCESSING_CONCURRENCY } from "./constants.js";

let app: App;
let storage: FakeStorage;
let clock: MutableClock;
let logs: string[];

beforeEach(async () => {
  storage = new FakeStorage();
  clock = mutableClock(new Date().toISOString());
  logs = [];
  app = await createTestApp({
    storage,
    clock,
    logStream: { write: (line) => logs.push(line) }
  });
});

afterEach(async () => {
  await app.close();
});

async function member(options: CreateUserOptions = {}): Promise<{ user: TestUser; auth: AuthInjectOptions }> {
  const user = await createUser({ emailVerified: true, ...options });
  return { user, auth: await bearerFor(user, await createSession(user.id)) };
}

function errorCode(body: string): string {
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
    const error: unknown = parsed.error;
    if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string")
      return error.code;
  }
  return "";
}

/**
 * A landscape JPEG, red on the left and blue on the right, tagged with EXIF
 * orientation 6: displayed upright it is a portrait with red on top.
 */
async function orientedJpeg(): Promise<Buffer> {
  const half = (color: string) =>
    sharp({
      create: { width: 100, height: 100, channels: 3, background: color }
    })
      .png()
      .toBuffer();
  return sharp({
    create: { width: 200, height: 100, channels: 3, background: "#000" }
  })
    .composite([
      { input: await half("#ff0000"), left: 0, top: 0 },
      { input: await half("#0000ff"), left: 100, top: 0 }
    ])
    .withMetadata({ orientation: 6 })
    .jpeg({ quality: 95 })
    .toBuffer();
}

/** A JPEG with EXIF orientation 6 (rotate 90°), a camera make and GPS coordinates. */
async function jpegWithGps(width = 120, height = 60): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: "#0b5e55" }
  })
    .withMetadata({ orientation: 6 })
    .withExif({
      IFD0: { Make: "SecretCam", Copyright: "Familia Morales" },
      IFD3: {
        GPSLatitudeRef: "N",
        GPSLatitude: "20/1 58/1 0/1",
        GPSLongitudeRef: "W",
        GPSLongitude: "89/1 37/1 0/1"
      }
    })
    .jpeg()
    .toBuffer();
}

async function png(width = 300, height = 200): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 4, background: "#e7b84b" }
  })
    .png()
    .toBuffer();
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

/** A tiny PNG whose header claims 10000×10000 (100 MP), above the 50 MP guard. */
function decompressionBombPng(side = 10_000): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header[8] = 8;
  header[9] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.alloc(side + 1))),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

async function createIntent(
  auth: AuthInjectOptions,
  mimeType: string,
  byteSize: number
): Promise<AvatarUploadResponse> {
  const response = await app.inject({
    method: "POST",
    url: "/api/profile/me/avatar/uploads",
    ...auth,
    payload: { mimeType, byteSize }
  });
  expect(response.statusCode).toBe(201);
  return response.json<AvatarUploadResponse>();
}

async function objectKeyOf(uploadId: string): Promise<string> {
  const [row] = await getTestDb().select().from(avatarUploads).where(eq(avatarUploads.id, uploadId));
  if (row === undefined) throw new Error("no upload row");
  return row.objectKey;
}

/** Intent → simulated browser PUT → confirm. */
async function uploadAvatar(
  auth: AuthInjectOptions,
  body: Buffer,
  mimeType = "image/jpeg",
  storedType = mimeType
): Promise<{
  intent: AvatarUploadResponse;
  confirm: Awaited<ReturnType<App["inject"]>>;
}> {
  const intent = await createIntent(auth, mimeType, body.byteLength);
  await storage.simulateUpload(await objectKeyOf(intent.uploadId), body, storedType);
  const confirm = await app.inject({
    method: "POST",
    url: "/api/profile/me/avatar/confirm",
    ...auth,
    payload: { uploadId: intent.uploadId }
  });
  return { intent, confirm };
}

function storedObject(key: string): Uint8Array {
  const object = storage.objects.get(key);
  if (object === undefined) throw new Error(`missing object ${key}`);
  return object.body;
}

describe("avatar helpers", () => {
  const userId = "1b2c3d4e-5f60-4b7c-9d8e-0f1a2b3c4d5e";
  const uploadId = "2c3d4e5f-6071-4c8d-9e0f-1a2b3c4d5e6f";

  it("builds server-side keys and derives the 64 px key from the stored 256 px key", () => {
    const keys = avatarKeys(userId, uploadId, "image/png");
    expect(keys).toEqual({
      original: `avatars/${userId}/${uploadId}.png`,
      large: `avatars/${userId}/${uploadId}-256.webp`,
      small: `avatars/${userId}/${uploadId}-64.webp`
    });
    expect(derivativeKeysFor(keys.large)).toEqual({
      large: keys.large,
      small: keys.small
    });
  });

  it("refuses keys it did not write (legacy URLs, originals, traversal)", () => {
    for (const value of [
      null,
      "https://example.com/foto.jpg",
      `avatars/${userId}/${uploadId}.jpg`,
      `avatars/../cuencadas/${uploadId}-256.webp`,
      `cuencadas/2026/thumbs/${uploadId}-256.webp`
    ]) {
      expect(derivativeKeysFor(value)).toBeNull();
    }
  });

  it("sniffs JPEG, PNG and WebP signatures and rejects others", async () => {
    expect(sniffAvatarType(await jpegWithGps())).toBe("image/jpeg");
    expect(sniffAvatarType(await png())).toBe("image/png");
    expect(
      sniffAvatarType(
        await sharp({
          create: { width: 4, height: 4, channels: 3, background: "#fff" }
        })
          .webp()
          .toBuffer()
      )
    ).toBe("image/webp");
    expect(sniffAvatarType(Buffer.from("GIF89a......"))).toBeNull();
    expect(sniffAvatarType(new Uint8Array())).toBeNull();
    expect(avatarSignatureMatches("image/png", await jpegWithGps())).toBe(false);
    expect(normalizeContentType("Image/JPEG; charset=binary")).toBe("image/jpeg");
  });

  it("refuses images above ~24 MP before decoding them, and decodes those just below", async () => {
    expect(AVATAR_MAX_INPUT_PIXELS).toBe(24_000_000);
    // 5000² = 25 MP: refused from the header alone.
    expect(await processAvatar(decompressionBombPng(5_000), "image/png")).toEqual({
      ok: false,
      failure: "pixel_limit_exceeded"
    });
    // 4800² = 23 MP: passes the limit, then fails as a truncated image (not the pixel limit).
    expect(await processAvatar(decompressionBombPng(4_800), "image/png")).toEqual({
      ok: false,
      failure: "decode_failed"
    });
  });

  it("encodes both sizes from one decode as square WebPs without metadata", async () => {
    const result = await processAvatar(await jpegWithGps(), "image/jpeg");
    if (!result.ok) throw new Error(`processing failed: ${result.failure}`);
    const large = await sharp(result.avatar.large).metadata();
    const small = await sharp(result.avatar.small).metadata();
    expect([large.format, large.width, large.height, large.exif]).toEqual(["webp", 256, 256, undefined]);
    expect([small.format, small.width, small.height, small.exif]).toEqual(["webp", 64, 64, undefined]);
  });

  it("processes at most two avatars at a time and queues the rest", async () => {
    const input = await png(64, 64);
    expect(AVATAR_PROCESSING_CONCURRENCY).toBe(2);
    const runs = Array.from({ length: 5 }, () => processAvatar(input, "image/png"));
    expect(avatarProcessingSlots.active).toBe(2);
    expect(avatarProcessingSlots.waiting).toBe(3);
    const results = await Promise.all(runs);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(avatarProcessingSlots.active).toBe(0);
    expect(avatarProcessingSlots.waiting).toBe(0);
  });

  it("presigns a 1 h GET and degrades to null when storage fails", async () => {
    const key = avatarKeys(userId, uploadId, "image/jpeg").large;
    const warnings: unknown[] = [];
    const ok = await avatarUrlFor({ storage, log: { warn: (...args: unknown[]) => warnings.push(args) } }, key);
    const url = new URL(ok ?? "");
    expect(url.pathname).toContain(`${uploadId}-256.webp`);
    const expiresAt = Number(url.searchParams.get("X-Fake-Expires"));
    expect(expiresAt - Date.now()).toBeGreaterThan(59 * 60 * 1000);
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(60 * 60 * 1000);
    expect(await avatarUrlFor({ storage, log: { warn: () => undefined } }, key, 64)).toContain("-64.webp");

    const failing = {
      presignGet: async (): Promise<never> => {
        throw new Error(`boom ${key}`);
      }
    };
    expect(
      await avatarUrlFor(
        {
          storage: failing,
          log: { warn: (...args: unknown[]) => warnings.push(args) }
        },
        key
      )
    ).toBeNull();
    expect(JSON.stringify(warnings)).not.toContain(key);
  });
});

describe("POST /api/profile/me/avatar/uploads", () => {
  it("creates an intent with a server-chosen key and a PUT bound to type and length", async () => {
    const { user, auth } = await member();

    const intent = await createIntent(auth, "image/png", 12_345);

    const [row] = await getTestDb().select().from(avatarUploads).where(eq(avatarUploads.id, intent.uploadId));
    expect(row).toMatchObject({
      userId: user.id,
      mimeType: "image/png",
      byteSize: 12_345,
      confirmedAt: null
    });
    expect(row?.objectKey).toBe(`avatars/${user.id}/${intent.uploadId}.png`);
    expect(row?.expiresAt.toISOString()).toBe(intent.expiresAt);
    expect(new Date(intent.expiresAt).getTime() - clock.now().getTime()).toBe(5 * 60 * 1000);
    expect(intent.headers).toEqual({ "Content-Type": "image/png" });
    expect(storage.presignedPuts.at(-1)).toMatchObject({
      key: row?.objectKey,
      contentType: "image/png",
      contentLength: 12_345,
      signed: { contentType: "image/png", contentLength: 12_345 }
    });
  });

  it.each([
    ["a GIF", { mimeType: "image/gif", byteSize: 100 }],
    ["a video", { mimeType: "video/mp4", byteSize: 100 }],
    ["more than 10 MB", { mimeType: "image/jpeg", byteSize: 10 * 1024 * 1024 + 1 }],
    ["an empty file", { mimeType: "image/jpeg", byteSize: 0 }]
  ])("rejects %s with 400", async (_label, payload) => {
    const { auth } = await member();
    const response = await app.inject({
      method: "POST",
      url: "/api/profile/me/avatar/uploads",
      ...auth,
      payload
    });
    expect(response.statusCode).toBe(400);
    expect(errorCode(response.body)).toBe("VALIDATION");
  });

  it("ignores a client-supplied key or user id: the key is always server-chosen", async () => {
    const { user, auth } = await member();
    const victim = await member();
    const response = await app.inject({
      method: "POST",
      url: "/api/profile/me/avatar/uploads",
      ...auth,
      payload: {
        mimeType: "image/jpeg",
        byteSize: 10,
        objectKey: `avatars/${victim.user.id}/x.jpg`,
        userId: victim.user.id
      }
    });
    expect(response.statusCode).toBe(201);
    const [row] = await getTestDb().select().from(avatarUploads);
    expect(row?.userId).toBe(user.id);
    expect(row?.objectKey.startsWith(`avatars/${user.id}/`)).toBe(true);
  });

  it("answers 401 without a token and 403 while a password change is pending", async () => {
    const { auth } = await member({ mustChangePassword: true });
    const payload = { mimeType: "image/jpeg", byteSize: 10 };
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/profile/me/avatar/uploads",
          payload
        })
      ).statusCode
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/profile/me/avatar/uploads",
          ...auth,
          payload
        })
      ).statusCode
    ).toBe(403);
  });

  it("caps open intents at 5 and intents at 10 per hour per user", async () => {
    const { auth } = await member();
    const other = await member();
    const payload = { mimeType: "image/jpeg", byteSize: 10 };
    const post = (headers: AuthInjectOptions) =>
      app.inject({
        method: "POST",
        url: "/api/profile/me/avatar/uploads",
        ...headers,
        payload
      });

    for (let index = 0; index < 5; index += 1) expect((await post(auth)).statusCode).toBe(201);
    const sixth = await post(auth);
    expect(sixth.statusCode).toBe(429);
    expect(errorCode(sixth.body)).toBe("RATE_LIMITED");

    clock.set(new Date(clock.now().getTime() + 10 * 60 * 1000).toISOString()); // the first five expired
    for (let index = 0; index < 4; index += 1) expect((await post(auth)).statusCode).toBe(201);
    const eleventh = await post(auth);
    expect(eleventh.statusCode).toBe(429);
    expect(eleventh.headers["retry-after"]).toBeDefined();
    expect((await post(other.auth)).statusCode).toBe(201);
  });
});

describe("POST /api/profile/me/avatar/confirm", () => {
  it("strips EXIF/GPS, auto-rotates, writes 256 and 64 px squares and deletes the original", async () => {
    const { user, auth } = await member();
    const original = await jpegWithGps(120, 60);
    expect((await sharp(original).metadata()).exif).toBeDefined();

    const { intent, confirm } = await uploadAvatar(auth, original);

    expect(confirm.statusCode).toBe(200);
    const body = confirm.json<OwnProfile>();
    const keys = avatarKeys(user.id, intent.uploadId, "image/jpeg");
    expect(body.avatarUrl).toContain(`${intent.uploadId}-256.webp`);
    expect(body.avatarUrl).toContain("X-Fake-Signature=get");

    const [profile] = await getTestDb().select().from(profiles).where(eq(profiles.userId, user.id));
    expect(profile?.avatarKey).toBe(keys.large);
    expect(storage.objects.has(keys.original)).toBe(false);

    for (const [key, size] of [
      [keys.large, 256],
      [keys.small, 64]
    ] as const) {
      const bytes = storedObject(key);
      const metadata = await sharp(bytes).metadata();
      expect(metadata).toMatchObject({
        format: "webp",
        width: size,
        height: size
      });
      expect(metadata.exif).toBeUndefined();
      expect(metadata.xmp).toBeUndefined();
      expect(metadata.iptc).toBeUndefined();
      expect(metadata.orientation).toBeUndefined();
      expect(Buffer.from(bytes).includes("SecretCam")).toBe(false);
      expect(storage.objects.get(key)?.contentType).toBe("image/webp");
    }

    const [upload] = await getTestDb().select().from(avatarUploads).where(eq(avatarUploads.id, intent.uploadId));
    expect(upload?.confirmedAt).not.toBeNull();
    expect(Buffer.from(storedObject(keys.large)).includes("Familia Morales")).toBe(false);
    const [audit] = await getTestDb().select().from(auditLogs).where(eq(auditLogs.action, "profile.avatar_updated"));
    expect(audit).toMatchObject({
      actorUserId: user.id,
      entityType: "profile",
      entityId: user.profile.id
    });
    expect(audit?.metadata).toEqual({
      fields: ["avatar"],
      uploadId: intent.uploadId,
      replaced: false
    });
  });

  it("applies the EXIF orientation before cropping", async () => {
    const { user, auth } = await member();
    const { intent, confirm } = await uploadAvatar(auth, await orientedJpeg());
    expect(confirm.statusCode).toBe(200);

    const { data, info } = await sharp(storedObject(avatarKeys(user.id, intent.uploadId, "image/jpeg").large))
      .raw()
      .toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => {
      const offset = (y * info.width + x) * info.channels;
      return { r: data[offset] ?? 0, b: data[offset + 2] ?? 0 };
    };
    expect(pixel(128, 20).r).toBeGreaterThan(200);
    expect(pixel(128, 20).b).toBeLessThan(60);
    expect(pixel(128, 235).b).toBeGreaterThan(200);
    expect(pixel(128, 235).r).toBeLessThan(60);
  });

  it("deletes the previous avatar's objects when it is replaced", async () => {
    const { user, auth } = await member();
    const first = await uploadAvatar(auth, await jpegWithGps());
    expect(first.confirm.statusCode).toBe(200);
    const firstKeys = avatarKeys(user.id, first.intent.uploadId, "image/jpeg");
    expect(storage.objects.has(firstKeys.large)).toBe(true);

    const second = await uploadAvatar(auth, await png(80, 400), "image/png");

    expect(second.confirm.statusCode).toBe(200);
    const secondKeys = avatarKeys(user.id, second.intent.uploadId, "image/png");
    expect(storage.objects.has(firstKeys.large)).toBe(false);
    expect(storage.objects.has(firstKeys.small)).toBe(false);
    expect(storage.objects.has(secondKeys.large)).toBe(true);
    expect(storage.objects.has(secondKeys.small)).toBe(true);
    expect([...storage.objects.keys()].sort()).toEqual([secondKeys.large, secondKeys.small].sort());
  });

  it("rejects a magic-byte mismatch: row and object deleted, audited, 400", async () => {
    const { user, auth } = await member();
    const jpeg = await jpegWithGps();

    const { intent, confirm } = await uploadAvatar(auth, jpeg, "image/png");

    expect(confirm.statusCode).toBe(400);
    expect(errorCode(confirm.body)).toBe("UPLOAD_INVALID");
    expect(await getTestDb().select().from(avatarUploads).where(eq(avatarUploads.id, intent.uploadId))).toHaveLength(0);
    expect(storage.objects.size).toBe(0);
    const [audit] = await getTestDb().select().from(auditLogs).where(eq(auditLogs.action, "profile.avatar_rejected"));
    expect(audit).toMatchObject({ actorUserId: user.id });
    expect(audit?.metadata).toEqual({
      uploadId: intent.uploadId,
      reason: "signature_mismatch"
    });
    const [profile] = await getTestDb().select().from(profiles).where(eq(profiles.userId, user.id));
    expect(profile?.avatarKey).toBeNull();
  });

  it("rejects text renamed as an image, a size mismatch and a wrong stored Content-Type", async () => {
    const { auth } = await member();
    const text = Buffer.from("esto no es una imagen, es texto plano con extension jpg");
    expect((await uploadAvatar(auth, text)).confirm.statusCode).toBe(400);

    const jpeg = await jpegWithGps();
    const intent = await createIntent(auth, "image/jpeg", jpeg.byteLength + 1);
    await storage.simulateUpload(await objectKeyOf(intent.uploadId), jpeg, "image/jpeg");
    const sized = await app.inject({
      method: "POST",
      url: "/api/profile/me/avatar/confirm",
      ...auth,
      payload: { uploadId: intent.uploadId }
    });
    expect(sized.statusCode).toBe(400);

    expect((await uploadAvatar(auth, jpeg, "image/jpeg", "text/html")).confirm.statusCode).toBe(400);
    const reasons = (
      await getTestDb().select().from(auditLogs).where(eq(auditLogs.action, "profile.avatar_rejected"))
    ).map(
      (row) => (row.metadata as { reason: string }).reason // metadata written by rejectUpload above
    );
    expect(reasons.sort()).toEqual(["content_type_mismatch", "signature_mismatch", "size_mismatch"]);
    expect(storage.objects.size).toBe(0);
  });

  it("rejects a decompression bomb without writing derivatives", async () => {
    const { auth } = await member();
    const { confirm } = await uploadAvatar(auth, decompressionBombPng(), "image/png");
    expect(confirm.statusCode).toBe(400);
    expect(errorCode(confirm.body)).toBe("UPLOAD_INVALID");
    expect(storage.objects.size).toBe(0);
    const [audit] = await getTestDb().select().from(auditLogs).where(eq(auditLogs.action, "profile.avatar_rejected"));
    expect(audit?.metadata).toMatchObject({ reason: "pixel_limit_exceeded" });
  });

  it("answers a retryable 400 while the object has not arrived, then accepts it", async () => {
    const { auth } = await member();
    const body = await png();
    const intent = await createIntent(auth, "image/png", body.byteLength);
    const confirm = () =>
      app.inject({
        method: "POST",
        url: "/api/profile/me/avatar/confirm",
        ...auth,
        payload: { uploadId: intent.uploadId }
      });

    const early = await confirm();
    expect(early.statusCode).toBe(400);
    expect(await getTestDb().select().from(avatarUploads).where(eq(avatarUploads.id, intent.uploadId))).toHaveLength(1);

    await storage.simulateUpload(await objectKeyOf(intent.uploadId), body, "image/png");
    expect((await confirm()).statusCode).toBe(200);
    const again = await confirm();
    expect(again.statusCode).toBe(200);
    expect(again.json<OwnProfile>().avatarUrl).toContain(intent.uploadId);
    expect(
      await getTestDb().select().from(auditLogs).where(eq(auditLogs.action, "profile.avatar_updated"))
    ).toHaveLength(1);
  });

  it("answers 400 once the upload is past the confirm grace", async () => {
    const { auth } = await member();
    const body = await png();
    const intent = await createIntent(auth, "image/png", body.byteLength);
    await storage.simulateUpload(await objectKeyOf(intent.uploadId), body, "image/png");
    // Move the intent back in time (moving the clock forward would expire the access token).
    await getTestDb()
      .update(avatarUploads)
      .set({ expiresAt: new Date(clock.now().getTime() - 61 * 60 * 1000) })
      .where(eq(avatarUploads.id, intent.uploadId));

    const response = await app.inject({
      method: "POST",
      url: "/api/profile/me/avatar/confirm",
      ...auth,
      payload: { uploadId: intent.uploadId }
    });

    expect(response.statusCode).toBe(400);
    expect(storage.objects.size).toBe(0);
  });

  it("answers 404 to anyone but the uploader, 400 for a malformed id and 401 without a token", async () => {
    const owner = await member();
    const intruder = await member();
    const body = await png();
    const intent = await createIntent(owner.auth, "image/png", body.byteLength);
    await storage.simulateUpload(await objectKeyOf(intent.uploadId), body, "image/png");

    const foreign = await app.inject({
      method: "POST",
      url: "/api/profile/me/avatar/confirm",
      ...intruder.auth,
      payload: { uploadId: intent.uploadId }
    });
    const malformed = await app.inject({
      method: "POST",
      url: "/api/profile/me/avatar/confirm",
      ...owner.auth,
      payload: { uploadId: "../../etc" }
    });
    const anonymous = await app.inject({
      method: "POST",
      url: "/api/profile/me/avatar/confirm",
      payload: { uploadId: intent.uploadId }
    });

    expect(foreign.statusCode).toBe(404);
    expect(malformed.statusCode).toBe(400);
    expect(anonymous.statusCode).toBe(401);
    const [ownerProfile] = await getTestDb().select().from(profiles).where(eq(profiles.userId, owner.user.id));
    const [intruderProfile] = await getTestDb().select().from(profiles).where(eq(profiles.userId, intruder.user.id));
    expect(ownerProfile?.avatarKey).toBeNull();
    expect(intruderProfile?.avatarKey).toBeNull();
  });

  it("returns null for a legacy avatar_key value instead of presigning it", async () => {
    const { auth } = await member({
      profile: {
        fullName: "Legado",
        avatarKey: "https://legacy.example.com/foto.jpg"
      }
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/profile/me",
      ...auth
    });
    expect(response.json<OwnProfile>().avatarUrl).toBeNull();
  });

  it("logs no object keys, presigned URLs or EXIF data", async () => {
    const { auth } = await member();
    await uploadAvatar(auth, await jpegWithGps());
    await uploadAvatar(auth, await jpegWithGps(), "image/png");

    const output = logs.join("\n");
    expect(output).not.toContain("avatars/");
    expect(output).not.toContain("fake-storage");
    expect(output).not.toContain("SecretCam");
  });
});

describe("DELETE /api/profile/me/avatar", () => {
  it("clears the avatar, deletes both objects and audits", async () => {
    const { user, auth } = await member();
    const { intent } = await uploadAvatar(auth, await png(), "image/png");
    const keys = avatarKeys(user.id, intent.uploadId, "image/png");

    const response = await app.inject({
      method: "DELETE",
      url: "/api/profile/me/avatar",
      ...auth
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<OwnProfile>().avatarUrl).toBeNull();
    expect(storage.objects.has(keys.large)).toBe(false);
    expect(storage.objects.has(keys.small)).toBe(false);
    expect(
      await getTestDb().select().from(auditLogs).where(eq(auditLogs.action, "profile.avatar_removed"))
    ).toHaveLength(1);

    const repeat = await app.inject({
      method: "DELETE",
      url: "/api/profile/me/avatar",
      ...auth
    });
    expect(repeat.statusCode).toBe(200);
    expect(
      await getTestDb().select().from(auditLogs).where(eq(auditLogs.action, "profile.avatar_removed"))
    ).toHaveLength(1);
  });

  it("answers 401 without a token", async () => {
    expect((await app.inject({ method: "DELETE", url: "/api/profile/me/avatar" })).statusCode).toBe(401);
  });
});
