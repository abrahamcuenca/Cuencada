/**
 * Member photo social routes (WP-6.2, ADR 0001 §8): detail, tags, hearts,
 * comments, and "Fotos de {persona}". Mounted under `/api`; every route is
 * for verified members.
 *
 * [SEC] Every route first resolves the photo under the caller's scope
 * (`findViewableRecord` / `lockViewableMedia`, i.e. `viewableSql`) and
 * answers 404 `NOT_FOUND` before any other check; a comment or tag addressed
 * by its own id is resolved through its photo with the same predicate.
 */
import {
  createMediaCommentInputSchema,
  createMediaTagInputSchema,
  idParamSchema,
  type MediaDetail,
  MEDIA_COMMENTS_PAGE_DEFAULT,
  mediaCommentPageSchema,
  mediaCommentParamsSchema,
  mediaCommentSchema,
  mediaCommentsQuerySchema,
  mediaDetailSchema,
  mediaItemSchema,
  mediaLikerPageSchema,
  mediaLikersQuerySchema,
  mediaLikeStateSchema,
  mediaListQuerySchema,
  MEDIA_TAGS_MAX,
  mediaTagIdParamsSchema,
  mediaTagParamsSchema,
  mediaTagSchema,
  pageSchema,
  reportMediaCommentInputSchema,
  tagCandidateListSchema,
  tagCandidatesQuerySchema
} from "@cuencada/types";
import { eq } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { people } from "../../db/schema/index.js";
import { AppError } from "../../lib/errors.js";
import { authUser } from "../../plugins/auth.js";
import { AdminViewSurface, auditAdminEventView } from "../events/adminView.js";
import { findViewableRecord, isAdmin, listViewable, toMediaItem } from "../media/service.js";
import { mediaErrorResponses, noContentSchema, rateLimitByUser, viewerOf } from "../media/shared.js";
import { taggedPersonSql } from "../media/socialSql.js";
import { createComment, deleteOwnComment, listComments, reportComment } from "./comments.js";
import { listLikers, setLike } from "./likes.js";
import { mediaNotFound, SocialRateLimit } from "./shared.js";
import { approveTag, createTag, listVisibleTags, removeTag, searchTagCandidates } from "./tags.js";

const member = { auth: "user", requireVerifiedEmail: true } as const;

/** Member social routes. */
const socialRoutes: FastifyPluginAsyncZod = async (app) => {
  /**
   * GET /api/media/:id/detail — what the lightbox shows (also the lazy load
   * behind `?foto=<id>`). An admin outside a `participants` event opening
   * its album media is audited like `GET /api/media/:id`.
   */
  app.get(
    "/media/:id/detail",
    {
      config: member,
      schema: { params: idParamSchema, response: { 200: mediaDetailSchema, ...mediaErrorResponses } }
    },
    async (request): Promise<MediaDetail> => {
      const viewer = viewerOf(authUser(request));
      const record = await findViewableRecord(app.db, request.params.id, viewer);
      if (record === null) throw mediaNotFound();
      if (record.album !== null && isAdmin(viewer)) {
        await auditAdminEventView(app.db, {
          viewer,
          eventId: record.album.eventId,
          surface: AdminViewSurface.Media,
          ip: request.ip,
          now: app.clock.now()
        });
      }
      const [item, tags, comments] = await Promise.all([
        toMediaItem(app.storage, record, viewer),
        listVisibleTags(app, app.db, record.item.id, viewer, record.item.uploadedByUserId),
        listComments(app, record.item.id, viewer, { limit: MEDIA_COMMENTS_PAGE_DEFAULT })
      ]);
      const social = record.social ?? { likeCount: 0, likedByMe: false, commentCount: 0, tagCount: 0 };
      return {
        item,
        tags,
        likes: { likeCount: social.likeCount, likedByMe: social.likedByMe },
        commentCount: social.commentCount,
        comments,
        canTag: tags.length < MEDIA_TAGS_MAX
      };
    }
  );

  /** GET /api/media/:id/tag-candidates — the person picker (any person; name only for hidden members). */
  app.get(
    "/media/:id/tag-candidates",
    {
      config: { ...member, rateLimit: rateLimitByUser("social-tag-candidates", SocialRateLimit.tagCandidates) },
      schema: {
        params: idParamSchema,
        querystring: tagCandidatesQuerySchema,
        response: { 200: tagCandidateListSchema, ...mediaErrorResponses }
      }
    },
    async (request) => {
      const viewer = viewerOf(authUser(request));
      const record = await findViewableRecord(app.db, request.params.id, viewer);
      if (record === null) throw mediaNotFound();
      return { items: await searchTagCandidates(app, request.query.q, request.query.limit, viewer) };
    }
  );

  /** POST /api/media/:id/tags — tag a person (201 new, 200 already tagged). */
  app.post(
    "/media/:id/tags",
    {
      config: { ...member, rateLimit: rateLimitByUser("social-tags", SocialRateLimit.tags) },
      schema: {
        params: idParamSchema,
        body: createMediaTagInputSchema,
        response: { 200: mediaTagSchema, 201: mediaTagSchema, ...mediaErrorResponses }
      }
    },
    async (request, reply) => {
      const viewer = viewerOf(authUser(request));
      const { personId, x, y } = request.body;
      const result = await createTag(
        app,
        { mediaId: request.params.id, personId, ...(x === undefined || y === undefined ? {} : { x, y }) },
        viewer,
        request.ip
      );
      return reply.code(result.created ? 201 : 200).send(result.tag);
    }
  );

  /** POST /api/media/tags/:id/approve — the tagged person's user approves (404 for anyone else). */
  app.post(
    "/media/tags/:id/approve",
    {
      config: { ...member, rateLimit: rateLimitByUser("social-tag-consent", SocialRateLimit.tagConsent) },
      schema: { params: mediaTagIdParamsSchema, response: { 200: mediaTagSchema, ...mediaErrorResponses } }
    },
    async (request) => approveTag(app, request.params.id, viewerOf(authUser(request)), request.ip)
  );

  /** DELETE /api/media/:id/tags/:tagId — remove, or decline a pending tag (tagger, uploader, tagged user, admin). */
  app.delete(
    "/media/:id/tags/:tagId",
    {
      config: { ...member, rateLimit: rateLimitByUser("social-tag-consent", SocialRateLimit.tagConsent) },
      schema: { params: mediaTagParamsSchema, response: { 204: noContentSchema, ...mediaErrorResponses } }
    },
    async (request, reply) => {
      await removeTag(app, request.params.id, request.params.tagId, viewerOf(authUser(request)), request.ip);
      return reply.code(204).send();
    }
  );

  /** PUT /api/media/:id/like — give a heart (idempotent). */
  app.put(
    "/media/:id/like",
    {
      config: { ...member, rateLimit: rateLimitByUser("social-like", SocialRateLimit.likes) },
      schema: { params: idParamSchema, response: { 200: mediaLikeStateSchema, ...mediaErrorResponses } }
    },
    async (request) => setLike(app, request.params.id, viewerOf(authUser(request)), true)
  );

  /** DELETE /api/media/:id/like — take the heart back (idempotent). */
  app.delete(
    "/media/:id/like",
    {
      config: { ...member, rateLimit: rateLimitByUser("social-like", SocialRateLimit.likes) },
      schema: { params: idParamSchema, response: { 200: mediaLikeStateSchema, ...mediaErrorResponses } }
    },
    async (request) => setLike(app, request.params.id, viewerOf(authUser(request)), false)
  );

  /** GET /api/media/:id/likes — who gave a heart (newest first; names, avatars only for listed members). */
  app.get(
    "/media/:id/likes",
    {
      config: { ...member, rateLimit: rateLimitByUser("social-likers", SocialRateLimit.likers) },
      schema: {
        params: idParamSchema,
        querystring: mediaLikersQuerySchema,
        response: { 200: mediaLikerPageSchema, ...mediaErrorResponses }
      }
    },
    async (request) => {
      const viewer = viewerOf(authUser(request));
      const record = await findViewableRecord(app.db, request.params.id, viewer);
      if (record === null) throw mediaNotFound();
      return listLikers(app, record.item.id, viewer, { limit: request.query.limit, cursor: request.query.cursor });
    }
  );

  /** GET /api/media/:id/comments — oldest first. */
  app.get(
    "/media/:id/comments",
    {
      config: member,
      schema: {
        params: idParamSchema,
        querystring: mediaCommentsQuerySchema,
        response: { 200: mediaCommentPageSchema, ...mediaErrorResponses }
      }
    },
    async (request) => {
      const viewer = viewerOf(authUser(request));
      const record = await findViewableRecord(app.db, request.params.id, viewer);
      if (record === null) throw mediaNotFound();
      return listComments(app, record.item.id, viewer, { limit: request.query.limit, cursor: request.query.cursor });
    }
  );

  /** POST /api/media/:id/comments — 201 new, 200 on a `clientCommentId` replay. */
  app.post(
    "/media/:id/comments",
    {
      config: { ...member, rateLimit: rateLimitByUser("social-comments", SocialRateLimit.comments) },
      schema: {
        params: idParamSchema,
        body: createMediaCommentInputSchema,
        response: { 200: mediaCommentSchema, 201: mediaCommentSchema, ...mediaErrorResponses }
      }
    },
    async (request, reply) => {
      const { body, clientCommentId } = request.body;
      const result = await createComment(
        app,
        request.params.id,
        { body, ...(clientCommentId === undefined ? {} : { clientCommentId }) },
        viewerOf(authUser(request))
      );
      return reply.code(result.created ? 201 : 200).send(result.comment);
    }
  );

  /** DELETE /api/media/comments/:id — the author only (404 `COMMENT_NOT_FOUND` for anyone else). */
  app.delete(
    "/media/comments/:id",
    {
      config: member,
      schema: { params: mediaCommentParamsSchema, response: { 204: noContentSchema, ...mediaErrorResponses } }
    },
    async (request, reply) => {
      await deleteOwnComment(app, request.params.id, viewerOf(authUser(request)));
      return reply.code(204).send();
    }
  );

  /** POST /api/media/comments/:id/report — once per member per comment (409 on repeat; own: 403). */
  app.post(
    "/media/comments/:id/report",
    {
      config: { ...member, rateLimit: rateLimitByUser("social-comment-report", SocialRateLimit.commentReports) },
      schema: {
        params: mediaCommentParamsSchema,
        body: reportMediaCommentInputSchema,
        response: { 204: noContentSchema, ...mediaErrorResponses }
      }
    },
    async (request, reply) => {
      await reportComment(app, request.params.id, request.body, viewerOf(authUser(request)), request.ip);
      return reply.code(204).send();
    }
  );

  /**
   * GET /api/family/people/:id/photos — "Fotos de {persona}": photos the
   * caller can see (published editions only for edition media) where the
   * person has a tag visible to the caller. 404 for an unknown person.
   */
  app.get(
    "/family/people/:id/photos",
    {
      config: member,
      schema: {
        params: idParamSchema,
        querystring: mediaListQuerySchema,
        response: { 200: pageSchema(mediaItemSchema), ...mediaErrorResponses }
      }
    },
    async (request) => {
      const viewer = viewerOf(authUser(request));
      const [person] = await app.db.select({ id: people.id }).from(people).where(eq(people.id, request.params.id)).limit(1);
      if (person === undefined) throw new AppError("NOT_FOUND", "No encontramos a esa persona.");
      const page = await listViewable(app.db, {
        viewer,
        where: taggedPersonSql(viewer, person.id),
        limit: request.query.limit,
        cursor: request.query.cursor,
        kind: request.query.kind
      });
      const items = await Promise.all(page.records.map((record) => toMediaItem(app.storage, record, viewer)));
      return { items, nextCursor: page.nextCursor };
    }
  );
};

export default socialRoutes;
