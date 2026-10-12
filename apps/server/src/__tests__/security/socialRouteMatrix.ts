/**
 * Authorization-matrix entries for the photo social routes (WP-6.2) [SEC].
 * Spread into `ROUTE_MATRIX` (`routeMatrix.ts`); same contract as the other
 * matrix files.
 *
 * Probes: every route on a photo the caller cannot see (an event-album photo
 * of another member's `participants` event) answers 404 and changes no
 * social row (ADR 0001 §8 requirement 1); plus each route's own rules
 * (author-only delete, tagged-user-only approve, remove rights, own report).
 */
import { eq, inArray } from "drizzle-orm";
import { commentReports, mediaComments, mediaLikes, mediaTags, people } from "../../db/schema/index.js";
import { insertAlbumMedia, insertEvent } from "../../../test/helpers/events.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { createUser } from "../../../test/helpers/factories.js";
import { insertPerson } from "../../../test/helpers/family.js";
import { insertCuencada } from "../../../test/helpers/cuencadas.js";
import { insertMedia } from "../../../test/helpers/media.js";
import { memoryMediaProbes } from "./memoryRouteMatrix.js";
import type { Actor, BuiltRequest, Expectation, MatrixContext, Probe, ProbeRequest, RouteSpec } from "./routeMatrix.js";

const NOT_FOUND: Expectation = { status: 404, code: "NOT_FOUND" };
const FORBIDDEN: Expectation = { status: 403, code: "FORBIDDEN" };

const json = (url: string, payload?: unknown): BuiltRequest => (payload === undefined ? { url } : { url, payload });
const member = { auth: "user", requireVerifiedEmail: true } as const;

/** A ready, approved edition photo uploaded by `owner`. */
async function editionPhoto(ctx: MatrixContext, owner: Actor): Promise<string> {
  const edition = await insertCuencada({ year: ctx.nextYear() });
  const row = await insertMedia({ cuencadaId: edition.id, uploadedByUserId: owner.user.id });
  return row.id;
}

/** A ready photo in another member's `participants` event the caller is not in. */
async function hiddenEventPhoto(ctx: MatrixContext): Promise<string> {
  const target = await insertEvent({ organizerId: ctx.other.user.id, visibility: "participants" });
  const row = await insertAlbumMedia(target.album, { uploadedByUserId: ctx.other.user.id });
  return row.id;
}

/** The caller's linked person (created once per account). */
async function personOf(actor: Actor): Promise<string> {
  const [existing] = await getTestDb().select({ id: people.id }).from(people).where(eq(people.userId, actor.user.id)).limit(1);
  return existing?.id ?? (await insertPerson({ userId: actor.user.id, fullName: "Persona Enlazada" })).id;
}

/** A tag of `personId` on `mediaId` by `taggerId`. */
async function insertTag(mediaId: string, personId: string, taggerId: string, status: "pending" | "approved"): Promise<string> {
  const [row] = await getTestDb()
    .insert(mediaTags)
    .values({ mediaId, personId, taggedByUserId: taggerId, status, approvedAt: status === "approved" ? new Date() : null })
    .returning({ id: mediaTags.id });
  if (row === undefined) throw new Error("insertTag: no row");
  return row.id;
}

/** A live comment on `mediaId` by `author`. */
async function insertComment(mediaId: string, author: Actor): Promise<string> {
  const [row] = await getTestDb()
    .insert(mediaComments)
    .values({ mediaId, authorUserId: author.user.id, body: "Qué bonita foto" })
    .returning({ id: mediaComments.id });
  if (row === undefined) throw new Error("insertComment: no row");
  return row.id;
}

/** Every social row of one photo (compared before/after a probe). */
function socialState(mediaId: string): () => Promise<unknown> {
  return async () => {
    const db = getTestDb();
    const comments = await db.select().from(mediaComments).where(eq(mediaComments.mediaId, mediaId)).orderBy(mediaComments.id);
    const commentIds = comments.map((row) => row.id);
    return {
      tags: await db.select().from(mediaTags).where(eq(mediaTags.mediaId, mediaId)).orderBy(mediaTags.id),
      likes: await db.select().from(mediaLikes).where(eq(mediaLikes.mediaId, mediaId)).orderBy(mediaLikes.userId),
      comments,
      reports:
        commentIds.length === 0
          ? []
          : await db.select().from(commentReports).where(inArray(commentReports.commentId, commentIds)).orderBy(commentReports.id)
    };
  };
}

type PhotoRequest = (ctx: MatrixContext, mediaId: string) => Promise<BuiltRequest> | BuiltRequest;

/** A photo of a `participants` event the caller is not in: 404, nothing changes. */
function hiddenPhotoProbe(request: PhotoRequest): Probe {
  return {
    label: "a photo of another member's participants-only event",
    kind: "idor",
    build: async (ctx): Promise<ProbeRequest> => {
      const mediaId = await hiddenEventPhoto(ctx);
      return { ...(await request(ctx, mediaId)), state: socialState(mediaId) };
    },
    expect: NOT_FOUND
  };
}

/** Matrix entries of the social module (member and admin routes). */
export const SOCIAL_ROUTE_SPECS: readonly RouteSpec[] = [
  {
    method: "GET",
    url: "/api/media/:id/detail",
    ...member,
    note: "pending tags only for the tagger, the tagged user and admins",
    build: async (ctx) => json(`/api/media/${await editionPhoto(ctx, ctx.other)}/detail`),
    probes: [hiddenPhotoProbe((_ctx, id) => json(`/api/media/${id}/detail`)), ...memoryMediaProbes((id) => json(`/api/media/${id}/detail`))]
  },
  {
    method: "GET",
    url: "/api/media/:id/tag-candidates",
    ...member,
    note: "any person; name only for unlisted/disabled members",
    build: async (ctx) => json(`/api/media/${await editionPhoto(ctx, ctx.other)}/tag-candidates?q=Persona`),
    probes: [
      hiddenPhotoProbe((_ctx, id) => json(`/api/media/${id}/tag-candidates?q=Persona`)),
      ...memoryMediaProbes((id) => json(`/api/media/${id}/tag-candidates?q=Persona`))
    ]
  },
  {
    method: "POST",
    url: "/api/media/:id/tags",
    ...member,
    note: "pending for linked people (the tagger sees it as approved); 30 per photo",
    build: async (ctx) =>
      json(`/api/media/${await editionPhoto(ctx, ctx.other)}/tags`, { personId: (await insertPerson()).id }),
    probes: [
      hiddenPhotoProbe(async (_ctx, id) => json(`/api/media/${id}/tags`, { personId: (await insertPerson()).id }))
    ]
  },
  {
    method: "POST",
    url: "/api/media/tags/:id/approve",
    ...member,
    owner: "the tagged person's linked user only",
    build: async (ctx) => {
      const mediaId = await editionPhoto(ctx, ctx.other);
      return json(`/api/media/tags/${await insertTag(mediaId, await personOf(ctx.actor), ctx.other.user.id, "pending")}/approve`);
    },
    probes: [
      {
        label: "another member's pending tag",
        kind: "idor",
        build: async (ctx) => {
          const mediaId = await editionPhoto(ctx, ctx.actor);
          const tagId = await insertTag(mediaId, await personOf(ctx.other), ctx.actor.user.id, "pending");
          return { ...json(`/api/media/tags/${tagId}/approve`), state: socialState(mediaId) };
        },
        expect: NOT_FOUND
      },
      {
        label: "own pending tag on a participants-only event photo",
        kind: "idor",
        build: async (ctx) => {
          const mediaId = await hiddenEventPhoto(ctx);
          const tagId = await insertTag(mediaId, await personOf(ctx.actor), ctx.other.user.id, "pending");
          return { ...json(`/api/media/tags/${tagId}/approve`), state: socialState(mediaId) };
        },
        expect: NOT_FOUND
      }
    ]
  },
  {
    method: "DELETE",
    url: "/api/media/:id/tags/:tagId",
    ...member,
    owner: "the tagger, the uploader, the tagged person's user, admins",
    build: async (ctx) => {
      const mediaId = await editionPhoto(ctx, ctx.other);
      const tagId = await insertTag(mediaId, (await insertPerson()).id, ctx.actor.user.id, "approved");
      return json(`/api/media/${mediaId}/tags/${tagId}`);
    },
    probes: [
      {
        label: "a tag someone else made on someone else's photo",
        kind: "idor",
        build: async (ctx) => {
          const mediaId = await editionPhoto(ctx, ctx.other);
          const tagId = await insertTag(mediaId, (await insertPerson()).id, ctx.other.user.id, "approved");
          return { ...json(`/api/media/${mediaId}/tags/${tagId}`), state: socialState(mediaId) };
        },
        expect: NOT_FOUND
      },
      {
        label: "uploader on someone else's pending tag (invisible to them)",
        kind: "rule",
        build: async (ctx) => {
          const mediaId = await editionPhoto(ctx, ctx.actor);
          const tagged = await insertPerson({ userId: (await createUser({ emailVerified: true })).id });
          const tagId = await insertTag(mediaId, tagged.id, ctx.other.user.id, "pending");
          return { ...json(`/api/media/${mediaId}/tags/${tagId}`), state: socialState(mediaId) };
        },
        expect: NOT_FOUND
      },
      hiddenPhotoProbe(async (ctx, id) => json(`/api/media/${id}/tags/${await insertTag(id, (await insertPerson()).id, ctx.actor.user.id, "approved")}`))
    ]
  },
  {
    method: "PUT",
    url: "/api/media/:id/like",
    ...member,
    build: async (ctx) => json(`/api/media/${await editionPhoto(ctx, ctx.other)}/like`),
    probes: [hiddenPhotoProbe((_ctx, id) => json(`/api/media/${id}/like`)), ...memoryMediaProbes((id) => json(`/api/media/${id}/like`))]
  },
  {
    method: "DELETE",
    url: "/api/media/:id/like",
    ...member,
    build: async (ctx) => json(`/api/media/${await editionPhoto(ctx, ctx.other)}/like`),
    probes: [
      {
        label: "a photo of another member's participants-only event (with a heart)",
        kind: "idor",
        build: async (ctx) => {
          const mediaId = await hiddenEventPhoto(ctx);
          await getTestDb().insert(mediaLikes).values({ mediaId, userId: ctx.actor.user.id });
          return { ...json(`/api/media/${mediaId}/like`), state: socialState(mediaId) };
        },
        expect: NOT_FOUND
      }
    ]
  },
  {
    method: "GET",
    url: "/api/media/:id/likes",
    ...member,
    note: "names; avatars only for listed active members; no account ids",
    build: async (ctx) => json(`/api/media/${await editionPhoto(ctx, ctx.other)}/likes`),
    probes: [hiddenPhotoProbe((_ctx, id) => json(`/api/media/${id}/likes`)), ...memoryMediaProbes((id) => json(`/api/media/${id}/likes`))]
  },
  {
    method: "GET",
    url: "/api/media/:id/comments",
    ...member,
    note: "deleted comments are tombstones (no body, no author)",
    build: async (ctx) => json(`/api/media/${await editionPhoto(ctx, ctx.other)}/comments`),
    probes: [hiddenPhotoProbe((_ctx, id) => json(`/api/media/${id}/comments`)), ...memoryMediaProbes((id) => json(`/api/media/${id}/comments`))]
  },
  {
    method: "POST",
    url: "/api/media/:id/comments",
    ...member,
    build: async (ctx) => json(`/api/media/${await editionPhoto(ctx, ctx.other)}/comments`, { body: "Hola" }),
    probes: [
      hiddenPhotoProbe((_ctx, id) => json(`/api/media/${id}/comments`, { body: "Hola" })),
      ...memoryMediaProbes((id) => json(`/api/media/${id}/comments`, { body: "Hola" }))
    ]
  },
  {
    method: "DELETE",
    url: "/api/media/comments/:id",
    ...member,
    owner: "the author only (admins moderate on the admin route)",
    build: async (ctx) => json(`/api/media/comments/${await insertComment(await editionPhoto(ctx, ctx.other), ctx.actor)}`),
    probes: [
      {
        label: "another member's comment",
        kind: "idor",
        build: async (ctx) => {
          const mediaId = await editionPhoto(ctx, ctx.actor);
          const commentId = await insertComment(mediaId, ctx.other);
          return { ...json(`/api/media/comments/${commentId}`), state: socialState(mediaId) };
        },
        expect: NOT_FOUND
      },
      {
        label: "own comment on a participants-only event photo the caller left",
        kind: "idor",
        build: async (ctx) => {
          const mediaId = await hiddenEventPhoto(ctx);
          const commentId = await insertComment(mediaId, ctx.actor);
          return { ...json(`/api/media/comments/${commentId}`), state: socialState(mediaId) };
        },
        expect: NOT_FOUND
      }
    ]
  },
  {
    method: "POST",
    url: "/api/media/comments/:id/report",
    ...member,
    owner: "any viewer except the author (403 on own comments)",
    build: async (ctx) =>
      json(`/api/media/comments/${await insertComment(await editionPhoto(ctx, ctx.other), ctx.other)}/report`, { reason: "other" }),
    probes: [
      {
        label: "report own comment",
        kind: "rule",
        build: async (ctx) => {
          const mediaId = await editionPhoto(ctx, ctx.other);
          const commentId = await insertComment(mediaId, ctx.actor);
          return { ...json(`/api/media/comments/${commentId}/report`, { reason: "other" }), state: socialState(mediaId) };
        },
        expect: FORBIDDEN
      },
      {
        label: "a comment on a participants-only event photo",
        kind: "idor",
        build: async (ctx) => {
          const mediaId = await hiddenEventPhoto(ctx);
          const commentId = await insertComment(mediaId, ctx.other);
          return { ...json(`/api/media/comments/${commentId}/report`, { reason: "other" }), state: socialState(mediaId) };
        },
        expect: NOT_FOUND
      }
    ]
  },
  {
    method: "GET",
    url: "/api/family/people/:id/photos",
    ...member,
    note: "approved tags (plus the caller's own pending ones) on photos the caller can see; published editions only",
    build: async () => json(`/api/family/people/${(await insertPerson()).id}/photos`)
  },
  {
    method: "GET",
    url: "/api/admin/media/comment-reports",
    auth: "admin",
    build: async () => json("/api/admin/media/comment-reports")
  },
  {
    method: "DELETE",
    url: "/api/admin/media/comments/:id",
    auth: "admin",
    note: "audited media_comment.deleted (ids only); the body is scrubbed",
    build: async (ctx) => json(`/api/admin/media/comments/${await insertComment(await editionPhoto(ctx, ctx.other), ctx.other)}`)
  }
];
