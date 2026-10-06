import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import { mutableClock } from "../../../test/helpers/cuencadas.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { createUser } from "../../../test/helpers/factories.js";
import { FakeStorage } from "../../../test/helpers/fakes.js";
import { avatarUploads } from "../../db/schema/index.js";
import { avatarKeys } from "./avatar.js";
import { cleanupAvatarUploads } from "./avatarCleanup.js";
import { AVATAR_CLEANUP_INTERVAL_MS } from "./constants.js";

const HOUR = 60 * 60 * 1000;

const silentLog = { info: () => undefined, warn: () => undefined };

async function insertUpload(
  userId: string,
  storage: FakeStorage,
  options: { expiresAt: Date; confirmedAt?: Date | null }
): Promise<{ id: string; keys: ReturnType<typeof avatarKeys> }> {
  const id = randomUUID();
  const keys = avatarKeys(userId, id, "image/jpeg");
  await getTestDb()
    .insert(avatarUploads)
    .values({
      id,
      userId,
      objectKey: keys.original,
      mimeType: "image/jpeg",
      byteSize: 3,
      expiresAt: options.expiresAt,
      confirmedAt: options.confirmedAt ?? null
    });
  await storage.put({
    key: keys.original,
    body: new Uint8Array([1, 2, 3]),
    contentType: "image/jpeg"
  });
  return { id, keys };
}

describe("cleanupAvatarUploads", () => {
  it("deletes abandoned uploads past the grace and retired confirmed rows, keeping everything else", async () => {
    const clock = mutableClock("2026-10-06T12:00:00Z");
    const now = clock.now().getTime();
    const storage = new FakeStorage();
    const user = await createUser();

    const abandoned = await insertUpload(user.id, storage, {
      expiresAt: new Date(now - 2 * HOUR)
    });
    const inGrace = await insertUpload(user.id, storage, {
      expiresAt: new Date(now - HOUR / 2)
    });
    const open = await insertUpload(user.id, storage, {
      expiresAt: new Date(now + HOUR)
    });
    const retired = await insertUpload(user.id, storage, {
      expiresAt: new Date(now - 30 * HOUR),
      confirmedAt: new Date(now - 25 * HOUR)
    });
    const recent = await insertUpload(user.id, storage, {
      expiresAt: new Date(now - 2 * HOUR),
      confirmedAt: new Date(now - 2 * HOUR)
    });
    // The live derivatives of the retired upload must survive.
    await storage.put({
      key: retired.keys.large,
      body: new Uint8Array([9]),
      contentType: "image/webp"
    });

    const result = await cleanupAvatarUploads({
      db: getTestDb(),
      storage,
      clock,
      log: silentLog
    });

    expect(result).toEqual({
      abandonedDeleted: 1,
      confirmedPurged: 1,
      objectDeleteFailures: 0
    });
    const remaining = (await getTestDb().select({ id: avatarUploads.id }).from(avatarUploads))
      .map((row) => row.id)
      .sort();
    expect(remaining).toEqual([inGrace.id, open.id, recent.id].sort());
    expect(storage.objects.has(abandoned.keys.original)).toBe(false);
    expect(storage.objects.has(retired.keys.original)).toBe(false);
    expect(storage.objects.has(retired.keys.large)).toBe(true);
    expect(storage.objects.has(inGrace.keys.original)).toBe(true);
    expect(storage.objects.has(open.keys.original)).toBe(true);
  });

  it("is idempotent and follows the injected clock", async () => {
    const clock = mutableClock("2026-10-06T12:00:00Z");
    const storage = new FakeStorage();
    const user = await createUser();
    const upload = await insertUpload(user.id, storage, {
      expiresAt: new Date(clock.now().getTime() + 5 * 60 * 1000)
    });
    const deps = { db: getTestDb(), storage, clock, log: silentLog };

    expect((await cleanupAvatarUploads(deps)).abandonedDeleted).toBe(0);
    clock.set(new Date(clock.now().getTime() + 2 * HOUR).toISOString());
    expect((await cleanupAvatarUploads(deps)).abandonedDeleted).toBe(1);
    expect(await cleanupAvatarUploads(deps)).toEqual({
      abandonedDeleted: 0,
      confirmedPurged: 0,
      objectDeleteFailures: 0
    });
    expect(storage.objects.has(upload.keys.original)).toBe(false);
  });

  it("counts object delete failures, still drops the row and logs no keys", async () => {
    const clock = mutableClock("2026-10-06T12:00:00Z");
    const storage = new FakeStorage();
    const user = await createUser();
    const upload = await insertUpload(user.id, storage, {
      expiresAt: new Date(clock.now().getTime() - 2 * HOUR)
    });
    const failing = {
      delete: async (key: string): Promise<void> => {
        throw new Error(`cannot delete ${key}`);
      }
    };
    const warnings: unknown[] = [];

    const result = await cleanupAvatarUploads({
      db: getTestDb(),
      storage: failing,
      clock,
      log: {
        info: () => undefined,
        warn: (...args: unknown[]) => warnings.push(args)
      }
    });

    expect(result).toEqual({
      abandonedDeleted: 1,
      confirmedPurged: 0,
      objectDeleteFailures: 1
    });
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings)).not.toContain(upload.keys.original);
  });
});

describe("profile module cleanup timer", () => {
  it("starts an unref'd interval on ready and clears it on close", async () => {
    const setSpy = vi.spyOn(globalThis, "setInterval");
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    try {
      const app = await createTestApp();
      const timers = setSpy.mock.results
        .filter((_result, index) => setSpy.mock.calls[index]?.[1] === AVATAR_CLEANUP_INTERVAL_MS)
        .map((result) => result.value as NodeJS.Timeout); // setInterval returns a Timeout in Node
      expect(timers.length).toBeGreaterThanOrEqual(1);
      for (const timer of timers) expect(timer.hasRef()).toBe(false);

      await app.close();

      for (const timer of timers) expect(clearSpy).toHaveBeenCalledWith(timer);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });
});
