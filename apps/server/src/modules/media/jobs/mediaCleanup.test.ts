import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getTestDb } from "../../../../test/helpers/db.js";
import { FakeStorage } from "../../../../test/helpers/fakes.js";
import { createCuencada, insertMedia } from "../../../../test/helpers/media.js";
import { mediaItems } from "../../../db/schema/index.js";
import { SWEEP_MAX_AGE_MS, SWEEP_MIN_AGE_MS, UPLOAD_CLEANUP_GRACE_MS } from "../constants.js";
import { mediaKeys } from "../files.js";
import { type CleanupDeps, runMediaCleanup } from "./mediaCleanup.js";

const NOW = new Date("2026-12-27T12:00:00Z");
const MINUTE = 60 * 1000;
const silentLog = { info: (): void => undefined, warn: (): void => undefined };

function depsAt(storage: FakeStorage, now: () => Date): CleanupDeps {
  return { db: getTestDb(), storage, clock: { now }, log: silentLog };
}

async function rowOf(id: string): Promise<typeof mediaItems.$inferSelect | undefined> {
  const [row] = await getTestDb().select().from(mediaItems).where(eq(mediaItems.id, id));
  return row;
}

async function putObject(storage: FakeStorage, key: string): Promise<void> {
  await storage.put({ key, body: new Uint8Array([1]), contentType: "image/jpeg" });
}

describe("runMediaCleanup: abandoned uploads", () => {
  it("claims only pending uploads past expiry + grace, keeps NULL expiries, and is idempotent", async () => {
    const storage = new FakeStorage();
    const deps = depsAt(storage, () => NOW);
    const { id: cuencadaId } = await createCuencada();
    const longAgo = new Date(NOW.getTime() - UPLOAD_CLEANUP_GRACE_MS - MINUTE);
    const recent = new Date(NOW.getTime() - UPLOAD_CLEANUP_GRACE_MS + MINUTE);

    const stale = await insertMedia({ cuencadaId, uploadStatus: "pending_upload", uploadExpiresAt: longAgo, thumbKey: null, displayKey: null });
    const withinGrace = await insertMedia({ cuencadaId, uploadStatus: "pending_upload", uploadExpiresAt: recent });
    const noExpiry = await insertMedia({ cuencadaId, uploadStatus: "pending_upload", uploadExpiresAt: null });
    const confirmed = await insertMedia({ cuencadaId, uploadStatus: "processing", uploadExpiresAt: longAgo });
    for (const row of [stale, withinGrace, noExpiry, confirmed]) await putObject(storage, row.objectKey);

    const first = await runMediaCleanup(deps);
    const second = await runMediaCleanup(deps);

    expect(first.abandoned).toBe(1);
    expect(second.abandoned).toBe(0);
    expect((await rowOf(stale.id))?.deletedAt).toEqual(NOW);
    expect(storage.objects.has(stale.objectKey)).toBe(false);
    for (const kept of [withinGrace, noExpiry, confirmed]) {
      expect((await rowOf(kept.id))?.deletedAt).toBeNull();
      expect(storage.objects.has(kept.objectKey)).toBe(true);
    }
  });

  it("follows the injected clock and purges the claimed row after the sweep window", async () => {
    const storage = new FakeStorage();
    let now = NOW;
    const deps = depsAt(storage, () => now);
    const { id: cuencadaId } = await createCuencada();
    const row = await insertMedia({ cuencadaId, uploadStatus: "pending_upload", uploadExpiresAt: NOW });
    const legacy = await insertMedia({ cuencadaId, uploadStatus: "pending_upload", uploadExpiresAt: null, deletedAt: new Date(0) });

    expect((await runMediaCleanup(deps)).abandoned).toBe(0);
    now = new Date(NOW.getTime() + UPLOAD_CLEANUP_GRACE_MS + 1);
    expect((await runMediaCleanup(deps)).abandoned).toBe(1);
    expect(await rowOf(row.id)).toBeDefined();
    now = new Date(now.getTime() + SWEEP_MAX_AGE_MS + MINUTE);
    expect((await runMediaCleanup(deps)).purged).toBe(1);
    expect(await rowOf(row.id)).toBeUndefined();
    expect(await rowOf(legacy.id)).toBeDefined();
  });

  it("counts a failed object delete and retries it in the sweep window", async () => {
    const storage = new FakeStorage();
    const realDelete = storage.delete.bind(storage);
    let failDeletes = true;
    storage.delete = async (key) => {
      if (failDeletes) throw new Error("boom");
      await realDelete(key);
    };
    let now = NOW;
    const deps = depsAt(storage, () => now);
    const { id: cuencadaId } = await createCuencada();
    const row = await insertMedia({ cuencadaId, uploadStatus: "pending_upload", uploadExpiresAt: new Date(0) });
    await putObject(storage, row.objectKey);

    expect(await runMediaCleanup(deps)).toMatchObject({ abandoned: 1, objectDeleteFailures: 1 });
    expect(storage.objects.has(row.objectKey)).toBe(true);
    failDeletes = false;
    now = new Date(NOW.getTime() + SWEEP_MIN_AGE_MS + MINUTE);
    await runMediaCleanup(deps);
    expect(storage.objects.has(row.objectKey)).toBe(false);
  });
});

describe("runMediaCleanup: confirm race", () => {
  it("skips an item a confirm already moved to processing", async () => {
    const storage = new FakeStorage();
    const { id: cuencadaId } = await createCuencada();
    const row = await insertMedia({ cuencadaId, uploadStatus: "pending_upload", uploadExpiresAt: new Date(0) });
    await putObject(storage, row.objectKey);
    // Confirm wins: the guarded update moves it first.
    await getTestDb().update(mediaItems).set({ uploadStatus: "processing" }).where(eq(mediaItems.id, row.id));

    expect((await runMediaCleanup(depsAt(storage, () => NOW))).abandoned).toBe(0);
    expect(storage.objects.has(row.objectKey)).toBe(true);
    expect((await rowOf(row.id))?.deletedAt).toBeNull();
  });
});

describe("runMediaCleanup: leftover sweep", () => {
  it("re-deletes every key of deleted and failed rows and the original of ready rows inside the window", async () => {
    const storage = new FakeStorage();
    const deps = depsAt(storage, () => NOW);
    const { id: cuencadaId } = await createCuencada();
    const inWindow = new Date(NOW.getTime() - 2 * SWEEP_MIN_AGE_MS);
    const tooRecent = new Date(NOW.getTime() - SWEEP_MIN_AGE_MS / 2);
    const tooOld = new Date(NOW.getTime() - SWEEP_MAX_AGE_MS - MINUTE);

    const deleted = await insertMedia({ cuencadaId, deletedAt: inWindow });
    const failed = await insertMedia({ cuencadaId, uploadStatus: "failed", thumbKey: null, displayKey: null, updatedAt: inWindow });
    const ready = await insertMedia({ cuencadaId, processedAt: inWindow });
    const recentDelete = await insertMedia({ cuencadaId, deletedAt: tooRecent });
    const oldDelete = await insertMedia({ cuencadaId, deletedAt: tooOld });
    const failedKeys = mediaKeys(2026, failed.id, failed.mimeType);
    for (const row of [deleted, ready, recentDelete, oldDelete]) {
      for (const key of [row.objectKey, row.thumbKey, row.displayKey]) if (key !== null) await putObject(storage, key);
    }
    for (const key of [failed.objectKey, failedKeys.thumb, failedKeys.display]) await putObject(storage, key);

    const result = await runMediaCleanup(deps);

    expect(result.swept).toBe(3);
    for (const key of [deleted.objectKey, deleted.thumbKey, deleted.displayKey, failed.objectKey, failedKeys.thumb, failedKeys.display]) {
      expect(storage.objects.has(key ?? "")).toBe(false);
    }
    expect(storage.objects.has(ready.objectKey)).toBe(false);
    expect(storage.objects.has(ready.thumbKey ?? "")).toBe(true);
    expect(storage.objects.has(ready.displayKey ?? "")).toBe(true);
    expect(storage.objects.has(recentDelete.objectKey)).toBe(true);
    expect(storage.objects.has(oldDelete.objectKey)).toBe(true);
  });

  it("never deletes an original that a legacy row still displays", async () => {
    const storage = new FakeStorage();
    const { id: cuencadaId } = await createCuencada();
    const id = "6f1d3b0e-2c4a-4b8e-9f00-1234567890ab";
    const key = `cuencadas/2026/originals/${id}.mp4`;
    await insertMedia({
      id,
      cuencadaId,
      kind: "video",
      mimeType: "video/mp4",
      objectKey: key,
      displayKey: key,
      thumbKey: null,
      processedAt: new Date(NOW.getTime() - 2 * SWEEP_MIN_AGE_MS)
    });
    await putObject(storage, key);

    await runMediaCleanup(depsAt(storage, () => NOW));

    expect(storage.objects.has(key)).toBe(true);
  });
});
