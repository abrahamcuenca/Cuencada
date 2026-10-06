/**
 * Test fixtures for the media module (T4): Cuencada rows, real tiny images
 * generated with sharp, hand-built MP4/QuickTime headers, a decompression
 * bomb, and an end-to-end upload helper over `FakeStorage`.
 */
import { randomUUID } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import type { MediaMimeType } from "@cuencada/types";
import sharp from "sharp";
import type { App } from "../../src/app.js";
import { cuencadas, mediaItems } from "../../src/db/schema/index.js";
import { getTestDb } from "./db.js";
import { type AuthInjectOptions, bearerFor, createSession, createUser, type TestUser } from "./factories.js";
import type { FakeStorage } from "./fakes.js";

type CuencadaRow = typeof cuencadas.$inferSelect;
type MediaInsert = typeof mediaItems.$inferInsert;
type MediaRow = typeof mediaItems.$inferSelect;

/** Insert a Cuencada (published by default). */
export async function createCuencada(options: { year?: number; isPublished?: boolean } = {}): Promise<CuencadaRow> {
  const year = options.year ?? 2026;
  const [row] = await getTestDb()
    .insert(cuencadas)
    .values({
      year,
      slug: String(year),
      title: `Cuencada ${year}`,
      startsAt: new Date(`${year}-12-26T12:00:00Z`),
      endsAt: new Date(`${year}-12-30T12:00:00Z`),
      city: "Mérida",
      state: "Yucatán",
      description: "Reunión familiar",
      isPublished: options.isPublished ?? true
    })
    .returning();
  if (row === undefined) throw new Error("createCuencada: no row");
  return row;
}

/** A user plus bearer headers (no login round trip, so no login rate limits). */
export interface Member {
  user: TestUser;
  auth: AuthInjectOptions;
}

/** Create a user and sign a token for a fresh session. */
export async function createMember(options: Parameters<typeof createUser>[0] = {}): Promise<Member> {
  const user = await createUser({ emailVerified: true, ...options });
  return { user, auth: await bearerFor(user, await createSession(user.id)) };
}

/** A JPEG with EXIF orientation 6 (rotate 90°), camera make and GPS coordinates. */
export async function makeJpegWithGps(width = 64, height = 32): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: "#0b5e55" } })
    .withMetadata({ orientation: 6 })
    .withExif({
      IFD0: { Make: "SecretCam", Copyright: "Familia Cuenca" },
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "20/1 58/1 0/1", GPSLongitudeRef: "W", GPSLongitude: "89/1 37/1 0/1" }
    })
    .jpeg()
    .toBuffer();
}

/** A small PNG. */
export async function makePng(width = 40, height = 30): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: "#e7b84b" } }).png().toBuffer();
}

/** A WebP large enough that both derivatives are downscaled. */
export async function makeWebp(width = 2000, height = 1000): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: "#fffaf0" } }).webp().toBuffer();
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

/**
 * A ~100 byte PNG whose header claims 10000×10000 (100 MP): above the 50 MP
 * guard but below sharp's own default limit, so only our limit stops it.
 */
export function makeDecompressionBombPng(side = 10_000): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // greyscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.alloc(side + 1))),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function box(type: string, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat(payload);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length + 8);
  return Buffer.concat([size, Buffer.from(type, "latin1"), body]);
}

/**
 * Minimal ISO-BMFF file: `ftyp` (major brand) + `moov/mvhd` (v0) + `mdat`.
 *
 * @param brand - Four-character major brand (`isom`, `qt  `, …).
 * @param durationSeconds - Written as `duration / timescale` with timescale 600.
 */
export function makeMp4(brand = "isom", durationSeconds = 42): Buffer {
  const ftyp = box("ftyp", Buffer.from(brand, "latin1"), Buffer.alloc(4), Buffer.from(`${brand}mp41`, "latin1"));
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(600, 12); // timescale (after version/flags + creation + modification)
  mvhd.writeUInt32BE(durationSeconds * 600, 16);
  return Buffer.concat([ftyp, box("moov", box("mvhd", mvhd)), box("mdat", Buffer.alloc(256, 7))]);
}

/** The original object key in an upload URL (FakeStorage URLs embed the key). */
export function keyFromFakeUrl(url: string): string {
  return decodeURIComponent(new URL(url).pathname.slice(1));
}

/** Options for {@link uploadMedia}. */
export interface UploadOptions {
  year?: number;
  mimeType?: MediaMimeType;
  /** Declared size; defaults to the body length. */
  byteSize?: number;
  /** Content type the "browser" stores; defaults to `mimeType`. */
  storedContentType?: string;
  fileName?: string;
  caption?: string | null;
  /** Skip the confirm call. */
  confirm?: boolean;
}

/** Result of {@link uploadMedia}. */
export interface UploadResult {
  mediaId: string;
  key: string;
  confirmStatus: number | null;
  confirmBody: unknown;
}

/**
 * Run intent → simulated browser PUT → confirm, then wait for the job queue.
 *
 * @param app - Test app.
 * @param storage - The app's FakeStorage.
 * @param auth - Uploader's headers.
 * @param body - File bytes.
 */
export async function uploadMedia(
  app: App,
  storage: FakeStorage,
  auth: AuthInjectOptions,
  body: Uint8Array,
  options: UploadOptions = {}
): Promise<UploadResult> {
  const mimeType = options.mimeType ?? "image/jpeg";
  const intent = await app.inject({
    method: "POST",
    url: `/api/cuencadas/${options.year ?? 2026}/media/uploads`,
    ...auth,
    payload: {
      fileName: options.fileName ?? "IMG_0001.JPG",
      mimeType,
      byteSize: options.byteSize ?? body.byteLength,
      caption: options.caption ?? null
    }
  });
  if (intent.statusCode !== 201) throw new Error(`uploadMedia: intent failed ${intent.statusCode} ${intent.body}`);
  const { mediaId, uploadUrl } = intent.json<{ mediaId: string; uploadUrl: string }>();
  const key = keyFromFakeUrl(uploadUrl);
  await storage.simulateUpload(key, body, options.storedContentType ?? mimeType);
  if (options.confirm === false) return { mediaId, key, confirmStatus: null, confirmBody: null };
  const confirm = await app.inject({ method: "POST", url: `/api/media/${mediaId}/confirm`, ...auth });
  await app.jobs.onIdle();
  return { mediaId, key, confirmStatus: confirm.statusCode, confirmBody: confirm.json() };
}

/** Insert a media row directly (list/visibility/pagination tests). */
export async function insertMedia(
  values: Partial<MediaInsert> & Pick<MediaInsert, "cuencadaId">
): Promise<MediaRow> {
  const id = values.id ?? randomUUID();
  const [row] = await getTestDb()
    .insert(mediaItems)
    .values({
      id,
      kind: "image",
      objectKey: `cuencadas/2026/originals/${id}.jpg`,
      thumbKey: `cuencadas/2026/thumbs/${id}.webp`,
      displayKey: `cuencadas/2026/display/${id}.webp`,
      bucket: "test-bucket",
      fileName: "foto.jpg",
      mimeType: "image/jpeg",
      byteSize: 1000,
      width: 1600,
      height: 1200,
      uploadStatus: "ready",
      moderationStatus: "approved",
      ...values
    })
    .returning();
  if (row === undefined) throw new Error("insertMedia: no row");
  return row;
}
