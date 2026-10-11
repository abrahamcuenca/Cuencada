/**
 * Authorization-matrix entries for the events routes (WP-5.3) [SEC]. Spread
 * into `ROUTE_MATRIX` (`routeMatrix.ts`); same contract: a minimal valid
 * request for `ctx.actor` plus probes run as a verified member.
 *
 * Probes on every `/api/events/:id…` route: an event the caller cannot see
 * (another member's `participants` event, another member's draft, a hidden
 * event) answers 404 and changes nothing (ADR 0001 §7, requirement 1);
 * manage routes answer 403 to a member who can see but not manage; plus
 * the route's own rules (last organizer, join, unlisted members, …).
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { eventAlbums, eventCoverUploads, eventParticipants, events } from "../../db/schema/index.js";
import { addParticipant, insertAlbumMedia, insertEvent, type InsertEventOptions, type TestEvent } from "../../../test/helpers/events.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { createUser } from "../../../test/helpers/factories.js";
import { makePng } from "../../../test/helpers/media.js";
import type { Actor, BuiltRequest, Expectation, MatrixContext, Probe, ProbeRequest, RouteSpec } from "./routeMatrix.js";

const NOT_FOUND: Expectation = { status: 404, code: "NOT_FOUND" };
const FORBIDDEN: Expectation = { status: 403, code: "FORBIDDEN" };
const CONFLICT: Expectation = { status: 409, code: "CONFLICT" };
const VALIDATION: Expectation = { status: 400, code: "VALIDATION" };

const json = (url: string, payload?: unknown): BuiltRequest => (payload === undefined ? { url } : { url, payload });

let pngCache: Buffer | null = null;
async function png(): Promise<Buffer> {
  pngCache ??= await makePng(32, 18);
  return pngCache;
}

/** An event organized by `owner`. */
function eventOf(owner: Actor, options: InsertEventOptions = {}): Promise<TestEvent> {
  return insertEvent({ organizerId: owner.user.id, ...options });
}

/** Everything a probe must not change: the event row, its participants, albums and album media. */
function eventState(eventId: string): () => Promise<unknown> {
  return async () => ({
    event: await getTestDb().select().from(events).where(eq(events.id, eventId)),
    participants: await getTestDb()
      .select({ userId: eventParticipants.userId, role: eventParticipants.role })
      .from(eventParticipants)
      .where(eq(eventParticipants.eventId, eventId))
      .orderBy(eventParticipants.userId),
    albums: await getTestDb().select().from(eventAlbums).where(eq(eventAlbums.eventId, eventId)).orderBy(eventAlbums.id),
    covers: await getTestDb().select().from(eventCoverUploads).where(eq(eventCoverUploads.eventId, eventId))
  });
}

type EventRequest = (ctx: MatrixContext, target: TestEvent) => Promise<BuiltRequest> | BuiltRequest;

/** The three "cannot see it" cases: 404 and no change. */
function invisibleProbes(request: EventRequest): Probe[] {
  const cases: Array<[string, InsertEventOptions]> = [
    ["another member's participants-only event", { visibility: "participants" }],
    ["another member's draft", { status: "draft" }],
    ["a hidden event", { status: "hidden" }]
  ];
  return cases.map(([label, options]) => ({
    label,
    kind: "idor",
    build: async (ctx): Promise<ProbeRequest> => {
      const target = await eventOf(ctx.other, options);
      return { ...(await request(ctx, target)), state: eventState(target.event.id) };
    },
    expect: NOT_FOUND
  }));
}

/** A member who sees the event (published, `members`, joined) but does not organize it: 403. */
function notManagerProbe(request: EventRequest): Probe {
  return {
    label: "a joined members event the caller does not organize",
    kind: "rule",
    build: async (ctx) => {
      const target = await eventOf(ctx.other, { participantIds: [ctx.actor.user.id] });
      return { ...(await request(ctx, target)), state: eventState(target.event.id) };
    },
    expect: FORBIDDEN
  };
}

/** A visible `members` event the caller has not joined: 403 (`EVENT_NOT_PARTICIPANT`). */
function notParticipantProbe(request: EventRequest): Probe {
  return {
    label: "a members event the caller has not joined",
    kind: "rule",
    build: async (ctx) => {
      const target = await eventOf(ctx.other);
      return { ...(await request(ctx, target)), state: eventState(target.event.id) };
    },
    expect: FORBIDDEN
  };
}

/** An uploaded cover intent by `uploader` for `eventId`. */
async function coverIntent(ctx: MatrixContext, uploader: Actor, eventId: string): Promise<string> {
  const body = await png();
  const id = randomUUID();
  const key = `events/${eventId}/cover/${id}.png`;
  await getTestDb().insert(eventCoverUploads).values({
    id,
    eventId,
    uploadedByUserId: uploader.user.id,
    objectKey: key,
    mimeType: "image/png",
    byteSize: body.byteLength,
    expiresAt: new Date(Date.now() + 300_000)
  });
  await ctx.storage.simulateUpload(key, body, "image/png");
  return id;
}

const base = (id: string): string => `/api/events/${id}`;
const member = { auth: "user", requireVerifiedEmail: true } as const;

/** Matrix entries of the events module (member, cover and admin routes). */
export const EVENT_ROUTE_SPECS: readonly RouteSpec[] = [
  {
    method: "GET",
    url: "/api/events/notices",
    ...member,
    owner: "the caller's own participations only, in events they can see",
    build: async () => json("/api/events/notices")
  },
  {
    method: "GET",
    url: "/api/events",
    ...member,
    note: "only events the caller may see (ADR 0001 §7); hidden never",
    build: async () => json("/api/events")
  },
  {
    method: "POST",
    url: "/api/events",
    ...member,
    note: "the caller becomes organizer; 10/day and 20 open drafts per member",
    build: async () => json("/api/events", { title: "Carne asada", year: 2026 }),
    probes: [
      {
        label: "a member-typed slug (Security M1)",
        kind: "mass-assignment",
        build: async () => json("/api/events", { title: "Carne asada", year: 2026, slug: "carne-asada" }),
        expect: VALIDATION
      }
    ]
  },
  {
    method: "GET",
    url: "/api/events/:year/:slug",
    ...member,
    owner: "per visibility (404 when the caller cannot see it)",
    build: async (ctx) => {
      const { event } = await eventOf(ctx.other);
      return json(`/api/events/${event.year}/${event.slug}`);
    },
    probes: invisibleProbes((_ctx, { event }) => json(`/api/events/${event.year}/${event.slug}`))
  },
  {
    method: "PATCH",
    url: "/api/events/:id",
    ...member,
    owner: "organizers and admins; hidden admin-only",
    build: async (ctx) => json(base((await eventOf(ctx.actor)).event.id), { summary: "Traigan sombrero" }),
    probes: [
      ...invisibleProbes((_ctx, { event }) => json(base(event.id), { summary: "Mía" })),
      notManagerProbe((_ctx, { event }) => json(base(event.id), { summary: "Mía" })),
      {
        label: "an organizer hiding their own event",
        kind: "rule",
        build: async (ctx) => {
          const { event } = await eventOf(ctx.actor);
          return { ...json(base(event.id), { status: "hidden" }), state: eventState(event.id) };
        },
        expect: FORBIDDEN
      },
      {
        label: "a member-typed slug (Security M1)",
        kind: "mass-assignment",
        build: async (ctx) => {
          const { event } = await eventOf(ctx.actor);
          return { ...json(base(event.id), { slug: "otra-direccion" }), state: eventState(event.id) };
        },
        expect: VALIDATION
      }
    ]
  },
  {
    method: "DELETE",
    url: "/api/events/:id",
    ...member,
    owner: "admins; organizers only for a draft without media",
    build: async (ctx) => json(base((await eventOf(ctx.actor, { status: "draft" })).event.id)),
    probes: [
      ...invisibleProbes((_ctx, { event }) => json(base(event.id))),
      notManagerProbe((_ctx, { event }) => json(base(event.id))),
      {
        label: "an organizer deleting a published event",
        kind: "rule",
        build: async (ctx) => {
          const { event } = await eventOf(ctx.actor);
          return { ...json(base(event.id)), state: eventState(event.id) };
        },
        expect: FORBIDDEN
      },
      {
        label: "an organizer deleting a draft with (soft-deleted) media",
        kind: "rule",
        build: async (ctx) => {
          const { event, album } = await eventOf(ctx.actor, { status: "draft" });
          await insertAlbumMedia(album, { uploadedByUserId: ctx.actor.user.id, deletedAt: new Date() });
          return { ...json(base(event.id)), state: eventState(event.id) };
        },
        expect: FORBIDDEN
      }
    ]
  },
  {
    method: "POST",
    url: "/api/events/:id/join",
    ...member,
    owner: "published members events only (403 otherwise, admins included)",
    build: async (ctx) => json(`${base((await eventOf(ctx.other)).event.id)}/join`),
    probes: [
      ...invisibleProbes((_ctx, { event }) => json(`${base(event.id)}/join`)),
      {
        label: "joining a participants-only event the caller already sees",
        kind: "rule",
        build: async (ctx) => {
          const { event } = await eventOf(ctx.actor, { visibility: "participants" });
          return { ...json(`${base(event.id)}/join`), state: eventState(event.id) };
        },
        expect: FORBIDDEN
      }
    ]
  },
  {
    method: "DELETE",
    url: "/api/events/:id/participants/me",
    ...member,
    owner: "the caller's own participation (not the last organizer)",
    build: async (ctx) => json(`${base((await eventOf(ctx.other, { participantIds: [ctx.actor.user.id] })).event.id)}/participants/me`),
    probes: [
      ...invisibleProbes((_ctx, { event }) => json(`${base(event.id)}/participants/me`)),
      notParticipantProbe((_ctx, { event }) => json(`${base(event.id)}/participants/me`)),
      {
        label: "the last organizer leaving",
        kind: "rule",
        build: async (ctx) => {
          const { event } = await eventOf(ctx.actor);
          return { ...json(`${base(event.id)}/participants/me`), state: eventState(event.id) };
        },
        expect: CONFLICT
      }
    ]
  },
  {
    method: "POST",
    url: "/api/events/:id/participants",
    ...member,
    owner: "organizers (listed, active, verified members) and admins",
    build: async (ctx) => json(`${base((await eventOf(ctx.actor)).event.id)}/participants`, { userIds: [ctx.other.user.id] }),
    probes: [
      ...invisibleProbes((ctx, { event }) => json(`${base(event.id)}/participants`, { userIds: [ctx.actor.user.id] })),
      notManagerProbe((ctx, { event }) => json(`${base(event.id)}/participants`, { userIds: [ctx.other.user.id] })),
      {
        label: "an organizer adding a member hidden from the directory",
        kind: "rule",
        build: async (ctx) => {
          const { event } = await eventOf(ctx.actor);
          const hidden = await createUser({ emailVerified: true, profile: { listedInDirectory: false } });
          return { ...json(`${base(event.id)}/participants`, { userIds: [hidden.id] }), state: eventState(event.id) };
        },
        expect: VALIDATION
      },
      {
        label: "an organizer adding a disabled member",
        kind: "rule",
        build: async (ctx) => {
          const { event } = await eventOf(ctx.actor);
          const disabled = await createUser({ emailVerified: true, status: "disabled" });
          return { ...json(`${base(event.id)}/participants`, { userIds: [disabled.id] }), state: eventState(event.id) };
        },
        expect: VALIDATION
      }
    ]
  },
  {
    method: "PATCH",
    url: "/api/events/:id/participants/:userId",
    ...member,
    owner: "organizers and admins; never demotes the last organizer",
    build: async (ctx) => {
      const { event } = await eventOf(ctx.actor, { participantIds: [ctx.other.user.id] });
      return json(`${base(event.id)}/participants/${ctx.other.user.id}`, { role: "organizer" });
    },
    probes: [
      ...invisibleProbes((ctx, { event }) => json(`${base(event.id)}/participants/${ctx.other.user.id}`, { role: "participant" })),
      notManagerProbe((ctx, { event }) => json(`${base(event.id)}/participants/${ctx.actor.user.id}`, { role: "organizer" })),
      {
        label: "demoting the last organizer",
        kind: "rule",
        build: async (ctx) => {
          const { event } = await eventOf(ctx.actor);
          return { ...json(`${base(event.id)}/participants/${ctx.actor.user.id}`, { role: "participant" }), state: eventState(event.id) };
        },
        expect: CONFLICT
      }
    ]
  },
  {
    method: "DELETE",
    url: "/api/events/:id/participants/:userId",
    ...member,
    owner: "organizers and admins; never removes the last organizer",
    build: async (ctx) => {
      const { event } = await eventOf(ctx.actor, { participantIds: [ctx.other.user.id] });
      return json(`${base(event.id)}/participants/${ctx.other.user.id}`);
    },
    probes: [
      ...invisibleProbes((ctx, { event }) => json(`${base(event.id)}/participants/${ctx.other.user.id}`)),
      notManagerProbe((ctx, { event }) => json(`${base(event.id)}/participants/${ctx.other.user.id}`)),
      {
        label: "removing the last organizer",
        kind: "rule",
        build: async (ctx) => {
          const { event } = await eventOf(ctx.actor);
          return { ...json(`${base(event.id)}/participants/${ctx.actor.user.id}`), state: eventState(event.id) };
        },
        expect: CONFLICT
      }
    ]
  },
  {
    method: "POST",
    url: "/api/events/:id/albums",
    ...member,
    owner: "organizers and admins (≤ 20 albums)",
    build: async (ctx) => json(`${base((await eventOf(ctx.actor)).event.id)}/albums`, { title: "Día 2" }),
    probes: [
      ...invisibleProbes((_ctx, { event }) => json(`${base(event.id)}/albums`, { title: "Mío" })),
      notManagerProbe((_ctx, { event }) => json(`${base(event.id)}/albums`, { title: "Mío" }))
    ]
  },
  {
    method: "PATCH",
    url: "/api/events/:id/albums/:albumId",
    ...member,
    owner: "organizers and admins; the album must belong to the event",
    build: async (ctx) => {
      const { event, album } = await eventOf(ctx.actor);
      return json(`${base(event.id)}/albums/${album.id}`, { title: "Fotos del viaje" });
    },
    probes: [
      ...invisibleProbes((_ctx, { event, album }) => json(`${base(event.id)}/albums/${album.id}`, { title: "Mío" })),
      notManagerProbe((_ctx, { event, album }) => json(`${base(event.id)}/albums/${album.id}`, { title: "Mío" })),
      {
        label: "another event's album under the caller's event",
        kind: "idor",
        build: async (ctx) => {
          const own = await eventOf(ctx.actor);
          const theirs = await eventOf(ctx.other, { visibility: "participants" });
          return { ...json(`${base(own.event.id)}/albums/${theirs.album.id}`, { title: "Mío" }), state: eventState(theirs.event.id) };
        },
        expect: NOT_FOUND
      }
    ]
  },
  {
    method: "DELETE",
    url: "/api/events/:id/albums/:albumId",
    ...member,
    owner: "organizers and admins; 409 while live media remain",
    build: async (ctx) => {
      const { event, album } = await eventOf(ctx.actor);
      return json(`${base(event.id)}/albums/${album.id}`);
    },
    probes: [
      ...invisibleProbes((_ctx, { event, album }) => json(`${base(event.id)}/albums/${album.id}`)),
      notManagerProbe((_ctx, { event, album }) => json(`${base(event.id)}/albums/${album.id}`)),
      {
        label: "an album with live media",
        kind: "rule",
        build: async (ctx) => {
          const { event, album } = await eventOf(ctx.actor);
          await insertAlbumMedia(album, { uploadedByUserId: ctx.actor.user.id });
          return { ...json(`${base(event.id)}/albums/${album.id}`), state: eventState(event.id) };
        },
        expect: CONFLICT
      }
    ]
  },
  {
    method: "GET",
    url: "/api/events/:id/albums/:albumId/media",
    ...member,
    owner: "participants and admins (admins on participants events audited)",
    build: async (ctx) => {
      const { event, album } = await eventOf(ctx.other, { participantIds: [ctx.actor.user.id] });
      return json(`${base(event.id)}/albums/${album.id}/media`);
    },
    probes: [
      ...invisibleProbes((_ctx, { event, album }) => json(`${base(event.id)}/albums/${album.id}/media`)),
      notParticipantProbe((_ctx, { event, album }) => json(`${base(event.id)}/albums/${album.id}/media`)),
      {
        label: "another event's album under the caller's event",
        kind: "idor",
        build: async (ctx) => {
          const own = await eventOf(ctx.actor);
          const theirs = await eventOf(ctx.other, { visibility: "participants" });
          return json(`${base(own.event.id)}/albums/${theirs.album.id}/media`);
        },
        expect: NOT_FOUND
      }
    ]
  },
  {
    method: "POST",
    url: "/api/events/:id/albums/:albumId/uploads",
    ...member,
    owner: "participants and admins; shared daily upload budget",
    build: async (ctx) => {
      const { event, album } = await eventOf(ctx.other, { participantIds: [ctx.actor.user.id] });
      return json(`${base(event.id)}/albums/${album.id}/uploads`, { fileName: "foto.png", mimeType: "image/png", byteSize: 1000 });
    },
    probes: [
      ...invisibleProbes((_ctx, { event, album }) =>
        json(`${base(event.id)}/albums/${album.id}/uploads`, { fileName: "foto.png", mimeType: "image/png", byteSize: 1000 })
      ),
      {
        ...notParticipantProbe((_ctx, { event, album }) =>
          json(`${base(event.id)}/albums/${album.id}/uploads`, { fileName: "foto.png", mimeType: "image/png", byteSize: 1000 })
        ),
        label: "a members event the caller has not joined (no media row created)"
      }
    ]
  },
  {
    method: "POST",
    url: "/api/events/:id/cover/uploads",
    ...member,
    owner: "organizers and admins",
    build: async (ctx) => json(`${base((await eventOf(ctx.actor)).event.id)}/cover/uploads`, { mimeType: "image/png", byteSize: 1000 }),
    probes: [
      ...invisibleProbes((_ctx, { event }) => json(`${base(event.id)}/cover/uploads`, { mimeType: "image/png", byteSize: 1000 })),
      notManagerProbe((_ctx, { event }) => json(`${base(event.id)}/cover/uploads`, { mimeType: "image/png", byteSize: 1000 }))
    ]
  },
  {
    method: "POST",
    url: "/api/events/:id/cover/uploads/:uploadId/confirm",
    ...member,
    owner: "the uploader, still an organizer or admin (404 for another user's upload)",
    build: async (ctx) => {
      const { event } = await eventOf(ctx.actor);
      return json(`${base(event.id)}/cover/uploads/${await coverIntent(ctx, ctx.actor, event.id)}/confirm`, {});
    },
    probes: [
      ...invisibleProbes(async (ctx, { event }) =>
        json(`${base(event.id)}/cover/uploads/${await coverIntent(ctx, ctx.other, event.id)}/confirm`, {})
      ),
      {
        label: "another organizer's upload intent",
        kind: "idor",
        build: async (ctx) => {
          const { event } = await eventOf(ctx.actor);
          await addParticipant(event.id, ctx.other.user.id, "organizer");
          const uploadId = await coverIntent(ctx, ctx.other, event.id);
          return { ...json(`${base(event.id)}/cover/uploads/${uploadId}/confirm`, {}), state: eventState(event.id) };
        },
        expect: NOT_FOUND
      },
      {
        label: "an own intent after being demoted to participant",
        kind: "rule",
        build: async (ctx) => {
          const { event } = await eventOf(ctx.other, { participantIds: [ctx.actor.user.id] });
          const uploadId = await coverIntent(ctx, ctx.actor, event.id);
          return { ...json(`${base(event.id)}/cover/uploads/${uploadId}/confirm`, {}), state: eventState(event.id) };
        },
        expect: FORBIDDEN
      }
    ]
  },
  {
    method: "DELETE",
    url: "/api/events/:id/cover",
    ...member,
    owner: "organizers and admins",
    build: async (ctx) => json(`${base((await eventOf(ctx.actor)).event.id)}/cover`),
    probes: [
      ...invisibleProbes((_ctx, { event }) => json(`${base(event.id)}/cover`)),
      notManagerProbe((_ctx, { event }) => json(`${base(event.id)}/cover`))
    ]
  },
  {
    method: "DELETE",
    url: "/api/events/:id/notice",
    ...member,
    owner: "the caller's own notice only",
    build: async (ctx) => {
      const { event } = await eventOf(ctx.other);
      await addParticipant(event.id, ctx.actor.user.id, "participant", ctx.other.user.id);
      return json(`${base(event.id)}/notice`);
    },
    probes: invisibleProbes((_ctx, { event }) => json(`${base(event.id)}/notice`))
  },
  // ------------------------------------------------------------------ admin
  {
    method: "GET",
    url: "/api/admin/events",
    auth: "admin",
    note: "every event, hidden and drafts included",
    build: async () => json("/api/admin/events")
  },
  {
    method: "POST",
    url: "/api/admin/events",
    auth: "admin",
    note: "optional typed slug (409 EVENT_SLUG_TAKEN)",
    build: async () => json("/api/admin/events", { title: "Posada familiar", year: 2026, slug: `posada-${randomUUID().slice(0, 8)}` })
  },
  {
    method: "PATCH",
    url: "/api/admin/events/:id",
    auth: "admin",
    note: "every field, hidden and the slug",
    build: async (ctx) => json(`/api/admin/events/${(await eventOf(ctx.other)).event.id}`, { status: "hidden" })
  }
];
