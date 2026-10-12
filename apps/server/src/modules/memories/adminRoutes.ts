/**
 * Admin Memory Box routes (WP-6.3) under `/api/admin/memory-albums`,
 * `auth: "admin"`: every box in every status; create, edit (title,
 * description, cover, status, sort order), reorder and delete. Writes share
 * one per-user limit (120/h, ADR 0001 §8 requirement 8). The box's media
 * moderation queue is `GET /api/admin/media?memoryAlbumId=` (media module).
 */
import {
  type AdminMemoryAlbum,
  type AdminMemoryAlbumList,
  adminMemoryAlbumListSchema,
  adminMemoryAlbumSchema,
  createMemoryAlbumInputSchema,
  idParamSchema,
  MEMORY_ALBUMS_MAX,
  reorderMemoryAlbumsInputSchema,
  updateMemoryAlbumInputSchema
} from "@cuencada/types";
import type { FastifyInstance } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { authUser } from "../../plugins/auth.js";
import { mediaErrorResponses, noContentSchema, rateLimitByUser, viewerOf } from "../media/shared.js";
import type { Viewer } from "../media/service.js";
import { memoryAlbumNotFound } from "./errors.js";
import { findMemoryAlbum, listMemoryAlbums } from "./repository.js";
import { createMemoryAlbum, deleteMemoryAlbum, reorderMemoryAlbums, toAdminMemoryAlbum, updateMemoryAlbum } from "./service.js";

/** Admin box writes per user. */
export const MEMORY_ADMIN_WRITE_LIMIT = { max: 120, timeWindow: "1 hour" } as const;

async function adminList(app: FastifyInstance, viewer: Viewer): Promise<AdminMemoryAlbumList> {
  const records = await listMemoryAlbums(app.db, viewer, "all", MEMORY_ALBUMS_MAX);
  return { items: await Promise.all(records.map((record) => toAdminMemoryAlbum(app.storage, record))) };
}

async function adminOne(app: FastifyInstance, viewer: Viewer, id: string): Promise<AdminMemoryAlbum> {
  const record = await findMemoryAlbum(app.db, id, viewer);
  if (record === null) throw memoryAlbumNotFound();
  return toAdminMemoryAlbum(app.storage, record);
}

/** Admin Memory Box routes. */
const adminMemoryRoutes: FastifyPluginAsyncZod = async (app) => {
  const writes = { auth: "admin", rateLimit: rateLimitByUser("admin-memory-write", MEMORY_ADMIN_WRITE_LIMIT) } as const;

  /** `GET /api/admin/memory-albums`: every box (any status), by `sort_order`, then newest. */
  app.get(
    "/admin/memory-albums",
    { config: { auth: "admin" }, schema: { response: { 200: adminMemoryAlbumListSchema, ...mediaErrorResponses } } },
    async (request) => adminList(app, viewerOf(authUser(request)))
  );

  /** `POST /api/admin/memory-albums`: create (draft by default). */
  app.post(
    "/admin/memory-albums",
    {
      config: writes,
      schema: { body: createMemoryAlbumInputSchema, response: { 201: adminMemoryAlbumSchema, ...mediaErrorResponses } }
    },
    async (request, reply) => {
      const user = authUser(request);
      const id = await createMemoryAlbum(app, user, request.body, request.ip);
      return reply.code(201).send(await adminOne(app, viewerOf(user), id));
    }
  );

  /** `PUT /api/admin/memory-albums/order`: every box id in the new order. Registered before `/:id`. */
  app.put(
    "/admin/memory-albums/order",
    {
      config: writes,
      schema: { body: reorderMemoryAlbumsInputSchema, response: { 200: adminMemoryAlbumListSchema, ...mediaErrorResponses } }
    },
    async (request) => {
      const user = authUser(request);
      await reorderMemoryAlbums(app, user, request.body.ids, request.ip);
      return adminList(app, viewerOf(user));
    }
  );

  /** `PATCH /api/admin/memory-albums/:id`: edit, cover (a photo of this box, else 400), publish / hide / draft. */
  app.patch(
    "/admin/memory-albums/:id",
    {
      config: writes,
      schema: {
        params: idParamSchema,
        body: updateMemoryAlbumInputSchema,
        response: { 200: adminMemoryAlbumSchema, ...mediaErrorResponses }
      }
    },
    async (request) => {
      const user = authUser(request);
      await updateMemoryAlbum(app, user, request.params.id, request.body, request.ip);
      return adminOne(app, viewerOf(user), request.params.id);
    }
  );

  /** `DELETE /api/admin/memory-albums/:id`: 204; 409 `MEMORY_ALBUM_NOT_EMPTY` with live media. */
  app.delete(
    "/admin/memory-albums/:id",
    { config: writes, schema: { params: idParamSchema, response: { 204: noContentSchema, ...mediaErrorResponses } } },
    async (request, reply) => {
      await deleteMemoryAlbum(app, authUser(request), request.params.id, request.ip);
      return reply.code(204).send();
    }
  );
};

export default adminMemoryRoutes;
