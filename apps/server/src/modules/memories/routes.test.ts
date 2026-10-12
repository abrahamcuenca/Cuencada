/**
 * Memory Box routes (WP-6.3, ADR 0001 §8, requirements 1, 5, 8, 10) [SEC]:
 * the member list and box pages (published only), box uploads under the
 * server-derived `memories/{id}` prefix with the shared locked budget and
 * the confirm re-checks, the admin CRUD (cover, publish/hide, reorder,
 * delete/purge) and its audit, the admin media filter and the cleanup sweep.
 */
import {
  adminMemoryAlbumListSchema,
  adminMemoryAlbumSchema,
  mediaItemSchema,
  memoryAlbumDetailSchema,
  memoryAlbumListSchema,
  pageSchema
} from "@cuencada/types";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { callAs, errorOf, type EventActor, eventActor } from "../../../test/helpers/events.js";
import { FakeStorage } from "../../../test/helpers/fakes.js";
import { createCuencada, keyFromFakeUrl, makeJpegWithGps } from "../../../test/helpers/media.js";
import { insertMemoryAlbum, insertMemoryMedia } from "../../../test/helpers/memories.js";
import type { App } from "../../app.js";
import { auditLogs, mediaItems, memoryAlbums } from "../../db/schema/index.js";
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

async function audits(action: string): Promise<Array<typeof auditLogs.$inferSelect>> {
  return getTestDb().select().from(auditLogs).where(eq(auditLogs.action, action));
}

/** `PUT` is not in `callAs`. */
function putAs(actor: EventActor, url: string, payload: unknown): ReturnType<typeof callAs> {
  return app.inject({ method: "PUT", url, ...actor.auth, payload: payload as Record<string, unknown> }); // JSON fixture body
}

async function intent(actor: EventActor, albumId: string, byteSize: number): ReturnType<typeof callAs> {
  return callAs(app, actor, "POST", `/api/memories/${albumId}/uploads`, { fileName: "IMG_0001.JPG", mimeType: "image/jpeg", byteSize });
}

describe("GET /api/memories", () => {
  it("lists published boxes only, by sort order then newest, with per-caller counts and covers", async () => {
    const ana = await eventActor();
    const admin = await eventActor({ role: "admin" });
    const older = await insertMemoryAlbum({ title: "Bodas", sortOrder: 1, createdAt: new Date("2026-01-01T00:00:00Z") });
    const newer = await insertMemoryAlbum({ title: "Navidades", sortOrder: 1, createdAt: new Date("2026-02-01T00:00:00Z") });
    const first = await insertMemoryAlbum({ title: "La casa de los abuelos", sortOrder: 0 });
    await insertMemoryAlbum({ title: "Borrador", status: "draft" });
    await insertMemoryAlbum({ title: "Oculto", status: "hidden" });
    const photo = await insertMemoryMedia(first, { createdAt: new Date("2026-03-01T00:00:00Z") });
    await insertMemoryMedia(first, { kind: "video", mimeType: "video/mp4", thumbKey: null, createdAt: new Date("2026-03-02T00:00:00Z") });
    await insertMemoryMedia(first, { moderationStatus: "pending_review" });
    await insertMemoryMedia(first, { moderationStatus: "pending_review", uploadedByUserId: ana.user.id });
    await insertMemoryMedia(first, { deletedAt: new Date() });

    const response = await callAs(app, ana, "GET", "/api/memories");
    expect(response.statusCode, response.body).toBe(200);
    const list = memoryAlbumListSchema.parse(response.json());
    expect(list.items.map((item) => item.id)).toEqual([first.id, newer.id, older.id]);
    const [card] = list.items;
    // Ready + approved (2) plus the caller's own pending item.
    expect(card?.mediaCount).toBe(3);
    // No chosen cover: the newest visible photo (the video has no thumbnail).
    expect(card?.coverUrl).toContain(`memories/${first.id}/thumbs/${photo.id}.webp`);
    expect(list.items[1]?.coverUrl).toBeNull();

    // Admins get the same published-only list here.
    const forAdmin = memoryAlbumListSchema.parse((await callAs(app, admin, "GET", "/api/memories")).json());
    expect(forAdmin.items).toHaveLength(3);
  });

  it("uses the chosen cover while it is visible, and falls back when it is hidden", async () => {
    const ana = await eventActor();
    const box = await insertMemoryAlbum();
    const chosen = await insertMemoryMedia(box, { createdAt: new Date("2026-01-01T00:00:00Z") });
    const latest = await insertMemoryMedia(box, { createdAt: new Date("2026-02-01T00:00:00Z") });
    await getTestDb().update(memoryAlbums).set({ coverMediaId: chosen.id }).where(eq(memoryAlbums.id, box.id));
    const cover = async (): Promise<string | null | undefined> =>
      memoryAlbumListSchema.parse((await callAs(app, ana, "GET", "/api/memories")).json()).items[0]?.coverUrl;
    expect(await cover()).toContain(`/thumbs/${chosen.id}.webp`);
    await getTestDb().update(mediaItems).set({ moderationStatus: "hidden" }).where(eq(mediaItems.id, chosen.id));
    expect(await cover()).toContain(`/thumbs/${latest.id}.webp`);
  });
});

describe("GET /api/memories/:id and /media", () => {
  it("answers 404 MEMORY_ALBUM_NOT_FOUND to members for draft, hidden and missing boxes, and lets admins in", async () => {
    const ana = await eventActor();
    const admin = await eventActor({ role: "admin" });
    const draft = await insertMemoryAlbum({ status: "draft" });
    const hidden = await insertMemoryAlbum({ status: "hidden" });
    await insertMemoryMedia(hidden);
    for (const id of [draft.id, hidden.id, "00000000-0000-4000-8000-000000000000"]) {
      for (const url of [`/api/memories/${id}`, `/api/memories/${id}/media`]) {
        const response = await callAs(app, ana, "GET", url);
        expect(response.statusCode, url).toBe(404);
        expect(errorOf(response.body)).toEqual({ code: "NOT_FOUND", detailCode: "MEMORY_ALBUM_NOT_FOUND" });
      }
    }
    const detail = memoryAlbumDetailSchema.parse((await callAs(app, admin, "GET", `/api/memories/${hidden.id}`)).json());
    expect(detail).toMatchObject({ id: hidden.id, canUpload: true, mediaCount: 1 });
    expect(mediaPage.parse((await callAs(app, admin, "GET", `/api/memories/${hidden.id}/media`)).json()).items).toHaveLength(1);
  });

  it("returns a published box with canUpload and pages its media newest first with the box ref", async () => {
    const ana = await eventActor();
    const box = await insertMemoryAlbum({ title: "Fotos antiguas", description: "Escaneadas por la Rama Norte." });
    const items = [];
    for (let index = 0; index < 3; index += 1) {
      items.push(await insertMemoryMedia(box, { createdAt: new Date(Date.UTC(2026, 0, index + 1)) }));
    }
    const detail = memoryAlbumDetailSchema.parse((await callAs(app, ana, "GET", `/api/memories/${box.id}`)).json());
    expect(detail).toMatchObject({ title: "Fotos antiguas", description: "Escaneadas por la Rama Norte.", canUpload: true, mediaCount: 3 });

    const firstPage = mediaPage.parse((await callAs(app, ana, "GET", `/api/memories/${box.id}/media?limit=2`)).json());
    expect(firstPage.items.map((item) => item.id)).toEqual([items[2]?.id, items[1]?.id]);
    expect(firstPage.items[0]).toMatchObject({ memoryAlbum: { id: box.id, title: "Fotos antiguas" }, album: null, event: null, year: null });
    expect(firstPage.nextCursor).not.toBeNull();
    const second = mediaPage.parse(
      (await callAs(app, ana, "GET", `/api/memories/${box.id}/media?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor ?? "")}`)).json()
    );
    expect(second.items.map((item) => item.id)).toEqual([items[0]?.id]);
    expect(second.nextCursor).toBeNull();
  });
});

describe("POST /api/memories/:id/uploads", () => {
  it("stores keys under memories/{id}, confirms, processes and lists the photo", async () => {
    const bea = await eventActor();
    const box = await insertMemoryAlbum();
    const body = await makeJpegWithGps();
    const response = await intent(bea, box.id, body.byteLength);
    expect(response.statusCode, response.body).toBe(201);
    const { mediaId, uploadUrl } = response.json<{ mediaId: string; uploadUrl: string }>();
    const key = keyFromFakeUrl(uploadUrl);
    const prefix = `memories/${box.id}`;
    expect(key).toBe(`${prefix}/originals/${mediaId}.jpg`);
    await storage.simulateUpload(key, body, "image/jpeg");
    const confirm = await callAs(app, bea, "POST", `/api/media/${mediaId}/confirm`, {});
    expect(confirm.statusCode, confirm.body).toBe(200);
    await app.jobs.onIdle();

    const [row] = await getTestDb().select().from(mediaItems).where(eq(mediaItems.id, mediaId));
    expect(row).toMatchObject({
      uploadStatus: "ready",
      memoryAlbumId: box.id,
      cuencadaId: null,
      albumId: null,
      storagePrefix: prefix,
      thumbKey: `${prefix}/thumbs/${mediaId}.webp`,
      displayKey: `${prefix}/display/${mediaId}.webp`
    });
    const [audit] = await audits("media.uploaded");
    expect(audit?.metadata).toMatchObject({ memoryAlbumId: box.id });
    const listed = mediaPage.parse((await callAs(app, bea, "GET", `/api/memories/${box.id}/media`)).json());
    expect(listed.items.map((item) => item.id)).toEqual([mediaId]);
  });

  it("refuses draft and hidden boxes to members (404, no row) but lets admins upload to a draft", async () => {
    const bea = await eventActor();
    const admin = await eventActor({ role: "admin" });
    const draft = await insertMemoryAlbum({ status: "draft" });
    const hidden = await insertMemoryAlbum({ status: "hidden" });
    for (const box of [draft, hidden]) {
      const response = await intent(bea, box.id, 1000);
      expect(response.statusCode).toBe(404);
      expect(errorOf(response.body).detailCode).toBe("MEMORY_ALBUM_NOT_FOUND");
    }
    expect(await getTestDb().select().from(mediaItems)).toHaveLength(0);
    expect((await intent(admin, draft.id, 1000)).statusCode).toBe(201);
  });

  it("re-checks the box at confirm: hidden after the intent → 404 and the row stays pending", async () => {
    const bea = await eventActor();
    const box = await insertMemoryAlbum();
    const body = await makeJpegWithGps();
    const created = (await intent(bea, box.id, body.byteLength)).json<{ mediaId: string; uploadUrl: string }>();
    await storage.simulateUpload(keyFromFakeUrl(created.uploadUrl), body, "image/jpeg");
    await getTestDb().update(memoryAlbums).set({ status: "hidden" }).where(eq(memoryAlbums.id, box.id));
    const confirm = await callAs(app, bea, "POST", `/api/media/${created.mediaId}/confirm`, {});
    expect(confirm.statusCode).toBe(404);
    const [row] = await getTestDb().select({ uploadStatus: mediaItems.uploadStatus }).from(mediaItems).where(eq(mediaItems.id, created.mediaId));
    expect(row?.uploadStatus).toBe("pending_upload");
  });

  it("refuses a confirm whose original key sits under another box (prefix_mismatch)", async () => {
    const bea = await eventActor();
    const box = await insertMemoryAlbum();
    const other = await insertMemoryAlbum();
    const id = "00000000-0000-4000-8000-0000000000b1";
    const row = await insertMemoryMedia(box, {
      id,
      uploadedByUserId: bea.user.id,
      uploadStatus: "pending_upload",
      objectKey: `memories/${other.id}/originals/${id}.jpg`,
      thumbKey: null,
      displayKey: null
    });
    await storage.simulateUpload(row.objectKey, await makeJpegWithGps(), "image/jpeg");
    const response = await callAs(app, bea, "POST", `/api/media/${row.id}/confirm`, {});
    expect(response.statusCode).toBe(400);
    expect(errorOf(response.body).code).toBe("UPLOAD_INVALID");
    const [after] = await getTestDb().select().from(mediaItems).where(eq(mediaItems.id, row.id));
    expect(after).toMatchObject({ uploadStatus: "failed", processingError: "prefix_mismatch" });
  });

  it("cannot store a box row under another box's prefix at all (DB CHECK)", async () => {
    const box = await insertMemoryAlbum();
    const other = await insertMemoryAlbum();
    await expect(insertMemoryMedia(box, { storagePrefix: `memories/${other.id}` })).rejects.toThrow();
  });

  it("shares the locked daily budget with edition uploads", async () => {
    const ana = await eventActor();
    const box = await insertMemoryAlbum();
    const edition = await createCuencada({ year: 2100 });
    const big = 300 * 1024 * 1024;
    for (let index = 0; index < 14; index += 1) await insertMemoryMedia(box, { uploadedByUserId: ana.user.id, byteSize: big });
    const editionIntent = await callAs(app, ana, "POST", `/api/cuencadas/${edition.year}/media/uploads`, {
      fileName: "a.jpg",
      mimeType: "image/jpeg",
      byteSize: 1000
    });
    expect(editionIntent.statusCode).toBe(429);
    expect((await intent(ana, box.id, 1000)).statusCode).toBe(429);
  });
});

describe("admin Memory Box CRUD", () => {
  it("creates a draft, edits it, publishes and hides it, auditing ids, enums and field names only", async () => {
    const admin = await eventActor({ role: "admin" });
    const ana = await eventActor();
    const created = await callAs(app, admin, "POST", "/api/admin/memory-albums", { title: "  Fotos de la abuela  ", description: "Recuerdos." });
    expect(created.statusCode, created.body).toBe(201);
    const box = adminMemoryAlbumSchema.parse(created.json());
    expect(box).toMatchObject({ title: "Fotos de la abuela", status: "draft", sortOrder: 0, coverMediaId: null, mediaCount: 0 });
    expect(memoryAlbumListSchema.parse((await callAs(app, ana, "GET", "/api/memories")).json()).items).toHaveLength(0);

    const published = await callAs(app, admin, "PATCH", `/api/admin/memory-albums/${box.id}`, { status: "published", title: "Fotos del abuelo" });
    expect(published.statusCode, published.body).toBe(200);
    expect(adminMemoryAlbumSchema.parse(published.json())).toMatchObject({ status: "published", title: "Fotos del abuelo" });
    expect(memoryAlbumListSchema.parse((await callAs(app, ana, "GET", "/api/memories")).json()).items).toHaveLength(1);

    expect((await callAs(app, admin, "PATCH", `/api/admin/memory-albums/${box.id}`, { status: "hidden" })).statusCode).toBe(200);
    expect((await callAs(app, ana, "GET", `/api/memories/${box.id}`)).statusCode).toBe(404);

    expect((await audits("memory_album.created")).map((row) => row.metadata)).toEqual([{ status: "draft", sortOrder: 0 }]);
    expect((await audits("memory_album.updated")).map((row) => row.metadata)).toEqual(
      expect.arrayContaining([{ fields: ["status", "title"] }, { fields: ["status"] }])
    );
    expect((await audits("memory_album.published")).map((row) => row.metadata)).toEqual([{ previousStatus: "draft" }]);
    expect((await audits("memory_album.hidden")).map((row) => row.metadata)).toEqual([{ previousStatus: "published" }]);
    const serialized = JSON.stringify(await getTestDb().select().from(auditLogs));
    expect(serialized).not.toContain("abuel");
    expect(serialized).not.toContain("Recuerdos");
  });

  it("accepts a cover only from the box's own live, ready, approved photos", async () => {
    const admin = await eventActor({ role: "admin" });
    const box = await insertMemoryAlbum();
    const other = await insertMemoryAlbum();
    const own = await insertMemoryMedia(box);
    const foreign = await insertMemoryMedia(other);
    const video = await insertMemoryMedia(box, { kind: "video", mimeType: "video/mp4", thumbKey: null });
    const hidden = await insertMemoryMedia(box, { moderationStatus: "hidden" });
    const deleted = await insertMemoryMedia(box, { deletedAt: new Date() });
    for (const candidate of [foreign, video, hidden, deleted]) {
      const response = await callAs(app, admin, "PATCH", `/api/admin/memory-albums/${box.id}`, { coverMediaId: candidate.id });
      expect(response.statusCode, candidate.id).toBe(400);
      expect(errorOf(response.body).code).toBe("VALIDATION");
    }
    const ok = await callAs(app, admin, "PATCH", `/api/admin/memory-albums/${box.id}`, { coverMediaId: own.id });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(adminMemoryAlbumSchema.parse(ok.json())).toMatchObject({ coverMediaId: own.id });
    expect(adminMemoryAlbumSchema.parse(ok.json()).coverUrl).toContain(`/thumbs/${own.id}.webp`);
    const cleared = await callAs(app, admin, "PATCH", `/api/admin/memory-albums/${box.id}`, { coverMediaId: null });
    expect(adminMemoryAlbumSchema.parse(cleared.json()).coverMediaId).toBeNull();
  });

  it("answers 404 for an unknown box and 400 for an empty patch", async () => {
    const admin = await eventActor({ role: "admin" });
    const missing = "00000000-0000-4000-8000-000000000000";
    expect((await callAs(app, admin, "PATCH", `/api/admin/memory-albums/${missing}`, { title: "Nada" })).statusCode).toBe(404);
    expect((await callAs(app, admin, "DELETE", `/api/admin/memory-albums/${missing}`)).statusCode).toBe(404);
    const box = await insertMemoryAlbum();
    expect((await callAs(app, admin, "PATCH", `/api/admin/memory-albums/${box.id}`, {})).statusCode).toBe(400);
  });

  it("refuses to delete a box with live media (409), then purges soft-deleted rows and their objects", async () => {
    const admin = await eventActor({ role: "admin" });
    const box = await insertMemoryAlbum();
    const live = await insertMemoryMedia(box);
    const conflict = await callAs(app, admin, "DELETE", `/api/admin/memory-albums/${box.id}`);
    expect(conflict.statusCode).toBe(409);
    expect(errorOf(conflict.body)).toEqual({ code: "CONFLICT", detailCode: "MEMORY_ALBUM_NOT_EMPTY" });

    await getTestDb().update(memoryAlbums).set({ coverMediaId: live.id }).where(eq(memoryAlbums.id, box.id));
    await getTestDb().update(mediaItems).set({ deletedAt: new Date() }).where(eq(mediaItems.id, live.id));
    for (const key of [live.objectKey, live.thumbKey, live.displayKey]) {
      if (key !== null) await storage.put({ key, body: new Uint8Array([1]), contentType: "image/webp" });
    }
    const deleted = await callAs(app, admin, "DELETE", `/api/admin/memory-albums/${box.id}`);
    expect(deleted.statusCode, deleted.body).toBe(204);
    expect(await getTestDb().select().from(memoryAlbums).where(eq(memoryAlbums.id, box.id))).toHaveLength(0);
    expect(await getTestDb().select().from(mediaItems).where(eq(mediaItems.id, live.id))).toHaveLength(0);
    expect([...storage.objects.keys()].filter((key) => key.startsWith(`memories/${box.id}`))).toEqual([]);
    expect((await audits("memory_album.deleted")).map((row) => row.metadata)).toEqual([{ mediaDeleted: 1, previousStatus: "published" }]);
  });

  it("reorders every box (sort_order = index) and refuses a stale list", async () => {
    const admin = await eventActor({ role: "admin" });
    const a = await insertMemoryAlbum({ title: "A", sortOrder: 0 });
    const b = await insertMemoryAlbum({ title: "B", sortOrder: 1, status: "draft" });
    const c = await insertMemoryAlbum({ title: "C", sortOrder: 2, status: "hidden" });
    const response = await putAs(admin, "/api/admin/memory-albums/order", { ids: [c.id, a.id, b.id] });
    expect(response.statusCode, response.body).toBe(200);
    const list = adminMemoryAlbumListSchema.parse(response.json());
    expect(list.items.map((item) => [item.id, item.sortOrder])).toEqual([
      [c.id, 0],
      [a.id, 1],
      [b.id, 2]
    ]);
    const stale = await putAs(admin, "/api/admin/memory-albums/order", { ids: [a.id, b.id] });
    expect(stale.statusCode).toBe(409);
    const duplicate = await putAs(admin, "/api/admin/memory-albums/order", { ids: [a.id, a.id, b.id] });
    expect(duplicate.statusCode).toBe(400);
    expect((await audits("memory_album.reordered")).map((row) => row.metadata)).toEqual([{ count: 3 }]);
  });

  it("lists every status for admins in the panel order", async () => {
    const admin = await eventActor({ role: "admin" });
    await insertMemoryAlbum({ status: "draft", sortOrder: 2 });
    await insertMemoryAlbum({ status: "hidden", sortOrder: 1 });
    await insertMemoryAlbum({ status: "published", sortOrder: 0, createdByUserId: admin.user.id });
    const list = adminMemoryAlbumListSchema.parse((await callAs(app, admin, "GET", "/api/admin/memory-albums")).json());
    expect(list.items.map((item) => item.status)).toEqual(["published", "hidden", "draft"]);
    expect(list.items[0]?.createdByName).toBe(admin.user.displayName);
  });
});

describe("box media in the admin queue and the cleanup sweep", () => {
  it("filters the moderation queue by memoryAlbumId", async () => {
    const admin = await eventActor({ role: "admin" });
    const box = await insertMemoryAlbum({ status: "hidden" });
    const other = await insertMemoryAlbum();
    const item = await insertMemoryMedia(box);
    await insertMemoryMedia(other);
    const filtered = (await callAs(app, admin, "GET", `/api/admin/media?memoryAlbumId=${box.id}`)).json<{
      items: Array<{ id: string; memoryAlbum: { id: string } | null }>;
    }>();
    expect(filtered.items.map((entry) => entry.id)).toEqual([item.id]);
    expect(filtered.items[0]?.memoryAlbum?.id).toBe(box.id);
  });

  it("sweeps the objects of deleted box media under memories/", async () => {
    const box = await insertMemoryAlbum();
    const now = new Date();
    const row = await insertMemoryMedia(box, { deletedAt: new Date(now.getTime() - SWEEP_MIN_AGE_MS - 60_000) });
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
    expect([...storage.objects.keys()].filter((key) => key.startsWith("memories/"))).toEqual([]);
  });
});
