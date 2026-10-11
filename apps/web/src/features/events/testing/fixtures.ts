/**
 * Events test fixtures (WP-5.4): fictional events, participants and albums,
 * and an in-memory events "server" for MSW that follows the WP-5.2 route
 * list. Every name is invented (public repo). Imported by tests only.
 */
import type { EventAlbum, EventDetail, EventParticipant, EventSummary, MediaItem } from "@cuencada/types";
import { HttpResponse, http, type HttpHandler } from "msw";
import { apiUrl, errorBody } from "../../../../test/auth";
import type { EventNotice } from "@cuencada/types";

/** A v4-shaped UUID for fixture `n` (namespace 7 = events). */
export function eventId(n: number): string {
  return `77777777-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** The signed-in user of `makeUser()` in `test/auth.ts`. */
export const ME_ID = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";

/** Fictional people. */
export const FOLKS = {
  rosa: { userId: eventId(901), displayName: "Rosa Quintero Lara" },
  tomas: { userId: eventId(902), displayName: "Tomás Herrera Vidal" },
  lucia: { userId: eventId(903), displayName: "Lucía Ramírez Solís" }
} as const;

/** A participant row. */
export function makeParticipant(overrides: Partial<EventParticipant> = {}): EventParticipant {
  return {
    userId: FOLKS.rosa.userId,
    displayName: FOLKS.rosa.displayName,
    avatarUrl: null,
    role: "participant",
    joinedAt: "2026-08-01T15:00:00.000Z",
    isSelf: false,
    ...overrides
  };
}

/** An album. */
export function makeAlbum(n: number, overrides: Partial<EventAlbum> = {}): EventAlbum {
  return {
    id: eventId(500 + n),
    eventId: eventId(1),
    title: n === 1 ? "Fotos" : `Álbum ${n}`,
    sortOrder: n - 1,
    mediaCount: 0,
    coverThumbUrl: null,
    createdAt: "2026-08-01T15:00:00.000Z",
    ...overrides
  };
}

/** A list card: a published, members-only... no: an all-members event, upcoming, dated. */
export function makeSummary(n: number, overrides: Partial<EventSummary> = {}): EventSummary {
  return {
    id: eventId(n),
    year: 2026,
    slug: `paseo-${n}-k7q${n % 10}`,
    title: `Paseo a la laguna ${n}`,
    summary: "Llevamos comida y traje de baño.",
    startsAt: "2026-11-14T20:00:00.000Z",
    endsAt: "2026-11-15T00:00:00.000Z",
    timezone: "America/Merida",
    locationText: "Laguna Ejemplo, Pueblo Ejemplo",
    coverUrl: null,
    visibility: "members",
    status: "published",
    participantCount: 3,
    viewerRole: null,
    canManage: false,
    canJoin: true,
    hasChat: false,
    ...overrides
  };
}

/** A full event as `GET /events/:year/:slug` answers it. */
export function makeDetail(overrides: Partial<EventDetail> = {}): EventDetail {
  return {
    ...makeSummary(1),
    details: "Salimos a las 9:00 de la casa de la abuela.\nCada familia lleva un platillo.",
    firstPublishedAt: "2026-08-01T15:00:00.000Z",
    createdAt: "2026-08-01T15:00:00.000Z",
    updatedAt: "2026-08-01T15:00:00.000Z",
    participants: [
      makeParticipant({ role: "organizer" }),
      makeParticipant({ userId: FOLKS.tomas.userId, displayName: FOLKS.tomas.displayName }),
      makeParticipant({ userId: FOLKS.lucia.userId, displayName: FOLKS.lucia.displayName })
    ],
    albums: [],
    chatRoomId: null,
    canDelete: false,
    canLeave: false,
    ...overrides
  };
}

/** The same event as its organizer (the signed-in user) sees it. */
export function asOrganizer(event: EventDetail, overrides: Partial<EventDetail> = {}): EventDetail {
  return {
    ...event,
    viewerRole: "organizer",
    canManage: true,
    canJoin: false,
    hasChat: true,
    chatRoomId: eventId(800),
    albums: event.albums.length > 0 ? event.albums : [makeAlbum(1)],
    participants: [makeParticipant({ userId: ME_ID, displayName: "Prima Morales", role: "organizer", isSelf: true }), ...event.participants],
    participantCount: event.participantCount + 1,
    canLeave: false,
    ...overrides
  };
}

/** An album media item (WP-5.2 shape: no year, `album`/`event` set). */
export function makeAlbumMedia(n: number, event: EventDetail, album: EventAlbum): MediaItem {
  return {
    canEdit: false,
    canDelete: false,
    id: eventId(600 + n),
    cuencadaId: null,
    year: null,
    kind: "image",
    mimeType: "image/jpeg",
    thumbUrl: `https://bucket.example/events/thumb-${n}.webp?X-Amz-Signature=t${n}`,
    displayUrl: `https://bucket.example/events/display-${n}.webp?X-Amz-Signature=d${n}`,
    width: 1600,
    height: 1200,
    durationSeconds: null,
    caption: `Foto del paseo ${n}`,
    uploaderName: "Rosa",
    isMine: false,
    uploadStatus: "ready",
    moderationStatus: "approved",
    createdAt: new Date(Date.UTC(2026, 10, 14, 18, 0, 0) - n * 60_000).toISOString(),
    album: { id: album.id, title: album.title, eventId: event.id },
    event: { id: event.id, year: event.year, slug: event.slug, title: event.title }
  };
}

/** Mutable state behind {@link eventsHandlers}. */
export interface EventsDb {
  /** Cards per `when` (already filtered by the "server"). */
  upcoming: EventSummary[];
  past: EventSummary[];
  /** Events by `year/slug` the caller may see. Anything else is the same 404 [SEC]. */
  details: Map<string, EventDetail>;
  /** Album media by album id. */
  media: Map<string, MediaItem[]>;
  /** Every request as `METHOD path?query`. */
  log: string[];
  /** Bodies by `METHOD path`. */
  bodies: Record<string, unknown>;
  /** Forced error for the next write: status + detail code. */
  failNext: { status: number; code: string; message: string } | null;
  /** Page size the fake list uses (to test "Cargar más"). */
  pageSize: number;
  /** Consent notices (WP-5.3 contract). */
  notices: EventNotice[];
}

/** A fresh fake events server. */
export function makeEventsDb(overrides: Partial<EventsDb> = {}): EventsDb {
  return {
    upcoming: [],
    past: [],
    details: new Map(),
    media: new Map(),
    log: [],
    bodies: {},
    failNext: null,
    pageSize: 12,
    notices: [],
    ...overrides
  };
}

/** Registers an event for `GET /events/:year/:slug`. */
export function putDetail(db: EventsDb, event: EventDetail): void {
  db.details.set(`${event.year}/${event.slug}`, event);
}

function findById(db: EventsDb, id: string): EventDetail | undefined {
  return [...db.details.values()].find((event) => event.id === id);
}

/** The 404 every invisible or missing event gets (WP-5.2: `NOT_FOUND` + `EVENT_NOT_FOUND`). */
export function notFoundResponse(): Response {
  return HttpResponse.json(
    { error: { code: "NOT_FOUND", message: "No encontramos ese evento.", details: [{ path: "event", message: "No encontramos ese evento.", code: "EVENT_NOT_FOUND" }] } },
    { status: 404 }
  );
}

function failure(db: EventsDb): Response | null {
  const fail = db.failNext;
  if (fail === null) return null;
  db.failNext = null;
  const top = fail.status === 409 ? "CONFLICT" : fail.status === 403 ? "FORBIDDEN" : "VALIDATION";
  return HttpResponse.json({ error: { code: top, message: fail.message, details: [{ path: "event", message: fail.message, code: fail.code }] } }, { status: fail.status });
}

function record(db: EventsDb, request: Request): string {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, "");
  db.log.push(`${request.method} ${path}${url.search}`);
  return `${request.method} ${path}`;
}

async function readBody(db: EventsDb, key: string, request: Request): Promise<unknown> {
  const text = await request.text();
  const body: unknown = text === "" ? null : JSON.parse(text);
  db.bodies[key] = body;
  return body;
}

/** Replaces the stored copy of an event and returns it as the response. */
function save(db: EventsDb, event: EventDetail): Response {
  for (const [key, value] of db.details) if (value.id === event.id) db.details.delete(key);
  putDetail(db, event);
  return HttpResponse.json(event);
}

/**
 * MSW handlers over an {@link EventsDb}.
 *
 * @param db - The fake server state.
 */
export function eventsHandlers(db: EventsDb): HttpHandler[] {
  return [
    http.get(apiUrl("/events/notices"), ({ request }) => {
      record(db, request);
      return HttpResponse.json({ items: db.notices });
    }),
    http.delete(apiUrl("/events/:id/notice"), ({ params, request }) => {
      record(db, request);
      db.notices = db.notices.filter((notice) => notice.event.id !== params.id);
      return new HttpResponse(null, { status: 204 });
    }),
    http.get(apiUrl("/events"), ({ request }) => {
      record(db, request);
      const url = new URL(request.url);
      const source = url.searchParams.get("when") === "past" ? db.past : db.upcoming;
      const limit = Number(url.searchParams.get("limit") ?? db.pageSize);
      const size = Math.min(limit, db.pageSize);
      const start = Number(url.searchParams.get("cursor") ?? 0);
      const items = source.slice(start, start + size);
      const next = start + size < source.length ? String(start + size) : null;
      return HttpResponse.json({ items, nextCursor: next });
    }),
    http.get(apiUrl("/events/:year/:slug"), ({ params, request }) => {
      record(db, request);
      const event = db.details.get(`${String(params.year)}/${String(params.slug)}`);
      return event === undefined ? notFoundResponse() : HttpResponse.json(event);
    }),
    http.post(apiUrl("/events"), async ({ request }) => {
      const key = record(db, request);
      const body = (await readBody(db, key, request)) as { title: string; visibility?: "members" | "participants"; publish?: boolean }; // Test-only: the client sends `createEventInputSchema`.
      const forced = failure(db);
      if (forced !== null) return forced;
      const created = asOrganizer(
        makeDetail({ id: eventId(99), slug: "carne-asada-k7q2", title: body.title, visibility: body.visibility ?? "members", status: body.publish === true ? "published" : "draft", participants: [], participantCount: 0 })
      );
      putDetail(db, created);
      return HttpResponse.json(created, { status: 201 });
    }),
    http.post(apiUrl("/admin/events"), async ({ request }) => {
      const key = record(db, request);
      const body = (await readBody(db, key, request)) as { title: string; slug?: string }; // Test-only: `adminCreateEventInputSchema`.
      const forced = failure(db);
      if (forced !== null) return forced;
      const created = asOrganizer(makeDetail({ id: eventId(98), slug: body.slug ?? "evento-admin-ab2c", title: body.title, participants: [], participantCount: 0 }));
      putDetail(db, created);
      return HttpResponse.json(created, { status: 201 });
    }),
    http.patch(apiUrl("/events/:id"), async ({ params, request }) => {
      const key = record(db, request);
      const body = (await readBody(db, key, request)) as Partial<EventDetail>; // Test-only: `updateEventInputSchema` fields.
      const forced = failure(db);
      if (forced !== null) return forced;
      const event = findById(db, String(params.id));
      if (event === undefined) return notFoundResponse();
      return save(db, { ...event, ...body, updatedAt: new Date().toISOString() });
    }),
    http.patch(apiUrl("/admin/events/:id"), async ({ params, request }) => {
      const key = record(db, request);
      const body = (await readBody(db, key, request)) as Partial<EventDetail>; // Test-only: `adminUpdateEventInputSchema` fields.
      const forced = failure(db);
      if (forced !== null) return forced;
      const event = findById(db, String(params.id));
      if (event === undefined) return notFoundResponse();
      return save(db, { ...event, ...body, updatedAt: new Date().toISOString() });
    }),
    http.delete(apiUrl("/events/:id"), ({ params, request }) => {
      record(db, request);
      const forced = failure(db);
      if (forced !== null) return forced;
      const event = findById(db, String(params.id));
      if (event === undefined) return notFoundResponse();
      db.details.delete(`${event.year}/${event.slug}`);
      return new HttpResponse(null, { status: 204 });
    }),
    http.post(apiUrl("/events/:id/join"), ({ params, request }) => {
      record(db, request);
      const forced = failure(db);
      if (forced !== null) return forced;
      const event = findById(db, String(params.id));
      if (event === undefined) return notFoundResponse();
      return save(db, {
        ...event,
        viewerRole: "participant",
        canJoin: false,
        canLeave: true,
        hasChat: true,
        chatRoomId: event.chatRoomId ?? eventId(800),
        albums: event.albums.length > 0 ? event.albums : [makeAlbum(1)],
        participantCount: event.participantCount + 1,
        participants: [...event.participants, makeParticipant({ userId: ME_ID, displayName: "Prima Morales", isSelf: true })]
      });
    }),
    http.delete(apiUrl("/events/:id/participants/me"), ({ params, request }) => {
      record(db, request);
      const forced = failure(db);
      if (forced !== null) return forced;
      // Leaving removes the participant row, and with it the notice (WP-5.3).
      db.notices = db.notices.filter((notice) => notice.event.id !== params.id);
      const event = findById(db, String(params.id));
      if (event === undefined) return new HttpResponse(null, { status: 204 });
      save(db, {
        ...event,
        viewerRole: null,
        canJoin: event.visibility === "members",
        canLeave: false,
        hasChat: false,
        chatRoomId: null,
        participantCount: event.participantCount - 1,
        participants: event.participants.filter((p) => !p.isSelf)
      });
      return new HttpResponse(null, { status: 204 });
    }),
    http.post(apiUrl("/events/:id/participants"), async ({ params, request }) => {
      const key = record(db, request);
      const body = (await readBody(db, key, request)) as { userIds: string[] }; // Test-only: `addEventParticipantsInputSchema`.
      const forced = failure(db);
      if (forced !== null) return forced;
      const event = findById(db, String(params.id));
      if (event === undefined) return notFoundResponse();
      const added = body.userIds.map((userId) => makeParticipant({ userId, displayName: `Persona ${userId.slice(-3)}` }));
      return save(db, { ...event, participants: [...event.participants, ...added], participantCount: event.participantCount + added.length });
    }),
    http.patch(apiUrl("/events/:id/participants/:userId"), async ({ params, request }) => {
      const key = record(db, request);
      const body = (await readBody(db, key, request)) as { role: "organizer" | "participant" }; // Test-only.
      const forced = failure(db);
      if (forced !== null) return forced;
      const event = findById(db, String(params.id));
      if (event === undefined) return notFoundResponse();
      return save(db, { ...event, participants: event.participants.map((p) => (p.userId === params.userId ? { ...p, role: body.role } : p)) });
    }),
    http.delete(apiUrl("/events/:id/participants/:userId"), ({ params, request }) => {
      record(db, request);
      const forced = failure(db);
      if (forced !== null) return forced;
      const event = findById(db, String(params.id));
      if (event === undefined) return notFoundResponse();
      const after = { ...event, participants: event.participants.filter((p) => p.userId !== params.userId), participantCount: event.participantCount - 1 };
      if (params.userId === ME_ID && event.visibility === "participants") {
        // WP-5.3: removing yourself from a participants-only event: the write succeeds, the follow-up detail is invisible.
        for (const [key, value] of db.details) if (value.id === event.id) db.details.delete(key);
        return notFoundResponse();
      }
      return save(db, after);
    }),
    http.post(apiUrl("/events/:id/albums/:albumId/uploads"), async ({ params, request }) => {
      const key = record(db, request);
      await readBody(db, key, request);
      // WP-5.3: the album intent answers 201, like the edition one.
      return HttpResponse.json(
        {
          mediaId: eventId(700),
          uploadUrl: `https://bucket.example/events/${String(params.id)}/${String(params.albumId)}/originals/x.jpg?X-Amz-Signature=s`,
          method: "PUT",
          headers: { "Content-Type": "image/jpeg" },
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString()
        },
        { status: 201 }
      );
    }),
    http.post(apiUrl("/events/:id/albums"), async ({ params, request }) => {
      const key = record(db, request);
      const body = (await readBody(db, key, request)) as { title: string }; // Test-only.
      const forced = failure(db);
      if (forced !== null) return forced;
      const event = findById(db, String(params.id));
      if (event === undefined) return notFoundResponse();
      const album = makeAlbum(event.albums.length + 1, { eventId: event.id, title: body.title });
      save(db, { ...event, albums: [...event.albums, album] });
      return HttpResponse.json(album, { status: 201 });
    }),
    http.patch(apiUrl("/events/:id/albums/:albumId"), async ({ params, request }) => {
      const key = record(db, request);
      const body = (await readBody(db, key, request)) as { title: string }; // Test-only.
      const forced = failure(db);
      if (forced !== null) return forced;
      const event = findById(db, String(params.id));
      const album = event?.albums.find((entry) => entry.id === params.albumId);
      if (event === undefined || album === undefined) return notFoundResponse();
      const renamed = { ...album, title: body.title };
      save(db, { ...event, albums: event.albums.map((entry) => (entry.id === album.id ? renamed : entry)) });
      return HttpResponse.json(renamed);
    }),
    http.delete(apiUrl("/events/:id/albums/:albumId"), ({ params, request }) => {
      record(db, request);
      const forced = failure(db);
      if (forced !== null) return forced;
      const event = findById(db, String(params.id));
      if (event === undefined) return notFoundResponse();
      save(db, { ...event, albums: event.albums.filter((entry) => entry.id !== params.albumId) });
      return new HttpResponse(null, { status: 204 });
    }),
    http.get(apiUrl("/events/:id/albums/:albumId/media"), ({ params, request }) => {
      record(db, request);
      const items = db.media.get(String(params.albumId));
      if (items === undefined) return HttpResponse.json(errorBody("FORBIDDEN", "Apúntate."), { status: 403 });
      return HttpResponse.json({ items, nextCursor: null });
    }),
    http.get(apiUrl("/admin/events"), ({ request }) => {
      record(db, request);
      const url = new URL(request.url);
      const status = url.searchParams.get("status");
      const all = [...db.details.values()].map((event) => ({
        ...event,
        createdByUserId: FOLKS.rosa.userId,
        createdByName: FOLKS.rosa.displayName,
        mediaCount: 0
      }));
      return HttpResponse.json({ items: status === null ? all : all.filter((event) => event.status === status), nextCursor: null });
    })
  ];
}
