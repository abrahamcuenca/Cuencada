/**
 * Admin event routes (WP-5.3) under `/api/admin/events`, `auth: "admin"`.
 * Admins see every event (hidden and drafts included) and may type a slug
 * (409 `EVENT_SLUG_TAKEN` when taken in that year; admins see every event,
 * so this reveals nothing). The moderation queue for album media is
 * `GET /api/admin/media?eventId=` (media module).
 */
import {
  adminCreateEventInputSchema,
  adminEventListQuerySchema,
  adminEventPageSchema,
  adminUpdateEventInputSchema,
  eventDetailSchema,
  eventIdParamsSchema
} from "@cuencada/types";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { authUser } from "../../plugins/auth.js";
import { decodeCursor, encodeCursor } from "../media/cursor.js";
import { rateLimitByUser } from "../media/shared.js";
import { EVENT_WRITE_LIMIT } from "./constants.js";
import { toAdminEventSummary } from "./mappers.js";
import { listAdminEvents } from "./repository.js";
import { eventErrorResponses } from "./routes.js";
import { createEvent, eventDetailById, eventViewerOf, updateEvent } from "./service.js";

/** Admin event routes. */
const adminEventRoutes: FastifyPluginAsyncZod = async (app) => {
  const adminWrites = rateLimitByUser("admin-event-write", EVENT_WRITE_LIMIT);

  /** `GET /api/admin/events`: every event, newest first (filters: status, visibility, year). */
  app.get(
    "/admin/events",
    {
      config: { auth: "admin" },
      schema: { querystring: adminEventListQuerySchema, response: { 200: adminEventPageSchema, ...eventErrorResponses } }
    },
    async (request) => {
      const viewer = eventViewerOf(authUser(request));
      const { query } = request;
      const rows = await listAdminEvents(app.db, {
        viewer,
        status: query.status,
        visibility: query.visibility,
        year: query.year,
        cursor: query.cursor === undefined ? null : decodeCursor(query.cursor),
        limit: query.limit
      });
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      const nextCursor =
        rows.length > query.limit && last !== undefined ? encodeCursor({ micros: last.createdMicros, id: last.row.id }) : null;
      const items = await Promise.all(page.map((row) => toAdminEventSummary(app, row, viewer)));
      return { items, nextCursor };
    }
  );

  /** `POST /api/admin/events`: create (optional typed slug); the admin becomes its organizer. */
  app.post(
    "/admin/events",
    {
      config: { auth: "admin", rateLimit: adminWrites },
      schema: { body: adminCreateEventInputSchema, response: { 201: eventDetailSchema, ...eventErrorResponses } }
    },
    async (request, reply) => {
      const user = authUser(request);
      const eventId = await createEvent(app, user, request.body, request.ip);
      return reply.code(201).send(await eventDetailById(app, eventViewerOf(user), eventId));
    }
  );

  /** `PATCH /api/admin/events/:id`: every field, `hidden`, and the slug. */
  app.patch(
    "/admin/events/:id",
    {
      config: { auth: "admin", rateLimit: adminWrites },
      schema: { params: eventIdParamsSchema, body: adminUpdateEventInputSchema, response: { 200: eventDetailSchema, ...eventErrorResponses } }
    },
    async (request) => {
      const user = authUser(request);
      await updateEvent(app, user, request.params.id, request.body, request.ip);
      return eventDetailById(app, eventViewerOf(user), request.params.id);
    }
  );
};

export default adminEventRoutes;
