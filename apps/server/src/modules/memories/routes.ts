/**
 * Memory Box member routes (WP-6.3, ADR 0001 §8) under `/api/memories`.
 * Verified members only (`auth: "user"` + `requireVerifiedEmail`), like the
 * gallery. [SEC] A draft or hidden box answers 404 `MEMORY_ALBUM_NOT_FOUND`
 * to members on every route, the same as a missing one; admins reach every
 * box. Confirm, caption, delete, report and the social routes of box media
 * are the gallery's `/api/media/:id…` routes, which apply `mediaScopeSql`
 * (published-box branch).
 */
import {
  createUploadInputSchema,
  createUploadResponseSchema,
  idParamSchema,
  MEMORY_ALBUMS_MAX,
  type MemoryAlbumDetail,
  type MemoryAlbumList,
  memoryAlbumDetailSchema,
  memoryAlbumListSchema,
  mediaItemSchema,
  mediaListQuerySchema,
  pageSchema
} from "@cuencada/types";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { authUser } from "../../plugins/auth.js";
import { UPLOAD_INTENT_RATE_LIMIT } from "../media/constants.js";
import { memoryStoragePrefix } from "../media/files.js";
import { listGallery, toMediaItem } from "../media/service.js";
import { mediaErrorResponses, rateLimitByUser, viewerOf } from "../media/shared.js";
import { createPendingUpload } from "../media/uploadIntent.js";
import { memoryAlbumNotFound } from "./errors.js";
import { findMemoryAlbum, listMemoryAlbums } from "./repository.js";
import { recheckMemoryUpload, toMemoryAlbumDetail, toMemoryAlbumSummary } from "./service.js";

const member = { auth: "user", requireVerifiedEmail: true } as const;

/** Member Memory Box routes. */
const memoryRoutes: FastifyPluginAsyncZod = async (app) => {
  /** `GET /api/memories`: published boxes, by `sort_order`, then newest. */
  app.get(
    "/memories",
    { config: member, schema: { response: { 200: memoryAlbumListSchema, ...mediaErrorResponses } } },
    async (request): Promise<MemoryAlbumList> => {
      const viewer = viewerOf(authUser(request));
      // Published boxes only, admins included (the panel lists every status).
      const records = await listMemoryAlbums(app.db, viewer, "published", MEMORY_ALBUMS_MAX);
      return { items: await Promise.all(records.map((record) => toMemoryAlbumSummary(app.storage, record))) };
    }
  );

  /** `GET /api/memories/:id`: one box (members: published; admins: any). */
  app.get(
    "/memories/:id",
    { config: member, schema: { params: idParamSchema, response: { 200: memoryAlbumDetailSchema, ...mediaErrorResponses } } },
    async (request): Promise<MemoryAlbumDetail> => {
      const viewer = viewerOf(authUser(request));
      const record = await findMemoryAlbum(app.db, request.params.id, viewer);
      if (record === null) throw memoryAlbumNotFound();
      return toMemoryAlbumDetail(app.storage, record, viewer);
    }
  );

  /** `GET /api/memories/:id/media`: the box's gallery page, newest first (keyset). */
  app.get(
    "/memories/:id/media",
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
      const record = await findMemoryAlbum(app.db, request.params.id, viewer);
      if (record === null) throw memoryAlbumNotFound();
      const page = await listGallery(app.db, {
        memoryAlbumId: record.row.id,
        viewer,
        limit: request.query.limit,
        cursor: request.query.cursor,
        kind: request.query.kind
      });
      const items = await Promise.all(page.records.map((item) => toMediaItem(app.storage, item, viewer)));
      return { items, nextCursor: page.nextCursor };
    }
  );

  /**
   * `POST /api/memories/:id/uploads`: any verified member to a published box
   * (admins: any box). The gallery's locked daily-budget step (one budget
   * shared with edition and album uploads); the prefix `memories/{id}` comes
   * from the box row, and the box is re-checked under its row lock inside
   * that step. Confirm through `POST /api/media/:id/confirm`.
   */
  app.post(
    "/memories/:id/uploads",
    {
      config: { ...member, rateLimit: rateLimitByUser("memory-upload", UPLOAD_INTENT_RATE_LIMIT) },
      schema: {
        params: idParamSchema,
        body: createUploadInputSchema,
        response: { 201: createUploadResponseSchema, ...mediaErrorResponses }
      }
    },
    async (request, reply) => {
      const user = authUser(request);
      const viewer = viewerOf(user);
      const record = await findMemoryAlbum(app.db, request.params.id, viewer);
      if (record === null) throw memoryAlbumNotFound();
      const albumId = record.row.id;
      const response = await createPendingUpload(
        app,
        user,
        { memoryAlbumId: albumId, storagePrefix: memoryStoragePrefix(record.row) },
        request.body,
        (tx) => recheckMemoryUpload(tx, viewer, albumId)
      );
      return reply.code(201).send(response);
    }
  );
};

export default memoryRoutes;
