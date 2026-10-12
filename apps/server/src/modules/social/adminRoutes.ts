/**
 * Admin comment moderation (WP-6.2, ADR 0001 §8): the reported-comments
 * queue and the audited delete. Mounted under `/api`; admin-only.
 */
import { adminCommentReportsQuerySchema, adminReportedCommentPageSchema, mediaCommentParamsSchema } from "@cuencada/types";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { authUser } from "../../plugins/auth.js";
import { mediaErrorResponses, noContentSchema, viewerOf } from "../media/shared.js";
import { listReportedComments, moderateDeleteComment } from "./comments.js";

/** Admin social routes. */
const adminSocialRoutes: FastifyPluginAsyncZod = async (app) => {
  /** GET /api/admin/media/comment-reports — reported comments, newest report first. */
  app.get(
    "/admin/media/comment-reports",
    {
      config: { auth: "admin" },
      schema: {
        querystring: adminCommentReportsQuerySchema,
        response: { 200: adminReportedCommentPageSchema, ...mediaErrorResponses }
      }
    },
    async (request) =>
      listReportedComments(app.db, {
        limit: request.query.limit,
        cursor: request.query.cursor,
        includeDeleted: request.query.includeDeleted === true
      })
  );

  /** DELETE /api/admin/media/comments/:id — moderation delete (body scrubbed; audited `media_comment.deleted`). */
  app.delete(
    "/admin/media/comments/:id",
    {
      config: { auth: "admin" },
      schema: { params: mediaCommentParamsSchema, response: { 204: noContentSchema, ...mediaErrorResponses } }
    },
    async (request, reply) => {
      await moderateDeleteComment(app, request.params.id, viewerOf(authUser(request)), request.ip);
      return reply.code(204).send();
    }
  );
};

export default adminSocialRoutes;
