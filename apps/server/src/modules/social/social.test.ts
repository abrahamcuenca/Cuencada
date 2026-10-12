/**
 * WP-6.2 photo social routes (ADR 0001 §8) [SEC]: tag consent and the
 * tagger-blind rule, remove rights, hearts and likers, comments with
 * author-only delete and tombstones, counts, "Fotos de {persona}", the admin
 * queue, PII cases and person-merge tag moves. Fictional fixtures only.
 */
import { randomUUID } from "node:crypto";
import type { MediaComment, MediaDetail, MediaItem, MediaLiker, MediaTag, Page, TagCandidate } from "@cuencada/types";
import { and, eq } from "drizzle-orm";
import type { LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { type EventActor, eventActor, errorOf, insertAlbumMedia, insertEvent } from "../../../test/helpers/events.js";
import { FakeStorage } from "../../../test/helpers/fakes.js";
import { insertPerson } from "../../../test/helpers/family.js";
import { createCuencada, insertMedia } from "../../../test/helpers/media.js";
import { insertMemoryAlbum, insertMemoryMedia } from "../../../test/helpers/memories.js";
import type { App } from "../../app.js";
import { auditLogs, mediaComments, mediaTags, people, profiles } from "../../db/schema/index.js";
import { moveMediaTagsTx } from "./index.js";

let app: App;

beforeEach(async () => {
  app = await createTestApp({ storage: new FakeStorage() });
});

afterEach(async () => {
  await app.jobs.onIdle();
  await app.close();
});

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

function call(actor: EventActor, method: Method, url: string, payload?: Record<string, unknown>): Promise<LightMyRequestResponse> {
  return app.inject({ method, url, ...actor.auth, ...(payload === undefined ? {} : { payload }) });
}

/** Parse a JSON body as a contract shape (test-only: the route schema already validated it). */
function body<T>(response: LightMyRequestResponse): T {
  return response.json() as T; // response schemas validate the shape server-side
}

/** A verified member with an avatar, listed (or not) in the directory. */
async function memberWithAvatar(options: { listed?: boolean; role?: "admin" | "member"; name?: string } = {}): Promise<EventActor> {
  const actor = await eventActor({
    role: options.role ?? "member",
    displayName: options.name ?? "Miembro de Prueba",
    profile: { listedInDirectory: options.listed ?? true }
  });
  const avatarKey = `avatars/${actor.user.id}/${randomUUID()}-256.webp`;
  await getTestDb().update(profiles).set({ avatarKey }).where(eq(profiles.userId, actor.user.id));
  return actor;
}

/** A published edition photo by `uploader`. */
async function editionPhoto(uploader: EventActor, year = 2031): Promise<string> {
  const edition = await createCuencada({ year });
  const row = await insertMedia({ cuencadaId: edition.id, uploadedByUserId: uploader.user.id });
  return row.id;
}

/** The person linked to `actor`. */
async function linkedPerson(actor: EventActor, fullName = "Persona Enlazada"): Promise<string> {
  return (await insertPerson({ userId: actor.user.id, fullName })).id;
}

async function detail(actor: EventActor, mediaId: string): Promise<MediaDetail> {
  const response = await call(actor, "GET", `/api/media/${mediaId}/detail`);
  expect(response.statusCode, response.body).toBe(200);
  return body<MediaDetail>(response);
}

async function personPhotos(actor: EventActor, personId: string): Promise<MediaItem[]> {
  const response = await call(actor, "GET", `/api/family/people/${personId}/photos`);
  expect(response.statusCode, response.body).toBe(200);
  return body<Page<MediaItem>>(response).items;
}

describe("scope first (ADR 0001 §8 requirement 1)", () => {
  it("answers 404 on every social route for a participants-only event photo and writes nothing", async () => {
    const organizer = await eventActor();
    const outsider = await eventActor();
    const target = await insertEvent({ organizerId: organizer.user.id, visibility: "participants" });
    const media = await insertAlbumMedia(target.album, { uploadedByUserId: organizer.user.id });
    const outsiderPerson = await linkedPerson(outsider);
    const [pending] = await getTestDb()
      .insert(mediaTags)
      .values({ mediaId: media.id, personId: outsiderPerson, taggedByUserId: organizer.user.id })
      .returning({ id: mediaTags.id });
    const [comment] = await getTestDb()
      .insert(mediaComments)
      .values({ mediaId: media.id, authorUserId: outsider.user.id, body: "Un comentario" })
      .returning({ id: mediaComments.id });
    if (pending === undefined || comment === undefined) throw new Error("fixtures");
    const person = await insertPerson();

    const probes: Array<[Method, string, Record<string, unknown>?]> = [
      ["GET", `/api/media/${media.id}/detail`],
      ["GET", `/api/media/${media.id}/tag-candidates?q=Persona`],
      ["POST", `/api/media/${media.id}/tags`, { personId: person.id }],
      ["POST", `/api/media/tags/${pending.id}/approve`],
      ["DELETE", `/api/media/${media.id}/tags/${pending.id}`],
      ["PUT", `/api/media/${media.id}/like`],
      ["DELETE", `/api/media/${media.id}/like`],
      ["GET", `/api/media/${media.id}/likes`],
      ["GET", `/api/media/${media.id}/comments`],
      ["POST", `/api/media/${media.id}/comments`, { body: "Hola" }],
      ["DELETE", `/api/media/comments/${comment.id}`],
      ["POST", `/api/media/comments/${comment.id}/report`, { reason: "other" }]
    ];
    for (const [method, url, payload] of probes) {
      const response = await call(outsider, method, url, payload);
      expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(404);
      expect(errorOf(response.body).code).toBe("NOT_FOUND");
    }
    const tags = await getTestDb().select().from(mediaTags).where(eq(mediaTags.mediaId, media.id));
    expect(tags.map((row) => row.status)).toEqual(["pending"]);
    const [stored] = await getTestDb().select().from(mediaComments).where(eq(mediaComments.id, comment.id));
    expect(stored?.deletedAt).toBeNull();
    expect(await personPhotos(outsider, outsiderPerson)).toEqual([]);
  });
});

describe("tag consent and the tagger-blind rule", () => {
  it("keeps a linked person's tag pending, hidden from third members and shown to the tagger as approved", async () => {
    const uploader = await eventActor();
    const tagger = await eventActor();
    const tagged = await eventActor();
    const third = await eventActor();
    const admin = await eventActor({ role: "admin" });
    const mediaId = await editionPhoto(uploader);
    const personId = await linkedPerson(tagged);

    const created = await call(tagger, "POST", `/api/media/${mediaId}/tags`, { personId, x: 0.25, y: 0.5 });
    expect(created.statusCode, created.body).toBe(201);
    const tag = body<MediaTag>(created);
    // [SEC] The tagger cannot tell a pending tag from an approved one.
    expect(tag).toMatchObject({ status: "approved", canApprove: false, isMe: false, canRemove: true, x: 0.25, y: 0.5 });
    const [row] = await getTestDb().select().from(mediaTags).where(eq(mediaTags.id, tag.id));
    expect(row?.status).toBe("pending");

    const taggerView = await detail(tagger, mediaId);
    expect(taggerView.tags).toEqual([tag]);
    expect(taggerView.item.tagCount).toBe(1);

    const thirdView = await detail(third, mediaId);
    expect(thirdView.tags).toEqual([]);
    expect(thirdView.item.tagCount).toBe(0);
    expect(await personPhotos(third, personId)).toEqual([]);
    const uploaderView = await detail(uploader, mediaId);
    expect(uploaderView.tags).toEqual([]);

    const taggedView = await detail(tagged, mediaId);
    expect(taggedView.tags).toEqual([expect.objectContaining({ id: tag.id, status: "pending", isMe: true, canApprove: true, canRemove: true })]);
    const adminView = await detail(admin, mediaId);
    expect(adminView.tags).toEqual([expect.objectContaining({ id: tag.id, status: "pending", canApprove: false })]);

    // Approve: only the tagged user; anyone else 404.
    for (const actor of [tagger, third, uploader, admin]) {
      const denied = await call(actor, "POST", `/api/media/tags/${tag.id}/approve`);
      expect(denied.statusCode, denied.body).toBe(404);
    }
    const approved = await call(tagged, "POST", `/api/media/tags/${tag.id}/approve`);
    expect(approved.statusCode, approved.body).toBe(200);
    expect(body<MediaTag>(approved)).toMatchObject({ status: "approved", canApprove: false, isMe: true });
    const again = await call(tagged, "POST", `/api/media/tags/${tag.id}/approve`);
    expect(again.statusCode).toBe(200);

    expect((await detail(third, mediaId)).tags).toEqual([expect.objectContaining({ id: tag.id, status: "approved", canRemove: false })]);
    expect((await personPhotos(third, personId)).map((item) => item.id)).toEqual([mediaId]);
    const audits = await getTestDb().select().from(auditLogs).where(eq(auditLogs.entityId, mediaId));
    expect(audits.map((entry) => entry.action).sort()).toEqual(["media.tag_approved", "media.tagged"]);
  });

  it("approves tags of people without accounts and self-tags at once", async () => {
    const uploader = await eventActor();
    const tagger = await eventActor();
    const third = await eventActor();
    const mediaId = await editionPhoto(uploader);
    const ancestor = await insertPerson({ fullName: "Abuela Ficticia", deceased: true });
    const self = await linkedPerson(tagger);

    for (const personId of [ancestor.id, self]) {
      const response = await call(tagger, "POST", `/api/media/${mediaId}/tags`, { personId });
      expect(response.statusCode, response.body).toBe(201);
    }
    const rows = await getTestDb().select({ status: mediaTags.status }).from(mediaTags).where(eq(mediaTags.mediaId, mediaId));
    expect(rows.map((row) => row.status)).toEqual(["approved", "approved"]);
    expect((await detail(third, mediaId)).tags).toHaveLength(2);
  });

  it("answers the existing tag (200) on a repeat, 400 for an unknown person and 409 over the cap", async () => {
    const uploader = await eventActor();
    const tagger = await eventActor();
    const mediaId = await editionPhoto(uploader);
    const person = await insertPerson();
    const first = await call(tagger, "POST", `/api/media/${mediaId}/tags`, { personId: person.id });
    const repeat = await call(tagger, "POST", `/api/media/${mediaId}/tags`, { personId: person.id });
    expect(first.statusCode).toBe(201);
    expect(repeat.statusCode).toBe(200);
    expect(body<MediaTag>(repeat).id).toBe(body<MediaTag>(first).id);

    const unknown = await call(tagger, "POST", `/api/media/${mediaId}/tags`, { personId: randomUUID() });
    expect(unknown.statusCode).toBe(400);
    expect(errorOf(unknown.body).detailCode).toBe("TAG_NOT_ALLOWED");

    for (let index = 1; index < 30; index += 1) {
      const extra = await insertPerson();
      await getTestDb().insert(mediaTags).values({ mediaId, personId: extra.id, status: "approved", approvedAt: new Date() });
    }
    const over = await call(tagger, "POST", `/api/media/${mediaId}/tags`, { personId: (await insertPerson()).id });
    expect(over.statusCode).toBe(409);
    expect(errorOf(over.body).detailCode).toBe("TAG_LIMIT");
    expect((await detail(tagger, mediaId)).canTag).toBe(false);
  });

  it("lets the tagged user decline (the tag disappears) and the tagger may tag again", async () => {
    const uploader = await eventActor();
    const tagger = await eventActor();
    const tagged = await eventActor();
    const mediaId = await editionPhoto(uploader);
    const personId = await linkedPerson(tagged);
    const tag = body<MediaTag>(await call(tagger, "POST", `/api/media/${mediaId}/tags`, { personId }));

    const declined = await call(tagged, "DELETE", `/api/media/${mediaId}/tags/${tag.id}`);
    expect(declined.statusCode, declined.body).toBe(204);
    expect((await detail(tagger, mediaId)).tags).toEqual([]);
    const [audit] = await getTestDb()
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, mediaId), eq(auditLogs.action, "media.untagged")));
    expect(audit?.metadata).toMatchObject({ tagId: tag.id, personId, status: "pending", by: "self" });
    const again = await call(tagger, "POST", `/api/media/${mediaId}/tags`, { personId });
    expect(again.statusCode).toBe(201);
  });

  it("limits removal to the tagger, the uploader (approved tags), the tagged user and admins", async () => {
    const uploader = await eventActor();
    const tagger = await eventActor();
    const third = await eventActor();
    const admin = await eventActor({ role: "admin" });
    const tagged = await eventActor();
    const mediaId = await editionPhoto(uploader);

    const approvedTag = body<MediaTag>(await call(tagger, "POST", `/api/media/${mediaId}/tags`, { personId: (await insertPerson()).id }));
    const thirdTry = await call(third, "DELETE", `/api/media/${mediaId}/tags/${approvedTag.id}`);
    expect(thirdTry.statusCode).toBe(404);
    expect((await call(uploader, "DELETE", `/api/media/${mediaId}/tags/${approvedTag.id}`)).statusCode).toBe(204);

    const pendingTag = body<MediaTag>(await call(tagger, "POST", `/api/media/${mediaId}/tags`, { personId: await linkedPerson(tagged) }));
    // The uploader cannot see someone else's pending tag, so cannot remove it.
    expect((await call(uploader, "DELETE", `/api/media/${mediaId}/tags/${pendingTag.id}`)).statusCode).toBe(404);
    // A tag id under another photo's path: 404.
    const otherPhoto = await editionPhoto(uploader, 2032);
    expect((await call(admin, "DELETE", `/api/media/${otherPhoto}/tags/${pendingTag.id}`)).statusCode).toBe(404);
    expect((await call(admin, "DELETE", `/api/media/${mediaId}/tags/${pendingTag.id}`)).statusCode).toBe(204);
  });
});

describe("hearts and likers", () => {
  it("is idempotent, lists likers by name and hides unlisted avatars and account ids", async () => {
    const uploader = await eventActor();
    const listed = await memberWithAvatar({ name: "Ana Listada" });
    const unlisted = await memberWithAvatar({ listed: false, name: "Beto Oculto" });
    const mediaId = await editionPhoto(uploader);

    for (const actor of [listed, unlisted]) {
      const first = await call(actor, "PUT", `/api/media/${mediaId}/like`);
      const second = await call(actor, "PUT", `/api/media/${mediaId}/like`);
      expect(first.statusCode, first.body).toBe(200);
      expect(body(second)).toMatchObject({ likedByMe: true });
    }
    const state = await call(uploader, "GET", `/api/media/${mediaId}/detail`);
    expect(body<MediaDetail>(state).likes).toEqual({ likeCount: 2, likedByMe: false });

    const likers = await call(uploader, "GET", `/api/media/${mediaId}/likes`);
    expect(likers.statusCode).toBe(200);
    const page = body<Page<MediaLiker>>(likers);
    expect(page.items.map((liker) => liker.name)).toEqual(["Beto Oculto", "Ana Listada"]);
    expect(page.items[0]?.avatarUrl).toBeNull();
    expect(page.items[1]?.avatarUrl).toEqual(expect.stringContaining("avatars/"));
    expect(likers.body).not.toContain(unlisted.user.id);
    expect(likers.body).not.toContain(unlisted.user.email);

    // The unlisted member still sees their own avatar.
    const own = body<Page<MediaLiker>>(await call(unlisted, "GET", `/api/media/${mediaId}/likes`));
    expect(own.items.find((liker) => liker.isMe)?.avatarUrl).toEqual(expect.stringContaining("avatars/"));

    const unliked = await call(listed, "DELETE", `/api/media/${mediaId}/like`);
    expect(body(unliked)).toEqual({ likeCount: 1, likedByMe: false });
    expect(body(await call(listed, "DELETE", `/api/media/${mediaId}/like`))).toEqual({ likeCount: 1, likedByMe: false });
  });

  it("pages likers newest first", async () => {
    const uploader = await eventActor();
    const mediaId = await editionPhoto(uploader);
    for (let index = 0; index < 3; index += 1) await call(await eventActor(), "PUT", `/api/media/${mediaId}/like`);
    const first = body<Page<MediaLiker>>(await call(uploader, "GET", `/api/media/${mediaId}/likes?limit=2`));
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = body<Page<MediaLiker>>(
      await call(uploader, "GET", `/api/media/${mediaId}/likes?limit=2&cursor=${first.nextCursor ?? ""}`)
    );
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
  });
});

describe("comments", () => {
  it("creates idempotently, validates the body and lists oldest first", async () => {
    const uploader = await eventActor();
    const author = await eventActor({ displayName: "Carla Autora" });
    const mediaId = await editionPhoto(uploader);
    const clientCommentId = randomUUID();
    const created = await call(author, "POST", `/api/media/${mediaId}/comments`, { body: "  Qué recuerdos  ", clientCommentId });
    expect(created.statusCode, created.body).toBe(201);
    const replay = await call(author, "POST", `/api/media/${mediaId}/comments`, { body: "otro texto", clientCommentId });
    expect(replay.statusCode).toBe(200);
    expect(body<MediaComment>(replay).id).toBe(body<MediaComment>(created).id);
    expect(body<MediaComment>(created)).toMatchObject({ body: "Qué recuerdos", deleted: false, canDelete: true, canModerate: false });

    const otherPhoto = await editionPhoto(uploader, 2033);
    const crossReplay = await call(author, "POST", `/api/media/${otherPhoto}/comments`, { body: "Hola", clientCommentId });
    expect(crossReplay.statusCode).toBe(409);

    for (const bad of ["", "   ", "x".repeat(1001)]) {
      const response = await call(author, "POST", `/api/media/${mediaId}/comments`, { body: bad });
      expect(response.statusCode, bad.slice(0, 10)).toBe(400);
    }
    expect((await call(author, "POST", `/api/media/${mediaId}/comments`, { body: "x".repeat(1000) })).statusCode).toBe(201);

    const list = body<Page<MediaComment>>(await call(uploader, "GET", `/api/media/${mediaId}/comments`));
    expect(list.items.map((comment) => comment.body.slice(0, 13))).toEqual(["Qué recuerdos", "xxxxxxxxxxxxx"]);
    expect(list.items[0]).toMatchObject({ author: { name: "Carla Autora", isMe: false }, canDelete: false });
    expect((await detail(uploader, mediaId)).item.commentCount).toBe(2);
  });

  it("lets only the author delete on the member route, scrubbing the body to a tombstone", async () => {
    const uploader = await eventActor();
    const author = await eventActor();
    const admin = await eventActor({ role: "admin" });
    const mediaId = await editionPhoto(uploader);
    const comment = body<MediaComment>(await call(author, "POST", `/api/media/${mediaId}/comments`, { body: "Texto secreto ficticio" }));

    for (const actor of [uploader, admin]) {
      const denied = await call(actor, "DELETE", `/api/media/comments/${comment.id}`);
      expect(denied.statusCode).toBe(404);
      expect(errorOf(denied.body).detailCode).toBe("COMMENT_NOT_FOUND");
    }
    expect((await call(author, "DELETE", `/api/media/comments/${comment.id}`)).statusCode).toBe(204);
    expect((await call(author, "DELETE", `/api/media/comments/${comment.id}`)).statusCode).toBe(204);

    const [stored] = await getTestDb().select().from(mediaComments).where(eq(mediaComments.id, comment.id));
    expect(stored).toMatchObject({ body: "", deletedByUserId: author.user.id });
    const list = await call(uploader, "GET", `/api/media/${mediaId}/comments`);
    expect(body<Page<MediaComment>>(list).items).toEqual([
      expect.objectContaining({ id: comment.id, deleted: true, body: "", author: null, canDelete: false })
    ]);
    const detailResponse = await call(uploader, "GET", `/api/media/${mediaId}/detail`);
    expect(detailResponse.body).not.toContain("Texto secreto ficticio");
    expect(body<MediaDetail>(detailResponse).commentCount).toBe(0);
  });

  it("reports (own 403, repeat 409) feed the admin queue; the admin delete is audited without the body", async () => {
    const uploader = await eventActor();
    const author = await eventActor({ displayName: "Dario Autor" });
    const reporter = await eventActor();
    const admin = await eventActor({ role: "admin" });
    const mediaId = await editionPhoto(uploader);
    const comment = body<MediaComment>(await call(author, "POST", `/api/media/${mediaId}/comments`, { body: "Comentario reportado" }));

    expect((await call(author, "POST", `/api/media/comments/${comment.id}/report`, { reason: "other" })).statusCode).toBe(403);
    expect((await call(reporter, "POST", `/api/media/comments/${comment.id}/report`, { reason: "inappropriate", details: "detalle" })).statusCode).toBe(204);
    expect((await call(reporter, "POST", `/api/media/comments/${comment.id}/report`, { reason: "other" })).statusCode).toBe(409);

    const queue = await call(admin, "GET", "/api/admin/media/comment-reports");
    expect(queue.statusCode, queue.body).toBe(200);
    expect(queue.json()).toMatchObject({
      items: [{ id: comment.id, mediaId, body: "Comentario reportado", authorName: "Dario Autor", reportCount: 1, deletedAt: null }]
    });

    expect((await call(admin, "DELETE", `/api/admin/media/comments/${comment.id}`)).statusCode).toBe(204);
    expect((await call(admin, "DELETE", `/api/admin/media/comments/${comment.id}`)).statusCode).toBe(204);
    const audits = await getTestDb().select().from(auditLogs).where(eq(auditLogs.entityId, comment.id));
    expect(audits.map((entry) => entry.action).sort()).toEqual(["media_comment.deleted", "media_comment.reported"]);
    expect(JSON.stringify(audits)).not.toContain("Comentario reportado");
    expect(JSON.stringify(audits)).not.toContain("detalle");

    const live = await call(admin, "GET", "/api/admin/media/comment-reports");
    expect(live.json()).toEqual({ items: [], nextCursor: null });
    const withDeleted = await call(admin, "GET", "/api/admin/media/comment-reports?includeDeleted=true");
    expect(withDeleted.json()).toMatchObject({ items: [{ id: comment.id, body: "", reportCount: 1 }] });
    expect(withDeleted.body).not.toContain("Comentario reportado");
  });

  it("hides unlisted authors' avatars from others", async () => {
    const uploader = await eventActor();
    const unlisted = await memberWithAvatar({ listed: false, name: "Eva Oculta" });
    const mediaId = await editionPhoto(uploader);
    await call(unlisted, "POST", `/api/media/${mediaId}/comments`, { body: "Hola" });
    const response = await call(uploader, "GET", `/api/media/${mediaId}/comments`);
    expect(body<Page<MediaComment>>(response).items[0]?.author).toEqual({ name: "Eva Oculta", avatarUrl: null, isMe: false });
    expect(response.body).not.toContain(unlisted.user.id);
  });
});

describe("tags PII", () => {
  it("shows unlisted and disabled members' tags and candidates by name only", async () => {
    const uploader = await eventActor();
    const viewer = await eventActor();
    const listed = await memberWithAvatar({ name: "Fernanda Listada" });
    const unlisted = await memberWithAvatar({ listed: false, name: "Fernanda Oculta" });
    const mediaId = await editionPhoto(uploader);
    const listedPerson = await linkedPerson(listed, "Fernanda Listada");
    const unlistedPerson = await linkedPerson(unlisted, "Fernanda Oculta");
    for (const personId of [listedPerson, unlistedPerson]) {
      await getTestDb().insert(mediaTags).values({ mediaId, personId, status: "approved", approvedAt: new Date() });
    }

    const view = await call(viewer, "GET", `/api/media/${mediaId}/detail`);
    const tags = body<MediaDetail>(view).tags;
    expect(tags.find((tag) => tag.person.id === unlistedPerson)?.person.avatarUrl).toBeNull();
    expect(tags.find((tag) => tag.person.id === listedPerson)?.person.avatarUrl).toEqual(expect.stringContaining("avatars/"));
    expect(view.body).not.toContain(unlisted.user.id);

    const candidates = await call(viewer, "GET", `/api/media/${mediaId}/tag-candidates?q=fernanda`);
    expect(candidates.statusCode, candidates.body).toBe(200);
    const items = body<{ items: TagCandidate[] }>(candidates).items;
    expect(items.map((item) => item.name).sort()).toEqual(["Fernanda Listada", "Fernanda Oculta"]);
    expect(items.find((item) => item.id === unlistedPerson)?.avatarUrl).toBeNull();
    expect(candidates.body).not.toContain(unlisted.user.id);
  });
});

describe("counts in gallery lists", () => {
  it("fills likeCount, likedByMe, commentCount and tagCount per viewer", async () => {
    const uploader = await eventActor();
    const fan = await eventActor();
    const tagged = await eventActor();
    const edition = await createCuencada({ year: 2034 });
    const media = await insertMedia({ cuencadaId: edition.id, uploadedByUserId: uploader.user.id });
    await call(fan, "PUT", `/api/media/${media.id}/like`);
    await call(fan, "POST", `/api/media/${media.id}/comments`, { body: "Hola" });
    await call(fan, "POST", `/api/media/${media.id}/tags`, { personId: (await insertPerson()).id });
    await call(fan, "POST", `/api/media/${media.id}/tags`, { personId: await linkedPerson(tagged) });

    const asFan = body<Page<MediaItem>>(await call(fan, "GET", "/api/cuencadas/2034/media")).items[0];
    expect(asFan).toMatchObject({ likeCount: 1, likedByMe: true, commentCount: 1, tagCount: 2 });
    const asUploader = body<Page<MediaItem>>(await call(uploader, "GET", "/api/cuencadas/2034/media")).items[0];
    expect(asUploader).toMatchObject({ likeCount: 1, likedByMe: false, commentCount: 1, tagCount: 1 });
  });
});

describe("counts in Memory Box lists (WP-6.3)", () => {
  it("fills the social counts on a published box's media page", async () => {
    const uploader = await eventActor();
    const fan = await eventActor();
    const box = await insertMemoryAlbum({ status: "published" });
    const media = await insertMemoryMedia(box, { uploadedByUserId: uploader.user.id });
    expect((await call(fan, "PUT", `/api/media/${media.id}/like`)).statusCode).toBe(200);
    await call(fan, "POST", `/api/media/${media.id}/comments`, { body: "Qué recuerdo" });
    const page = await call(fan, "GET", `/api/memories/${box.id}/media`);
    expect(page.statusCode, page.body).toBe(200);
    expect(body<Page<MediaItem>>(page).items[0]).toMatchObject({ likeCount: 1, likedByMe: true, commentCount: 1, tagCount: 0 });
  });
});

describe("Fotos de {persona}", () => {
  it("lists only photos the viewer can see, in published editions", async () => {
    const uploader = await eventActor();
    const viewer = await eventActor();
    const person = await insertPerson({ fullName: "Gilberto Ficticio" });
    const published = await createCuencada({ year: 2035 });
    const draft = await createCuencada({ year: 2036, isPublished: false });
    const visible = await insertMedia({ cuencadaId: published.id, uploadedByUserId: uploader.user.id });
    const inDraft = await insertMedia({ cuencadaId: draft.id, uploadedByUserId: uploader.user.id });
    const hidden = await insertMedia({ cuencadaId: published.id, uploadedByUserId: uploader.user.id, moderationStatus: "hidden" });
    const privateEvent = await insertEvent({ organizerId: uploader.user.id, visibility: "participants" });
    const eventPhoto = await insertAlbumMedia(privateEvent.album, { uploadedByUserId: uploader.user.id });
    for (const mediaId of [visible.id, inDraft.id, hidden.id, eventPhoto.id]) {
      await getTestDb().insert(mediaTags).values({ mediaId, personId: person.id, status: "approved", approvedAt: new Date() });
    }
    expect((await personPhotos(viewer, person.id)).map((item) => item.id)).toEqual([visible.id]);
    // The organizer sees the event photo; a hidden photo is out even for its uploader.
    expect((await personPhotos(uploader, person.id)).map((item) => item.id).sort()).toEqual([eventPhoto.id, visible.id].sort());
    expect((await call(viewer, "GET", `/api/family/people/${randomUUID()}/photos`)).statusCode).toBe(404);
  });
});

describe("moveMediaTagsTx", () => {
  it("moves tags, keeps the approved one on a duplicate photo and re-pends tags the kept account never approved", async () => {
    const uploader = await eventActor();
    const keepUser = await eventActor();
    const mediaA = await editionPhoto(uploader, 2037);
    const mediaB = await editionPhoto(uploader, 2038);
    const mediaC = await editionPhoto(uploader, 2039);
    const keep = await linkedPerson(keepUser, "Hilda Conservada");
    const duplicate = (await insertPerson({ fullName: "Hilda Duplicada" })).id;
    const db = getTestDb();
    const now = new Date();
    // A: both tagged; keep's pending, duplicate's approved (but keep is linked → re-pended → keep's wins).
    await db.insert(mediaTags).values({ mediaId: mediaA, personId: keep, status: "pending" });
    await db.insert(mediaTags).values({ mediaId: mediaA, personId: duplicate, status: "approved", approvedAt: now });
    // B: only the duplicate, approved, tagged by someone else → pending on keep.
    await db.insert(mediaTags).values({ mediaId: mediaB, personId: duplicate, status: "approved", approvedAt: now, taggedByUserId: uploader.user.id });
    // C: only the duplicate, a self-tag by the kept account → stays approved.
    await db.insert(mediaTags).values({ mediaId: mediaC, personId: duplicate, status: "approved", approvedAt: now, taggedByUserId: keepUser.user.id });

    const result = await db.transaction((tx) => moveMediaTagsTx(tx, duplicate, keep));
    expect(result).toEqual({ moved: 2, dropped: 1 });
    const rows = await db.select().from(mediaTags).orderBy(mediaTags.mediaId);
    const byMedia = new Map(rows.map((row) => [row.mediaId, row]));
    expect(rows.every((row) => row.personId === keep)).toBe(true);
    expect(byMedia.get(mediaA)?.status).toBe("pending");
    expect(byMedia.get(mediaB)).toMatchObject({ status: "pending", approvedAt: null });
    expect(byMedia.get(mediaC)?.status).toBe("approved");
    expect(await db.select().from(people).where(eq(people.id, duplicate))).toHaveLength(1);
  });

  it("keeps statuses when the kept person has no account and prefers an approved duplicate tag", async () => {
    const uploader = await eventActor();
    const mediaId = await editionPhoto(uploader, 2040);
    const keep = (await insertPerson()).id;
    const duplicate = (await insertPerson()).id;
    const db = getTestDb();
    await db.insert(mediaTags).values({ mediaId, personId: keep, status: "pending" });
    const [winner] = await db
      .insert(mediaTags)
      .values({ mediaId, personId: duplicate, status: "approved", approvedAt: new Date() })
      .returning({ id: mediaTags.id });
    const result = await db.transaction((tx) => moveMediaTagsTx(tx, duplicate, keep));
    expect(result).toEqual({ moved: 1, dropped: 1 });
    const rows = await db.select().from(mediaTags);
    expect(rows).toEqual([expect.objectContaining({ id: winner?.id, personId: keep, status: "approved" })]);
  });
});
