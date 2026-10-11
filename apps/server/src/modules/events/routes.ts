/**
 * Member event routes (WP-5.3) under `/api`, per `docs/coordination/WP-5.2.md`
 * and ADR 0001 §7 [SEC]. Every route is `auth: "user"` with
 * `requireVerifiedEmail: true`.
 *
 * - An event the caller cannot see answers 404 `EVENT_NOT_FOUND` before any
 *   other check (one SQL predicate, `eventVisibleSql`). Schema validation of
 *   the body runs first but never depends on the event.
 * - Chat/albums/uploads need a participant or an admin (403
 *   `EVENT_NOT_PARTICIPANT`); managing needs an organizer or an admin (403
 *   `EVENT_MANAGE_NOT_ALLOWED`).
 * - Rate limits: creation is capped per user in the database (10/day, 20 open
 *   drafts); participant writes share one per-user counter (100/h).
 */
import {
  addEventParticipantsInputSchema,
  apiErrorSchema,
  createEventAlbumInputSchema,
  createEventInputSchema,
  createUploadInputSchema,
  createUploadResponseSchema,
  emptyEventBodySchema,
  eventAlbumParamsSchema,
  eventAlbumSchema,
  eventDetailSchema,
  eventIdParamsSchema,
  eventListQuerySchema,
  eventNoticeListSchema,
  eventPageSchema,
  eventParticipantParamsSchema,
  eventPathParamsSchema,
  mediaItemSchema,
  mediaListQuerySchema,
  pageSchema,
  updateEventAlbumInputSchema,
  updateEventInputSchema,
  updateEventParticipantInputSchema
} from "@cuencada/types";
import { and, eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { events } from "../../db/schema/index.js";
import { extraRateLimitHook } from "../../lib/rateLimit.js";
import { authUser } from "../../plugins/auth.js";
import { albumStoragePrefix } from "../media/files.js";
import { listGallery, toMediaItem } from "../media/service.js";
import { rateLimitByUser } from "../media/shared.js";
import { createPendingUpload } from "../media/uploadIntent.js";
import { AdminViewSurface, auditAdminEventView } from "./adminView.js";
import { EVENT_PARTICIPANT_WRITE_LIMIT, EVENT_UPLOAD_INTENT_LIMIT, EVENT_WRITE_LIMIT } from "./constants.js";
import { decodeEventCursor, encodeEventCursor } from "./cursor.js";
import { albumNotFound } from "./errors.js";
import { toEventAlbum, toEventSummary } from "./mappers.js";
import { findAlbum, listEventSummaries, loadVisibleEvent } from "./repository.js";
import {
  addParticipants,
  buildEventDetail,
  changeParticipantRole,
  createAlbum,
  createEvent,
  deleteAlbum,
  deleteEvent,
  dismissNotice,
  eventDetailById,
  eventViewerOf,
  joinEvent,
  leaveEvent,
  listNotices,
  recheckAlbumUpload,
  removeParticipant,
  requireEventAccess,
  updateAlbum,
  updateEvent
} from "./service.js";

/** Error envelopes every event route may answer with. */
export const eventErrorResponses = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  409: apiErrorSchema,
  429: apiErrorSchema,
  503: apiErrorSchema
} as const;

const noContent = z.null();

/** Member event routes. */
const eventRoutes: FastifyPluginAsyncZod = async (app) => {
  const member = { auth: "user", requireVerifiedEmail: true } as const;
  /** One counter per user across every participant write. */
  const participantWrites = extraRateLimitHook(app, {
    ...EVENT_PARTICIPANT_WRITE_LIMIT,
    keyGenerator: (request: FastifyRequest) => `event-participants:${request.user?.id ?? request.ip}`
  });
  const eventWrites = rateLimitByUser("event-write", EVENT_WRITE_LIMIT);

  /** `GET /api/events/notices`: "you were added" notices of the caller (consent, requirement 3). */
  app.get(
    "/events/notices",
    { config: member, schema: { response: { 200: eventNoticeListSchema, ...eventErrorResponses } } },
    async (request) => ({ items: await listNotices(app, eventViewerOf(authUser(request))) })
  );

  /** `GET /api/events`: the events the caller may see (never hidden), keyset paged. */
  app.get(
    "/events",
    { config: member, schema: { querystring: eventListQuerySchema, response: { 200: eventPageSchema, ...eventErrorResponses } } },
    async (request) => {
      const viewer = eventViewerOf(authUser(request));
      const { query } = request;
      const rows = await listEventSummaries(app.db, {
        viewer,
        when: query.when,
        year: query.year,
        mine: query.mine,
        cursor: query.cursor === undefined ? null : decodeEventCursor(query.cursor),
        limit: query.limit,
        now: app.clock.now()
      });
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      const upcoming = query.when === "upcoming";
      const nextCursor =
        rows.length > query.limit && last !== undefined
          ? encodeEventCursor({
              year: last.row.year,
              flag: upcoming ? last.row.startsAt === null : last.row.startsAt !== null,
              micros: last.startsMicros,
              id: last.row.id
            })
          : null;
      const items = await Promise.all(page.map((row) => toEventSummary(app, row, viewer, 640)));
      return { items, nextCursor };
    }
  );

  /** `POST /api/events`: create (the caller becomes its organizer); 201 `EventDetail`. */
  app.post(
    "/events",
    {
      config: { ...member, rateLimit: rateLimitByUser("event-create", { max: 20, timeWindow: "1 hour" }) },
      schema: { body: createEventInputSchema, response: { 201: eventDetailSchema, ...eventErrorResponses } }
    },
    async (request, reply) => {
      const user = authUser(request);
      const eventId = await createEvent(app, user, request.body, request.ip);
      return reply.code(201).send(await eventDetailById(app, eventViewerOf(user), eventId));
    }
  );

  /**
   * `GET /api/events/:year/:slug`: the detail. An admin outside a
   * `participants` event is audited (`detail`) before the data is built.
   */
  app.get(
    "/events/:year/:slug",
    { config: member, schema: { params: eventPathParamsSchema, response: { 200: eventDetailSchema, ...eventErrorResponses } } },
    async (request) => {
      const viewer = eventViewerOf(authUser(request));
      const { year, slug } = request.params;
      const event = await loadVisibleEvent(app.db, viewer, and(eq(events.year, year), eq(events.slug, slug)));
      return buildEventDetail(app, viewer, event, { ip: request.ip });
    }
  );

  /** `PATCH /api/events/:id`: organizers and admins (`hidden` admin-only). */
  app.patch(
    "/events/:id",
    {
      config: { ...member, rateLimit: eventWrites },
      schema: { params: eventIdParamsSchema, body: updateEventInputSchema, response: { 200: eventDetailSchema, ...eventErrorResponses } }
    },
    async (request) => {
      const user = authUser(request);
      await updateEvent(app, user, request.params.id, request.body, request.ip);
      return eventDetailById(app, eventViewerOf(user), request.params.id);
    }
  );

  /** `DELETE /api/events/:id`: admins; organizers only for a draft without media. */
  app.delete(
    "/events/:id",
    {
      config: { ...member, rateLimit: eventWrites },
      schema: { params: eventIdParamsSchema, body: emptyEventBodySchema, response: { 204: noContent, ...eventErrorResponses } }
    },
    async (request, reply) => {
      await deleteEvent(app, authUser(request), request.params.id, request.ip);
      return reply.code(204).send(null);
    }
  );

  /** `POST /api/events/:id/join`: "Me apunto" (published `members` events; idempotent). */
  app.post(
    "/events/:id/join",
    {
      config: member,
      preHandler: participantWrites,
      schema: { params: eventIdParamsSchema, body: emptyEventBodySchema, response: { 200: eventDetailSchema, ...eventErrorResponses } }
    },
    async (request) => {
      const user = authUser(request);
      await joinEvent(app, user, request.params.id, request.ip);
      return eventDetailById(app, eventViewerOf(user), request.params.id);
    }
  );

  /** `DELETE /api/events/:id/participants/me`: leave (not the last organizer). */
  app.delete(
    "/events/:id/participants/me",
    {
      config: member,
      preHandler: participantWrites,
      schema: { params: eventIdParamsSchema, response: { 204: noContent, ...eventErrorResponses } }
    },
    async (request, reply) => {
      await leaveEvent(app, authUser(request), request.params.id, request.ip);
      return reply.code(204).send(null);
    }
  );

  /** `POST /api/events/:id/participants`: organizers and admins add members. */
  app.post(
    "/events/:id/participants",
    {
      config: member,
      preHandler: participantWrites,
      schema: {
        params: eventIdParamsSchema,
        body: addEventParticipantsInputSchema,
        response: { 200: eventDetailSchema, ...eventErrorResponses }
      }
    },
    async (request) => {
      const user = authUser(request);
      await addParticipants(app, user, request.params.id, request.body, request.ip);
      return eventDetailById(app, eventViewerOf(user), request.params.id);
    }
  );

  /** `PATCH /api/events/:id/participants/:userId`: promote or demote. */
  app.patch(
    "/events/:id/participants/:userId",
    {
      config: member,
      preHandler: participantWrites,
      schema: {
        params: eventParticipantParamsSchema,
        body: updateEventParticipantInputSchema,
        response: { 200: eventDetailSchema, ...eventErrorResponses }
      }
    },
    async (request) => {
      const user = authUser(request);
      const { id, userId } = request.params;
      await changeParticipantRole(app, user, id, userId, request.body.role, request.ip);
      return eventDetailById(app, eventViewerOf(user), id);
    }
  );

  /** `DELETE /api/events/:id/participants/:userId`: remove (the user gets `room_removed`). */
  app.delete(
    "/events/:id/participants/:userId",
    {
      config: member,
      preHandler: participantWrites,
      schema: { params: eventParticipantParamsSchema, response: { 200: eventDetailSchema, ...eventErrorResponses } }
    },
    async (request) => {
      const user = authUser(request);
      const { id, userId } = request.params;
      await removeParticipant(app, user, id, userId, request.ip);
      return eventDetailById(app, eventViewerOf(user), id);
    }
  );

  /** `POST /api/events/:id/albums`: organizers and admins (≤ 20 albums). */
  app.post(
    "/events/:id/albums",
    {
      config: { ...member, rateLimit: eventWrites },
      schema: { params: eventIdParamsSchema, body: createEventAlbumInputSchema, response: { 201: eventAlbumSchema, ...eventErrorResponses } }
    },
    async (request, reply) => {
      const user = authUser(request);
      const albumId = await createAlbum(app, user, request.params.id, request.body, request.ip);
      const album = await findAlbum(app.db, request.params.id, albumId, user.id);
      if (album === null) throw albumNotFound();
      return reply.code(201).send(await toEventAlbum(app, album));
    }
  );

  /** `PATCH /api/events/:id/albums/:albumId`: organizers and admins. */
  app.patch(
    "/events/:id/albums/:albumId",
    {
      config: { ...member, rateLimit: eventWrites },
      schema: { params: eventAlbumParamsSchema, body: updateEventAlbumInputSchema, response: { 200: eventAlbumSchema, ...eventErrorResponses } }
    },
    async (request) => {
      const user = authUser(request);
      const { id, albumId } = request.params;
      await updateAlbum(app, user, id, albumId, request.body, request.ip);
      const album = await findAlbum(app.db, id, albumId, user.id);
      if (album === null) throw albumNotFound();
      return toEventAlbum(app, album);
    }
  );

  /** `DELETE /api/events/:id/albums/:albumId`: 409 `EVENT_ALBUM_NOT_EMPTY` with live media. */
  app.delete(
    "/events/:id/albums/:albumId",
    {
      config: { ...member, rateLimit: eventWrites },
      schema: { params: eventAlbumParamsSchema, response: { 204: noContent, ...eventErrorResponses } }
    },
    async (request, reply) => {
      const { id, albumId } = request.params;
      await deleteAlbum(app, authUser(request), id, albumId, request.ip);
      return reply.code(204).send(null);
    }
  );

  /**
   * `GET /api/events/:id/albums/:albumId/media`: participants and admins
   * (an admin outside a `participants` event is audited first, `media`).
   */
  app.get(
    "/events/:id/albums/:albumId/media",
    {
      config: member,
      schema: {
        params: eventAlbumParamsSchema,
        querystring: mediaListQuerySchema,
        response: { 200: pageSchema(mediaItemSchema), ...eventErrorResponses }
      }
    },
    async (request) => {
      const viewer = eventViewerOf(authUser(request));
      const { id, albumId } = request.params;
      const event = await loadVisibleEvent(app.db, viewer, eq(events.id, id));
      requireEventAccess(event, viewer);
      const album = await findAlbum(app.db, id, albumId, viewer.id);
      if (album === null) throw albumNotFound();
      await auditAdminEventView(app.db, { viewer, eventId: id, surface: AdminViewSurface.Media, ip: request.ip, now: app.clock.now() });
      const page = await listGallery(app.db, {
        albumId,
        viewer,
        limit: request.query.limit,
        cursor: request.query.cursor,
        kind: request.query.kind
      });
      const items = await Promise.all(page.records.map((record) => toMediaItem(app.storage, record, viewer)));
      return { items, nextCursor: page.nextCursor };
    }
  );

  /**
   * `POST /api/events/:id/albums/:albumId/uploads`: participants and admins.
   * The intent goes through the gallery's locked daily-budget step (one
   * shared budget, requirement 12); participation is re-checked inside it.
   * Confirm, caption, delete and report use `/api/media/:id…`.
   */
  app.post(
    "/events/:id/albums/:albumId/uploads",
    {
      config: { ...member, rateLimit: rateLimitByUser("event-upload", EVENT_UPLOAD_INTENT_LIMIT) },
      schema: { params: eventAlbumParamsSchema, body: createUploadInputSchema, response: { 201: createUploadResponseSchema, ...eventErrorResponses } }
    },
    async (request, reply) => {
      const user = authUser(request);
      const viewer = eventViewerOf(user);
      const { id, albumId } = request.params;
      const event = await loadVisibleEvent(app.db, viewer, eq(events.id, id));
      requireEventAccess(event, viewer);
      const album = await findAlbum(app.db, id, albumId, viewer.id);
      if (album === null) throw albumNotFound();
      const response = await createPendingUpload(
        app,
        user,
        { albumId: album.id, storagePrefix: albumStoragePrefix(album) },
        request.body,
        (tx) => recheckAlbumUpload(tx, viewer, id, albumId)
      );
      return reply.code(201).send(response);
    }
  );

  /** `DELETE /api/events/:id/notice`: dismiss the caller's "you were added" notice (204). */
  app.delete(
    "/events/:id/notice",
    { config: member, schema: { params: eventIdParamsSchema, response: { 204: noContent, ...eventErrorResponses } } },
    async (request, reply) => {
      await dismissNotice(app, eventViewerOf(authUser(request)), request.params.id);
      return reply.code(204).send(null);
    }
  );
};

export default eventRoutes;
