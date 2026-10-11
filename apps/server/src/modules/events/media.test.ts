/**
 * Event-album media (WP-5.3, ADR 0001 §7, Security requirements 1, 7, 10,
 * 12) [SEC]: the upload intent and confirm under `events/{eventId}/{albumId}`,
 * the processing job and the cleanup sweep on that prefix, `mediaScopeSql`
 * on every by-id route, the shared locked daily budget and the admin
 * moderation list.
 */
import { mediaItemSchema, pageSchema } from "@cuencada/types";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { callAs, errorOf, type EventActor, eventActor, insertAlbumMedia, insertEvent } from "../../../test/helpers/events.js";
import { FakeStorage } from "../../../test/helpers/fakes.js";
import { createCuencada, insertMedia, keyFromFakeUrl, makeJpegWithGps } from "../../../test/helpers/media.js";
import type { App } from "../../app.js";
import { mediaItems } from "../../db/schema/index.js";
import { SWEEP_MIN_AGE_MS } from "../media/constants.js";
import { runMediaCleanup } from "../media/jobs/mediaCleanup.js";

let app: App;
let storage: FakeStorage;

beforeEach(async () => {
  storage = new FakeStorage();
  app = await createTestApp({ storage });
});

afterEach(async () => {
  await app.jobs.onIdle();
  await app.close();
});

const mediaPage = pageSchema(mediaItemSchema);

async function uploadToAlbum(actor: EventActor, eventId: string, albumId: string, body: Buffer): Promise<{ mediaId: string; key: string }> {
  const intent = await callAs(app, actor, "POST", `/api/events/${eventId}/albums/${albumId}/uploads`, {
    fileName: "IMG_0001.JPG",
    mimeType: "image/jpeg",
    byteSize: body.byteLength
  });
  expect(intent.statusCode, intent.body).toBe(201);
  const { mediaId, uploadUrl } = intent.json<{ mediaId: string; uploadUrl: string }>();
  const key = keyFromFakeUrl(uploadUrl);
  await storage.simulateUpload(key, body, "image/jpeg");
  return { mediaId, key };
}

describe("album uploads", () => {
  it("stores keys under the album prefix, processes them there and lists them with album and event refs", async () => {
    const ana = await eventActor();
    const { event, album } = await insertEvent({ title: "Viaje a CDMX", organizerId: ana.user.id });
    const { mediaId, key } = await uploadToAlbum(ana, event.id, album.id, await makeJpegWithGps());
    const prefix = `events/${event.id}/${album.id}`;
    expect(key).toBe(`${prefix}/originals/${mediaId}.jpg`);
    const confirm = await callAs(app, ana, "POST", `/api/media/${mediaId}/confirm`, {});
    expect(confirm.statusCode, confirm.body).toBe(200);
    await app.jobs.onIdle();

    const [row] = await getTestDb().select().from(mediaItems).where(eq(mediaItems.id, mediaId));
    expect(row).toMatchObject({
      uploadStatus: "ready",
      cuencadaId: null,
      albumId: album.id,
      storagePrefix: prefix,
      thumbKey: `${prefix}/thumbs/${mediaId}.webp`,
      displayKey: `${prefix}/display/${mediaId}.webp`
    });
    expect(storage.objects.has(key)).toBe(false);

    const listed = mediaPage.parse((await callAs(app, ana, "GET", `/api/events/${event.id}/albums/${album.id}/media`)).json());
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({
      id: mediaId,
      year: null,
      cuencadaId: null,
      album: { id: album.id, eventId: event.id, title: "Fotos" },
      event: { id: event.id, title: "Viaje a CDMX" }
    });
  });

  it("refuses a confirm whose keys do not sit under the row's prefix (prefix_mismatch)", async () => {
    const ana = await eventActor();
    const { event, album } = await insertEvent({ organizerId: ana.user.id });
    const other = await insertEvent({ organizerId: ana.user.id });
    const row = await insertAlbumMedia(album, {
      uploadedByUserId: ana.user.id,
      uploadStatus: "pending_upload",
      objectKey: `events/${other.event.id}/${other.album.id}/originals/planted.jpg`,
      thumbKey: null,
      displayKey: null
    });
    const response = await callAs(app, ana, "POST", `/api/media/${row.id}/confirm`, {});
    expect(response.statusCode).toBe(400);
    expect(errorOf(response.body).code).toBe("UPLOAD_INVALID");
    const [after] = await getTestDb().select().from(mediaItems).where(eq(mediaItems.id, row.id));
    expect(after?.uploadStatus).toBe("failed");
    expect(after?.processingError).toBe("prefix_mismatch");
    void event;
  });

  it("re-checks participation at confirm: a removed uploader gets 404", async () => {
    const ana = await eventActor();
    const bea = await eventActor();
    const { event, album } = await insertEvent({ organizerId: ana.user.id, participantIds: [bea.user.id] });
    const { mediaId } = await uploadToAlbum(bea, event.id, album.id, await makeJpegWithGps());
    expect((await callAs(app, ana, "DELETE", `/api/events/${event.id}/participants/${bea.user.id}`)).statusCode).toBe(200);
    expect((await callAs(app, bea, "POST", `/api/media/${mediaId}/confirm`, {})).statusCode).toBe(404);
    const refused = await callAs(app, bea, "POST", `/api/events/${event.id}/albums/${album.id}/uploads`, {
      fileName: "a.jpg",
      mimeType: "image/jpeg",
      byteSize: 10
    });
    expect(errorOf(refused.body).detailCode).toBe("EVENT_NOT_PARTICIPANT");
  });

  it("shares the locked daily budget with edition uploads (Security requirement 12)", async () => {
    const ana = await eventActor();
    const { event, album } = await insertEvent({ organizerId: ana.user.id });
    const edition = await createCuencada({ year: 2100 });
    const big = 300 * 1024 * 1024;
    // 14 × 300 MB of album media today: the edition intent is over the shared budget.
    for (let index = 0; index < 14; index += 1) await insertAlbumMedia(album, { uploadedByUserId: ana.user.id, byteSize: big });
    const editionIntent = await callAs(app, ana, "POST", `/api/cuencadas/${edition.year}/media/uploads`, {
      fileName: "a.jpg",
      mimeType: "image/jpeg",
      byteSize: 1000
    });
    expect(editionIntent.statusCode).toBe(429);
    const albumIntent = await callAs(app, ana, "POST", `/api/events/${event.id}/albums/${album.id}/uploads`, {
      fileName: "a.jpg",
      mimeType: "image/jpeg",
      byteSize: 1000
    });
    expect(albumIntent.statusCode).toBe(429);
  });
});

describe("media by id (mediaScopeSql)", () => {
  it("answers 404 on every by-id route to a non-participant, and to a participant once the event is hidden", async () => {
    const ana = await eventActor();
    const outsider = await eventActor();
    const bea = await eventActor();
    const { event, album } = await insertEvent({ visibility: "participants", organizerId: ana.user.id, participantIds: [bea.user.id] });
    const items = await Promise.all([1, 2, 3, 4, 5].map(() => insertAlbumMedia(album, { uploadedByUserId: ana.user.id })));
    const pending = await insertAlbumMedia(album, { uploadedByUserId: outsider.user.id, uploadStatus: "pending_upload" });
    const probe = async (actor: EventActor, id: string): Promise<number[]> => [
      (await callAs(app, actor, "GET", `/api/media/${id}`)).statusCode,
      (await callAs(app, actor, "PATCH", `/api/media/${id}`, { caption: "Mía" })).statusCode,
      (await callAs(app, actor, "POST", `/api/media/${id}/report`, { reason: "other" })).statusCode
    ];
    const [one, two] = items;
    if (one === undefined || two === undefined) throw new Error("fixtures");
    expect(await probe(outsider, one.id)).toEqual([404, 404, 404]);
    expect((await callAs(app, outsider, "DELETE", `/api/media/${one.id}`)).statusCode).toBe(404);
    // Even the outsider's own (planted) row in someone else's album cannot be confirmed or deleted.
    expect((await callAs(app, outsider, "POST", `/api/media/${pending.id}/confirm`, {})).statusCode).toBe(404);
    expect((await callAs(app, outsider, "DELETE", `/api/media/${pending.id}`)).statusCode).toBe(404);
    const [unchanged] = await getTestDb().select().from(mediaItems).where(eq(mediaItems.id, one.id));
    expect(unchanged?.caption).toBeNull();
    expect(unchanged?.deletedAt).toBeNull();

    expect((await callAs(app, bea, "GET", `/api/media/${one.id}`)).statusCode).toBe(200);
    expect((await callAs(app, bea, "POST", `/api/media/${two.id}/report`, { reason: "other" })).statusCode).toBe(204);
    const admin = await eventActor({ role: "admin" });
    expect((await callAs(app, admin, "PATCH", `/api/events/${event.id}`, { status: "hidden" })).statusCode).toBe(200);
    expect((await callAs(app, bea, "GET", `/api/media/${one.id}`)).statusCode).toBe(404);
    expect((await callAs(app, admin, "GET", `/api/media/${one.id}`)).statusCode).toBe(200);
  });
});

describe("GET /api/admin/media (Security requirement 10)", () => {
  it("lists album media in the moderation queue and filters by eventId", async () => {
    const admin = await eventActor({ role: "admin" });
    const ana = await eventActor();
    const edition = await createCuencada({ year: 2100 });
    const editionItem = await insertMedia({ cuencadaId: edition.id, uploadedByUserId: ana.user.id });
    const first = await insertEvent({ visibility: "participants", organizerId: ana.user.id });
    const second = await insertEvent({ organizerId: ana.user.id });
    const albumItem = await insertAlbumMedia(first.album, { uploadedByUserId: ana.user.id });
    await insertAlbumMedia(second.album, { uploadedByUserId: ana.user.id });

    const all = (await callAs(app, admin, "GET", "/api/admin/media")).json<{ items: Array<{ id: string }> }>();
    expect(all.items.map((item) => item.id)).toEqual(expect.arrayContaining([editionItem.id, albumItem.id]));
    expect(all.items).toHaveLength(3);
    const filtered = (await callAs(app, admin, "GET", `/api/admin/media?eventId=${first.event.id}`)).json<{
      items: Array<{ id: string; event: { id: string } | null }>;
    }>();
    expect(filtered.items.map((item) => item.id)).toEqual([albumItem.id]);
    expect(filtered.items[0]?.event?.id).toBe(first.event.id);
  });
});

describe("media cleanup on the events/ prefix", () => {
  it("sweeps the objects of deleted album media", async () => {
    const ana = await eventActor();
    const { album } = await insertEvent({ organizerId: ana.user.id });
    const now = new Date();
    const row = await insertAlbumMedia(album, { uploadedByUserId: ana.user.id, deletedAt: new Date(now.getTime() - SWEEP_MIN_AGE_MS - 60_000) });
    for (const key of [row.objectKey, row.thumbKey, row.displayKey]) {
      if (key !== null) await storage.put({ key, body: new Uint8Array([1]), contentType: "image/webp" });
    }
    const result = await runMediaCleanup({
      db: getTestDb(),
      storage,
      clock: { now: () => now },
      log: { info: () => undefined, warn: () => undefined }
    });
    expect(result.swept).toBeGreaterThanOrEqual(1);
    expect([...storage.objects.keys()].filter((key) => key.startsWith("events/"))).toEqual([]);
  });
});
