/**
 * `mediaScopeSql` and Memory Box rows (WP-6.0 → WP-6.3, ADR 0001 §8,
 * requirements 1, 2 and 5) [SEC].
 *
 * WP-6.0 denied every box row to members; WP-6.3 adds the explicit
 * published-box branch. A draft or hidden box's media stay unreachable by
 * id for members (404 on every by-id route, the uploader included) and
 * untouched, while admins still reach them. Social data (tags, likes,
 * comments) and notifications hang off the media row and are read through
 * `viewableSql` (WP-6.1/6.2), so the predicate tests below are the
 * contract those routes inherit: hiding a box hides all of it.
 */
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { callAs, errorOf, eventActor, insertAlbumMedia, insertEvent } from "../../../test/helpers/events.js";
import { FakeStorage } from "../../../test/helpers/fakes.js";
import { insertPerson } from "../../../test/helpers/family.js";
import { createCuencada, insertMedia } from "../../../test/helpers/media.js";
import { insertMemoryAlbum, insertMemoryMedia } from "../../../test/helpers/memories.js";
import type { App } from "../../app.js";
import { mediaComments, mediaItems, mediaLikes, mediaTags, memoryAlbums, notifications } from "../../db/schema/index.js";
import { viewableSql, type Viewer } from "./service.js";

let app: App;

beforeEach(async () => {
  app = await createTestApp({ storage: new FakeStorage() });
});

afterEach(async () => {
  await app.jobs.onIdle();
  await app.close();
});

/** Ids among `ids` that pass `viewableSql(viewer)`. */
async function viewableIds(viewer: Viewer, ids: string[]): Promise<string[]> {
  const rows = await getTestDb()
    .select({ id: mediaItems.id })
    .from(mediaItems)
    .where(sql`${inArray(mediaItems.id, ids)} and ${viewableSql(viewer)}`);
  return rows.map((row) => row.id).sort();
}

describe("mediaScopeSql: Memory Box rows by box status (WP-6.3)", () => {
  for (const status of ["draft", "hidden"] as const) {
    it(`answers 404 to members, the uploader included, on every by-id route of a ${status} box's photo`, async () => {
      const ana = await eventActor();
      const bea = await eventActor();
      const album = await insertMemoryAlbum({ status });
      const item = await insertMemoryMedia(album, { uploadedByUserId: ana.user.id });
      const pending = await insertMemoryMedia(album, { uploadedByUserId: ana.user.id, uploadStatus: "pending_upload" });

      for (const actor of [ana, bea]) {
        const probes = [
          await callAs(app, actor, "GET", `/api/media/${item.id}`),
          await callAs(app, actor, "PATCH", `/api/media/${item.id}`, { caption: "Hola" }),
          await callAs(app, actor, "POST", `/api/media/${item.id}/report`, { reason: "other" }),
          await callAs(app, actor, "DELETE", `/api/media/${item.id}`),
          await callAs(app, actor, "POST", `/api/media/${pending.id}/confirm`, {})
        ];
        for (const response of probes) {
          expect(response.statusCode, response.body).toBe(404);
          expect(errorOf(response.body).code).toBe("NOT_FOUND");
        }
      }
      const rows = await getTestDb()
        .select({ deletedAt: mediaItems.deletedAt, caption: mediaItems.caption, uploadStatus: mediaItems.uploadStatus })
        .from(mediaItems)
        .where(inArray(mediaItems.id, [item.id, pending.id]))
        .orderBy(mediaItems.uploadStatus);
      expect(rows).toEqual([
        { deletedAt: null, caption: null, uploadStatus: "pending_upload" },
        { deletedAt: null, caption: null, uploadStatus: "ready" }
      ]);
    });
  }

  it("lets members reach a published box's photo and admins reach every box", async () => {
    const ana = await eventActor();
    const bea = await eventActor();
    const admin = await eventActor({ role: "admin" });
    const published = await insertMemoryMedia(await insertMemoryAlbum({ status: "published" }), { uploadedByUserId: ana.user.id });
    const hidden = await insertMemoryMedia(await insertMemoryAlbum({ status: "hidden" }), { uploadedByUserId: ana.user.id });

    const read = await callAs(app, bea, "GET", `/api/media/${published.id}`);
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json<{ memoryAlbum: { id: string } | null }>().memoryAlbum?.id).toBe(published.memoryAlbumId);
    expect((await callAs(app, bea, "POST", `/api/media/${published.id}/report`, { reason: "other" })).statusCode).toBe(204);
    expect((await callAs(app, ana, "PATCH", `/api/media/${published.id}`, { caption: "La abuela" })).statusCode).toBe(200);
    expect((await callAs(app, admin, "GET", `/api/media/${hidden.id}`)).statusCode).toBe(200);
  });

  it("hides a box's media the moment the box is hidden, and shows them again when republished", async () => {
    const ana = await eventActor();
    const album = await insertMemoryAlbum();
    const item = await insertMemoryMedia(album, { uploadedByUserId: ana.user.id });
    expect((await callAs(app, ana, "GET", `/api/media/${item.id}`)).statusCode).toBe(200);
    await getTestDb().update(memoryAlbums).set({ status: "hidden" }).where(eq(memoryAlbums.id, album.id));
    expect((await callAs(app, ana, "GET", `/api/media/${item.id}`)).statusCode).toBe(404);
    await getTestDb().update(memoryAlbums).set({ status: "published" }).where(eq(memoryAlbums.id, album.id));
    expect((await callAs(app, ana, "GET", `/api/media/${item.id}`)).statusCode).toBe(200);
  });
});

describe("mediaScopeSql is exhaustive (ADR 0001 §8 requirement 2)", () => {
  it("has one explicit branch per scope: edition, event album, published box; drafts, hidden boxes and foreign albums are denied", async () => {
    const member = await eventActor();
    const owner = await eventActor();
    const edition = await createCuencada({ year: 2100 });
    const editionItem = await insertMedia({ cuencadaId: edition.id, uploadedByUserId: owner.user.id });
    const joined = await insertEvent({ organizerId: owner.user.id, participantIds: [member.user.id] });
    const joinedItem = await insertAlbumMedia(joined.album, { uploadedByUserId: owner.user.id });
    const foreign = await insertEvent({ organizerId: owner.user.id, visibility: "participants" });
    const foreignItem = await insertAlbumMedia(foreign.album, { uploadedByUserId: owner.user.id });
    const publishedItem = await insertMemoryMedia(await insertMemoryAlbum({ status: "published" }), { uploadedByUserId: owner.user.id });
    const draftItem = await insertMemoryMedia(await insertMemoryAlbum({ status: "draft" }), { uploadedByUserId: member.user.id });
    const hiddenItem = await insertMemoryMedia(await insertMemoryAlbum({ status: "hidden" }), { uploadedByUserId: member.user.id });
    const all = [editionItem.id, joinedItem.id, foreignItem.id, publishedItem.id, draftItem.id, hiddenItem.id];

    expect(await viewableIds({ id: member.user.id, role: "member" }, all)).toEqual(
      [editionItem.id, joinedItem.id, publishedItem.id].sort()
    );
    expect(await viewableIds({ id: randomUUID(), role: "admin" }, all)).toEqual([...all].sort());
  });
});

describe("a hidden box hides its social data (ADR 0001 §8 requirement 5, read through viewableSql)", () => {
  it("leaves no tag, like, comment or notification of a hidden box's photo reachable by a member", async () => {
    const ana = await eventActor();
    const bea = await eventActor();
    const album = await insertMemoryAlbum({ status: "published" });
    const item = await insertMemoryMedia(album, { uploadedByUserId: ana.user.id });
    const person = await insertPerson({ fullName: "Ana Morales Vega" });
    await getTestDb().insert(mediaTags).values({ mediaId: item.id, personId: person.id, taggedByUserId: bea.user.id, status: "approved", approvedAt: new Date() });
    await getTestDb().insert(mediaLikes).values({ mediaId: item.id, userId: bea.user.id });
    await getTestDb().insert(mediaComments).values({ mediaId: item.id, authorUserId: bea.user.id, body: "Qué bonita foto" });
    await getTestDb().insert(notifications).values({ userId: ana.user.id, actorUserId: bea.user.id, kind: "photo_liked", mediaId: item.id, dedupeKey: `like:${item.id}` });
    const viewer: Viewer = { id: ana.user.id, role: "member" };

    /** What a social read (6.2) or the notification feed (6.1) would return for the member: rows joined to a viewable photo. */
    async function reachable(): Promise<Record<string, number>> {
      const viewable = viewableSql(viewer);
      const [tags] = await getTestDb().select({ n: sql<number>`count(*)::int` }).from(mediaTags).innerJoin(mediaItems, eq(mediaItems.id, mediaTags.mediaId)).where(viewable);
      const [likes] = await getTestDb().select({ n: sql<number>`count(*)::int` }).from(mediaLikes).innerJoin(mediaItems, eq(mediaItems.id, mediaLikes.mediaId)).where(viewable);
      const [comments] = await getTestDb()
        .select({ n: sql<number>`count(*)::int` })
        .from(mediaComments)
        .innerJoin(mediaItems, eq(mediaItems.id, mediaComments.mediaId))
        .where(viewable);
      const [feed] = await getTestDb()
        .select({ n: sql<number>`count(*)::int` })
        .from(notifications)
        .innerJoin(mediaItems, eq(mediaItems.id, notifications.mediaId))
        .where(sql`${notifications.userId} = ${ana.user.id} and ${viewable}`);
      return { tags: tags?.n ?? -1, likes: likes?.n ?? -1, comments: comments?.n ?? -1, notifications: feed?.n ?? -1 };
    }

    expect(await reachable()).toEqual({ tags: 1, likes: 1, comments: 1, notifications: 1 });
    await getTestDb().update(memoryAlbums).set({ status: "hidden" }).where(eq(memoryAlbums.id, album.id));
    expect(await reachable()).toEqual({ tags: 0, likes: 0, comments: 0, notifications: 0 });
    await getTestDb().update(memoryAlbums).set({ status: "draft" }).where(eq(memoryAlbums.id, album.id));
    expect(await reachable()).toEqual({ tags: 0, likes: 0, comments: 0, notifications: 0 });
  });
});
