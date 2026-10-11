/**
 * Event cover (WP-5.3, Security requirement 8) [SEC]: the avatar pipeline at
 * 16:9 (1280/640 WebP, EXIF/GPS stripped, crop clamp), organizer/admin only
 * and re-checked at confirm, uploader-only confirm, replaced objects
 * deleted, never presigned for a caller who cannot see the event, and the
 * cleanup of abandoned intents.
 */
import { eventDetailSchema, eventCoverUploadResponseSchema } from "@cuencada/types";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { addParticipant, callAs, errorOf, type EventActor, eventActor, insertEvent } from "../../../test/helpers/events.js";
import { FakeStorage } from "../../../test/helpers/fakes.js";
import { keyFromFakeUrl, makeJpegWithGps, makePng } from "../../../test/helpers/media.js";
import type { App } from "../../app.js";
import { eventCoverUploads, eventParticipants, events } from "../../db/schema/index.js";
import { cleanupAvatarUploads } from "../profile/avatarCleanup.js";
import { AVATAR_CLEANUP_GRACE_MS } from "../profile/constants.js";
import { coverKeyForWidth } from "./cover.js";

let app: App;
let storage: FakeStorage;

beforeEach(async () => {
  storage = new FakeStorage();
  app = await createTestApp({ storage });
});

afterEach(async () => {
  await app.close();
});

async function intent(actor: EventActor, eventId: string, body: Buffer, mimeType = "image/jpeg"): Promise<{ uploadId: string; key: string }> {
  const response = await callAs(app, actor, "POST", `/api/events/${eventId}/cover/uploads`, { mimeType, byteSize: body.byteLength });
  expect(response.statusCode, response.body).toBe(201);
  const parsed = eventCoverUploadResponseSchema.parse(response.json());
  const key = keyFromFakeUrl(parsed.uploadUrl);
  await storage.simulateUpload(key, body, mimeType);
  return { uploadId: parsed.uploadId, key };
}

describe("event cover", () => {
  it("processes a 16:9 cover at 1280 and 640 px without metadata and replaces the previous one", async () => {
    const ana = await eventActor();
    const { event } = await insertEvent({ organizerId: ana.user.id });
    const first = await intent(ana, event.id, await makeJpegWithGps(1600, 1200));
    expect(first.key).toBe(`events/${event.id}/cover/${first.uploadId}.jpg`);
    const confirmed = await callAs(app, ana, "POST", `/api/events/${event.id}/cover/uploads/${first.uploadId}/confirm`, {
      crop: { x: 100, y: 100, size: 1600 }
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(eventDetailSchema.parse(confirmed.json()).coverUrl).not.toBeNull();
    const [row] = await getTestDb().select().from(events).where(eq(events.id, event.id));
    const large = `events/${event.id}/cover/${first.uploadId}-1280.webp`;
    expect(row?.coverKey).toBe(large);
    for (const [key, width, height] of [
      [large, 1280, 720],
      [coverKeyForWidth(large, 640), 640, 360]
    ] as const) {
      const stored = key === null ? undefined : storage.objects.get(key);
      if (stored === undefined) throw new Error("missing derivative");
      const meta = await sharp(stored.body).metadata();
      expect([meta.format, meta.width, meta.height, meta.exif, meta.orientation]).toEqual(["webp", width, height, undefined, undefined]);
    }
    expect(storage.objects.has(first.key)).toBe(false);

    const second = await intent(ana, event.id, await makePng(64, 36), "image/png");
    expect((await callAs(app, ana, "POST", `/api/events/${event.id}/cover/uploads/${second.uploadId}/confirm`, {})).statusCode).toBe(200);
    expect(storage.objects.has(large)).toBe(false);
    const removed = await callAs(app, ana, "DELETE", `/api/events/${event.id}/cover`);
    expect(eventDetailSchema.parse(removed.json()).coverUrl).toBeNull();
    expect([...storage.objects.keys()].filter((key) => key.startsWith(`events/${event.id}/cover/`))).toEqual([]);
  });

  it("rejects a mismatched file (UPLOAD_INVALID, audited) and re-checks the organizer at confirm", async () => {
    const ana = await eventActor();
    const bea = await eventActor();
    const { event } = await insertEvent({ organizerId: ana.user.id });
    await addParticipant(event.id, bea.user.id, "organizer");
    const bad = await intent(ana, event.id, await makePng(), "image/jpeg");
    const rejected = await callAs(app, ana, "POST", `/api/events/${event.id}/cover/uploads/${bad.uploadId}/confirm`, {});
    expect(errorOf(rejected.body).code).toBe("UPLOAD_INVALID");

    const bea1 = await intent(bea, event.id, await makePng(64, 36), "image/png");
    // Another organizer cannot confirm Bea's upload.
    expect((await callAs(app, ana, "POST", `/api/events/${event.id}/cover/uploads/${bea1.uploadId}/confirm`, {})).statusCode).toBe(404);
    await getTestDb().update(eventParticipants).set({ role: "participant" }).where(eq(eventParticipants.userId, bea.user.id));
    const demoted = await callAs(app, bea, "POST", `/api/events/${event.id}/cover/uploads/${bea1.uploadId}/confirm`, {});
    expect(errorOf(demoted.body).detailCode).toBe("EVENT_MANAGE_NOT_ALLOWED");
    const [row] = await getTestDb().select().from(events).where(eq(events.id, event.id));
    expect(row?.coverKey).toBeNull();
  });

  it("never presigns a cover for a caller who cannot see the event", async () => {
    const ana = await eventActor();
    const outsider = await eventActor();
    const { event } = await insertEvent({ organizerId: ana.user.id, visibility: "participants" });
    const upload = await intent(ana, event.id, await makePng(64, 36), "image/png");
    await callAs(app, ana, "POST", `/api/events/${event.id}/cover/uploads/${upload.uploadId}/confirm`, {});
    const presign = vi.spyOn(storage, "presignGet");
    for (const url of ["/api/events?year=2026", `/api/events/${event.year}/${event.slug}`, "/api/events/notices"]) {
      const response = await callAs(app, outsider, "GET", url);
      expect(response.body).not.toContain(`events/${event.id}/cover`);
    }
    expect(presign.mock.calls.filter(([input]) => input.key.includes("/cover/"))).toEqual([]);
  });

  it("cleans up abandoned cover intents with the avatar cleanup job", async () => {
    const ana = await eventActor();
    const { event } = await insertEvent({ organizerId: ana.user.id });
    const upload = await intent(ana, event.id, await makePng(64, 36), "image/png");
    const later = new Date(Date.now() + 10 * 60_000 + AVATAR_CLEANUP_GRACE_MS);
    const result = await cleanupAvatarUploads({
      db: getTestDb(),
      storage,
      clock: { now: () => later },
      log: { info: () => undefined, warn: () => undefined }
    });
    expect(result.abandonedDeleted).toBe(1);
    expect(await getTestDb().select().from(eventCoverUploads).where(eq(eventCoverUploads.id, upload.uploadId))).toEqual([]);
    expect(storage.objects.has(upload.key)).toBe(false);
  });
});
