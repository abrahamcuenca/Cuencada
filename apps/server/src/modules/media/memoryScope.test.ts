/**
 * WP-6.0 (ADR 0001 §8) [SEC]: `mediaScopeSql` has one explicit branch per
 * known scope and denies anything else. Migration 0010 lets a media row
 * belong to a Memory Box (`memory_album_id`), a scope the member branch does
 * not know until WP-6.3: such a row must be unreachable by id for members
 * (404 on every by-id route), while admins still reach it.
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { callAs, errorOf, eventActor } from "../../../test/helpers/events.js";
import { FakeStorage } from "../../../test/helpers/fakes.js";
import type { App } from "../../app.js";
import { mediaItems, memoryAlbums } from "../../db/schema/index.js";

let app: App;

beforeEach(async () => {
  app = await createTestApp({ storage: new FakeStorage() });
});

afterEach(async () => {
  await app.jobs.onIdle();
  await app.close();
});

/** A published box with one ready, approved photo uploaded by `uploaderId`. */
async function insertMemoryMedia(uploaderId: string): Promise<{ albumId: string; mediaId: string }> {
  const [album] = await getTestDb()
    .insert(memoryAlbums)
    .values({ title: "Fotos de la abuela", status: "published" })
    .returning({ id: memoryAlbums.id });
  if (album === undefined) throw new Error("insertMemoryMedia: no album");
  const id = randomUUID();
  const prefix = `memories/${album.id}`;
  const [row] = await getTestDb()
    .insert(mediaItems)
    .values({
      id,
      memoryAlbumId: album.id,
      storagePrefix: prefix,
      uploadedByUserId: uploaderId,
      kind: "image",
      objectKey: `${prefix}/originals/${id}.jpg`,
      thumbKey: `${prefix}/thumbs/${id}.webp`,
      displayKey: `${prefix}/display/${id}.webp`,
      bucket: "test-bucket",
      fileName: "abuela.jpg",
      mimeType: "image/jpeg",
      byteSize: 1000,
      uploadStatus: "ready",
      moderationStatus: "approved"
    } satisfies typeof mediaItems.$inferInsert)
    .returning({ id: mediaItems.id });
  if (row === undefined) throw new Error("insertMemoryMedia: no media");
  return { albumId: album.id, mediaId: row.id };
}

describe("mediaScopeSql denies unrecognised scopes (WP-6.0)", () => {
  it("answers 404 to members, the uploader included, on every by-id route of a Memory Box row", async () => {
    const ana = await eventActor();
    const bea = await eventActor();
    const { mediaId } = await insertMemoryMedia(ana.user.id);

    for (const actor of [ana, bea]) {
      const probes = [
        await callAs(app, actor, "GET", `/api/media/${mediaId}`),
        await callAs(app, actor, "PATCH", `/api/media/${mediaId}`, { caption: "Hola" }),
        await callAs(app, actor, "POST", `/api/media/${mediaId}/report`, { reason: "other" }),
        await callAs(app, actor, "DELETE", `/api/media/${mediaId}`)
      ];
      for (const response of probes) {
        expect(response.statusCode, response.body).toBe(404);
        expect(errorOf(response.body).code).toBe("NOT_FOUND");
      }
    }
    const [row] = await getTestDb().select({ deletedAt: mediaItems.deletedAt, caption: mediaItems.caption }).from(mediaItems);
    expect(row).toEqual({ deletedAt: null, caption: null });
  });

  it("still lets admins reach the row", async () => {
    const admin = await eventActor({ role: "admin" });
    const ana = await eventActor();
    const { mediaId } = await insertMemoryMedia(ana.user.id);
    const response = await callAs(app, admin, "GET", `/api/media/${mediaId}`);
    expect(response.statusCode, response.body).toBe(200);
  });
});
