import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getTestDb } from "../../../../test/helpers/db.js";
import { FakeStorage } from "../../../../test/helpers/fakes.js";
import { createCuencada, insertMedia } from "../../../../test/helpers/media.js";
import { mediaItems } from "../../../db/schema/index.js";
import { UPLOAD_CLEANUP_GRACE_MS } from "../constants.js";
import { cleanupAbandonedUploads } from "./mediaCleanup.js";

const NOW = new Date("2026-12-27T12:00:00Z");
const MINUTE = 60 * 1000;
const silentLog = { info: (): void => undefined, warn: (): void => undefined };

describe("cleanupAbandonedUploads", () => {
  it("deletes only pending uploads past expiry + grace, keeps NULL expiries, and is idempotent", async () => {
    const storage = new FakeStorage();
    const db = getTestDb();
    const deps = { db, storage, clock: { now: () => NOW }, log: silentLog };
    const { id: cuencadaId } = await createCuencada();
    const longAgo = new Date(NOW.getTime() - UPLOAD_CLEANUP_GRACE_MS - MINUTE);
    const recent = new Date(NOW.getTime() - UPLOAD_CLEANUP_GRACE_MS + MINUTE);

    const stale = await insertMedia({ cuencadaId, uploadStatus: "pending_upload", uploadExpiresAt: longAgo, thumbKey: null, displayKey: null });
    const cancelled = await insertMedia({
      cuencadaId,
      uploadStatus: "pending_upload",
      uploadExpiresAt: longAgo,
      deletedAt: longAgo,
      thumbKey: null,
      displayKey: null
    });
    const withinGrace = await insertMedia({ cuencadaId, uploadStatus: "pending_upload", uploadExpiresAt: recent });
    const noExpiry = await insertMedia({ cuencadaId, uploadStatus: "pending_upload", uploadExpiresAt: null });
    const confirmed = await insertMedia({ cuencadaId, uploadStatus: "processing", uploadExpiresAt: longAgo });
    for (const row of [stale, cancelled, withinGrace, noExpiry, confirmed]) {
      await storage.put({ key: row.objectKey, body: new Uint8Array([1]), contentType: "image/jpeg" });
    }

    const first = await cleanupAbandonedUploads(deps);
    const second = await cleanupAbandonedUploads(deps);

    expect(first).toEqual({ rowsDeleted: 2, objectDeleteFailures: 0 });
    expect(second).toEqual({ rowsDeleted: 0, objectDeleteFailures: 0 });
    const remaining = (await db.select({ id: mediaItems.id }).from(mediaItems)).map((row) => row.id).sort();
    expect(remaining).toEqual([withinGrace.id, noExpiry.id, confirmed.id].sort());
    expect(storage.objects.has(stale.objectKey)).toBe(false);
    expect(storage.objects.has(cancelled.objectKey)).toBe(false);
    for (const kept of [withinGrace, noExpiry, confirmed]) {
      expect(storage.objects.has(kept.objectKey)).toBe(true);
    }
  });

  it("follows the injected clock: the same row becomes stale once time passes", async () => {
    const storage = new FakeStorage();
    const db = getTestDb();
    let now = NOW;
    const deps = { db, storage, clock: { now: () => now }, log: silentLog };
    const { id: cuencadaId } = await createCuencada();
    const row = await insertMedia({ cuencadaId, uploadStatus: "pending_upload", uploadExpiresAt: NOW });

    expect((await cleanupAbandonedUploads(deps)).rowsDeleted).toBe(0);
    now = new Date(NOW.getTime() + UPLOAD_CLEANUP_GRACE_MS + 1);
    expect((await cleanupAbandonedUploads(deps)).rowsDeleted).toBe(1);
    expect(await db.select().from(mediaItems).where(eq(mediaItems.id, row.id))).toHaveLength(0);
  });

  it("still removes the row and counts a failed object delete", async () => {
    const storage = new FakeStorage();
    storage.delete = async () => {
      throw new Error("boom");
    };
    const db = getTestDb();
    const deps = { db, storage, clock: { now: () => NOW }, log: silentLog };
    const { id: cuencadaId } = await createCuencada();
    await insertMedia({ cuencadaId, uploadStatus: "pending_upload", uploadExpiresAt: new Date(0) });

    expect(await cleanupAbandonedUploads(deps)).toEqual({ rowsDeleted: 1, objectDeleteFailures: 1 });
  });
});
