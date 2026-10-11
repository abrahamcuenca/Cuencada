/**
 * WP-5.3 event routes [SEC]: slugs (Security M1 and the retry cap), the
 * visibility matrix (roles × statuses × visibility), lists, writes and their
 * state rules, participants (who may be added, the cap, the last-organizer
 * guard, privacy of participant fields), albums, consent notices and audit
 * rows (ids only).
 */
import {
  type EventDetail,
  type EventNoticeList,
  type EventSummary,
  type Page,
  eventDetailSchema,
  eventNoticeListSchema,
  eventPageSchema,
  randomEventSlugSuffix
} from "@cuencada/types";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import { getTestDb } from "../../../test/helpers/db.js";
import {
  addParticipant,
  callAs,
  errorOf,
  type EventActor,
  eventActor,
  insertAlbumMedia,
  insertEvent
} from "../../../test/helpers/events.js";
import { FakeStorage } from "../../../test/helpers/fakes.js";
import type { App } from "../../app.js";
import { auditLogs, chatRooms, eventAlbums, eventParticipants, events, mediaItems } from "../../db/schema/index.js";
import { slugSuffixSource } from "./service.js";

let app: App;
let storage: FakeStorage;

beforeEach(async () => {
  storage = new FakeStorage();
  app = await createTestApp({ storage });
});

afterEach(async () => {
  slugSuffixSource.next = randomEventSlugSuffix;
  await app.close();
});

const SUFFIXED = /^[a-z0-9-]+-[a-z2-7]{4}$/;

async function detail(actor: EventActor, year: number, slug: string): Promise<EventDetail> {
  const response = await callAs(app, actor, "GET", `/api/events/${year}/${slug}`);
  expect(response.statusCode, response.body).toBe(200);
  return eventDetailSchema.parse(response.json());
}

async function list(actor: EventActor, query = ""): Promise<Page<EventSummary>> {
  const response = await callAs(app, actor, "GET", `/api/events${query}`);
  expect(response.statusCode, response.body).toBe(200);
  return eventPageSchema.parse(response.json());
}

async function audits(action: string): Promise<Array<typeof auditLogs.$inferSelect>> {
  return getTestDb().select().from(auditLogs).where(eq(auditLogs.action, action));
}

describe("POST /api/events (slugs, Security M1)", () => {
  it("always suffixes a member slug, with or without a colliding event the caller cannot see", async () => {
    const hidden = await eventActor();
    const ana = await eventActor();
    // An invisible draft that uses the same title in the same year.
    const theirs = await callAs(app, hidden, "POST", "/api/events", { title: "Carne asada", year: 2100 });
    expect(theirs.statusCode).toBe(201);
    const first = await callAs(app, ana, "POST", "/api/events", { title: "Carne asada", year: 2100 });
    const second = await callAs(app, ana, "POST", "/api/events", { title: "Posada única", year: 2100 });
    for (const response of [theirs, first, second]) {
      expect(response.statusCode, response.body).toBe(201);
      expect(eventDetailSchema.parse(response.json()).slug).toMatch(SUFFIXED);
    }
    expect(eventDetailSchema.parse(first.json()).slug.startsWith("carne-asada-")).toBe(true);
    expect(eventDetailSchema.parse(second.json()).slug.startsWith("posada-unica-")).toBe(true);
  });

  it("retries a colliding suffix and answers a generic 500 after five attempts", async () => {
    const ana = await eventActor();
    slugSuffixSource.next = () => "abcd";
    const first = await callAs(app, ana, "POST", "/api/events", { title: "Viaje", year: 2100 });
    expect(eventDetailSchema.parse(first.json()).slug).toBe("viaje-abcd");
    // Same title, same year, same forced suffix: every attempt collides.
    let calls = 0;
    slugSuffixSource.next = () => {
      calls += 1;
      return "abcd";
    };
    const second = await callAs(app, ana, "POST", "/api/events", { title: "Viaje", year: 2100 });
    expect(second.statusCode).toBe(500);
    expect(errorOf(second.body).code).toBe("INTERNAL");
    expect(second.body).not.toContain("viaje");
    expect(second.body).not.toContain("slug");
    expect(calls).toBe(5);
    // A suffix that is free on the second try succeeds.
    const suffixes = ["abcd", "wxyz"];
    slugSuffixSource.next = () => suffixes.shift() ?? "qqqq";
    const third = await callAs(app, ana, "POST", "/api/events", { title: "Viaje", year: 2100 });
    expect(eventDetailSchema.parse(third.json()).slug).toBe("viaje-wxyz");
  });

  it("lets admins type a slug (409 EVENT_SLUG_TAKEN when taken in that year) and refuses member-typed slugs", async () => {
    const admin = await eventActor({ role: "admin" });
    const ana = await eventActor();
    const typed = await callAs(app, admin, "POST", "/api/admin/events", { title: "Posada", year: 2100, slug: "posada" });
    expect(typed.statusCode).toBe(201);
    expect(eventDetailSchema.parse(typed.json()).slug).toBe("posada");
    const taken = await callAs(app, admin, "POST", "/api/admin/events", { title: "Otra", year: 2100, slug: "posada" });
    expect(taken.statusCode).toBe(409);
    expect(errorOf(taken.body).detailCode).toBe("EVENT_SLUG_TAKEN");
    const memberTyped = await callAs(app, ana, "POST", "/api/events", { title: "Posada", year: 2100, slug: "posada-2" });
    expect(memberTyped.statusCode).toBe(400);
  });

  it("creates the organizer, the Fotos album, the room only when published, and audits ids only", async () => {
    const ana = await eventActor({ displayName: "Ana Morales Vega" });
    const bea = await eventActor();
    const draft = eventDetailSchema.parse(
      (await callAs(app, ana, "POST", "/api/events", { title: "Reunión secreta", year: 2100, participantUserIds: [bea.user.id] })).json()
    );
    expect(draft.status).toBe("draft");
    expect(draft.viewerRole).toBe("organizer");
    expect(draft.albums.map((album) => album.title)).toEqual(["Fotos"]);
    expect(draft.chatRoomId).toBeNull();
    expect(draft.participants.map((p) => p.role).sort()).toEqual(["organizer", "participant"]);
    const published = eventDetailSchema.parse(
      (await callAs(app, ana, "POST", "/api/events", { title: "Comida", year: 2100, publish: true })).json()
    );
    expect(published.status).toBe("published");
    expect(published.chatRoomId).not.toBeNull();
    expect(published.firstPublishedAt).not.toBeNull();
    const created = await audits("event.created");
    expect(created).toHaveLength(2);
    const serialized = JSON.stringify(await getTestDb().select().from(auditLogs));
    expect(serialized).not.toContain("Reunión secreta");
    expect(serialized).not.toContain("Ana Morales Vega");
    expect((await audits("event.participant_added"))[0]?.metadata).toEqual({ userIds: [bea.user.id], role: "participant" });
  });

  it("derives the year from startsAt in the event's timezone and rejects a mismatched year", async () => {
    const ana = await eventActor();
    const newYear = await callAs(app, ana, "POST", "/api/events", {
      title: "Año Nuevo",
      startsAt: "2027-01-01T05:00:00.000Z",
      endsAt: "2027-01-01T09:00:00.000Z",
      timezone: "America/Merida"
    });
    expect(eventDetailSchema.parse(newYear.json()).year).toBe(2026);
    const bad = await callAs(app, ana, "POST", "/api/events", { title: "Sin fecha" });
    expect(bad.statusCode).toBe(400);
  });

  it("caps member creation at 10 per day (admins exempt)", async () => {
    const ana = await eventActor();
    for (let index = 0; index < 10; index += 1) {
      const response = await callAs(app, ana, "POST", "/api/events", { title: `Evento ${index}`, year: 2100, publish: true });
      expect(response.statusCode).toBe(201);
    }
    const over = await callAs(app, ana, "POST", "/api/events", { title: "Uno más", year: 2100 });
    expect(over.statusCode).toBe(429);
    const admin = await eventActor({ role: "admin" });
    await getTestDb().update(events).set({ createdByUserId: admin.user.id });
    for (let index = 0; index < 11; index += 1) {
      expect((await callAs(app, admin, "POST", "/api/admin/events", { title: `Admin ${index}`, year: 2100 })).statusCode).toBe(201);
    }
  });
});

describe("visibility matrix (ADR 0001 §7)", () => {
  type Role = "organizer" | "participant" | "member" | "admin";
  const statuses = ["draft", "published", "hidden"] as const;
  const visibilities = ["members", "participants"] as const;

  function expected(role: Role, status: (typeof statuses)[number], visibility: (typeof visibilities)[number]): boolean {
    if (role === "admin") return true;
    if (status === "hidden") return false;
    if (status === "draft") return role === "organizer";
    return visibility === "members" || role !== "member";
  }

  it("answers detail 200/404 and lists the event exactly when the caller may see it", async () => {
    const actors: Record<Role, EventActor> = {
      organizer: await eventActor(),
      participant: await eventActor(),
      member: await eventActor(),
      admin: await eventActor({ role: "admin" })
    };
    const failures: string[] = [];
    for (const status of statuses) {
      for (const visibility of visibilities) {
        const { event } = await insertEvent({
          title: `Evento ${status} ${visibility}`,
          year: 2100,
          status,
          visibility,
          organizerId: actors.organizer.user.id,
          participantIds: [actors.participant.user.id]
        });
        for (const role of Object.keys(actors) as Role[]) {
          const actor = actors[role];
          const response = await callAs(app, actor, "GET", `/api/events/${event.year}/${event.slug}`);
          const visible = expected(role, status, visibility);
          if (response.statusCode !== (visible ? 200 : 404)) failures.push(`${role} ${status} ${visibility}: detail ${response.statusCode}`);
          if (!visible) {
            const error = errorOf(response.body);
            if (error.detailCode !== "EVENT_NOT_FOUND") failures.push(`${role} ${status} ${visibility}: ${error.detailCode}`);
            // Every by-id route answers the same 404 before any other rule.
            for (const [method, url] of [
              ["PATCH", `/api/events/${event.id}`],
              ["POST", `/api/events/${event.id}/join`],
              ["DELETE", `/api/events/${event.id}/participants/me`],
              ["GET", `/api/events/${event.id}/albums/${randomUuid()}/media`]
            ] as const) {
              const byId = await callAs(app, actor, method, url, method === "PATCH" ? { summary: "x" } : undefined);
              if (byId.statusCode !== 404 || errorOf(byId.body).detailCode !== "EVENT_NOT_FOUND") {
                failures.push(`${role} ${status} ${visibility}: ${method} ${url} → ${byId.statusCode}`);
              }
            }
          }
          const listed = (await list(actor, "?year=2100&limit=50")).items.some((item) => item.id === event.id);
          // Lists never include hidden events, admins included.
          if (listed !== (visible && status !== "hidden")) failures.push(`${role} ${status} ${visibility}: listed ${listed}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("never shows a participants-only event's title to a non-participant (lists, notices, chat rooms)", async () => {
    const ana = await eventActor();
    const outsider = await eventActor();
    await insertEvent({ title: "Viaje secreto a Ciudad Ficticia", year: 2100, visibility: "participants", organizerId: ana.user.id });
    for (const url of ["/api/events?year=2100", "/api/events?when=past", "/api/events/notices", "/api/chat/rooms"]) {
      const response = await callAs(app, outsider, "GET", url);
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain("Viaje secreto");
    }
  });
});

function randomUuid(): string {
  return "00000000-0000-4000-8000-000000000000".replace(/0/g, () => Math.floor(Math.random() * 10).toString());
}

describe("GET /api/events", () => {
  it("splits upcoming and past, filters mine and pages with a keyset cursor", async () => {
    const ana = await eventActor();
    const other = await eventActor();
    const ids: string[] = [];
    for (let day = 1; day <= 5; day += 1) {
      const startsAt = new Date(Date.UTC(2100, 0, day, 18));
      const { event } = await insertEvent({
        title: `Futuro ${day}`,
        year: 2100,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 3_600_000),
        organizerId: day % 2 === 0 ? ana.user.id : other.user.id
      });
      ids.push(event.id);
    }
    const undated = await insertEvent({ title: "Sin fecha", year: 2100, organizerId: other.user.id });
    const past = await insertEvent({ title: "Pasado", year: 2001, organizerId: other.user.id });

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await list(ana, `?when=upcoming&limit=2${cursor === null ? "" : `&cursor=${cursor}`}`);
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor !== null);
    // Dated ascending, the undated event last within the year.
    expect(seen).toEqual([...ids, undated.event.id]);
    expect((await list(ana, "?when=past")).items.map((item) => item.id)).toEqual([past.event.id]);
    const mine = await list(ana, "?mine=true");
    expect(mine.items.map((item) => item.id).sort()).toEqual([ids[1], ids[3]].sort());
    expect(mine.items.every((item) => item.viewerRole === "organizer" && item.canManage)).toBe(true);
    const bad = await callAs(app, ana, "GET", "/api/events?cursor=bm9wZQ");
    expect(bad.statusCode).toBe(400);
  });
});

describe("PATCH /api/events/:id", () => {
  it("publishes once (room created, first_published_at kept), lets only admins hide, and checks the merged dates", async () => {
    const ana = await eventActor();
    const admin = await eventActor({ role: "admin" });
    const { event } = await insertEvent({ status: "draft", year: 2100, organizerId: ana.user.id });
    const published = await callAs(app, ana, "PATCH", `/api/events/${event.id}`, { status: "published" });
    expect(published.statusCode, published.body).toBe(200);
    const first = eventDetailSchema.parse(published.json());
    expect(first.chatRoomId).not.toBeNull();
    const back = eventDetailSchema.parse((await callAs(app, ana, "PATCH", `/api/events/${event.id}`, { status: "draft" })).json());
    expect(back.firstPublishedAt).toBe(first.firstPublishedAt);
    await callAs(app, ana, "PATCH", `/api/events/${event.id}`, { status: "published" });
    expect(await getTestDb().select().from(chatRooms).where(eq(chatRooms.eventId, event.id))).toHaveLength(1);

    const hide = await callAs(app, ana, "PATCH", `/api/events/${event.id}`, { status: "hidden" });
    expect(hide.statusCode).toBe(403);
    expect((await callAs(app, admin, "PATCH", `/api/events/${event.id}`, { status: "hidden" })).statusCode).toBe(200);
    expect((await audits("event.hidden"))[0]?.metadata).toEqual({ hidden: true });
    // Hidden: the organizer no longer sees it at all.
    expect((await callAs(app, ana, "PATCH", `/api/events/${event.id}`, { summary: "Hola" })).statusCode).toBe(404);
    expect((await callAs(app, admin, "PATCH", `/api/events/${event.id}`, { status: "published" })).statusCode).toBe(200);

    const lone = await callAs(app, ana, "PATCH", `/api/events/${event.id}`, { startsAt: "2100-02-01T18:00:00.000Z" });
    expect(lone.statusCode).toBe(400);
    const dated = await callAs(app, ana, "PATCH", `/api/events/${event.id}`, {
      startsAt: "2101-02-01T18:00:00.000Z",
      endsAt: "2101-02-01T20:00:00.000Z"
    });
    expect(eventDetailSchema.parse(dated.json()).year).toBe(2101);
    const updated = await audits("event.updated");
    expect(JSON.stringify(updated.map((row) => row.metadata))).not.toContain("Hola");
  });

  it("refuses a member that can see but not manage with EVENT_MANAGE_NOT_ALLOWED", async () => {
    const ana = await eventActor();
    const bea = await eventActor();
    const { event } = await insertEvent({ organizerId: ana.user.id, participantIds: [bea.user.id] });
    const response = await callAs(app, bea, "PATCH", `/api/events/${event.id}`, { title: "Mío" });
    expect(response.statusCode).toBe(403);
    expect(errorOf(response.body).detailCode).toBe("EVENT_MANAGE_NOT_ALLOWED");
  });

  it("lets an admin change the slug (409 when taken in that year)", async () => {
    const admin = await eventActor({ role: "admin" });
    const a = await insertEvent({ year: 2100, slug: "uno" });
    await insertEvent({ year: 2100, slug: "dos" });
    expect((await callAs(app, admin, "PATCH", `/api/admin/events/${a.event.id}`, { slug: "tres" })).statusCode).toBe(200);
    const taken = await callAs(app, admin, "PATCH", `/api/admin/events/${a.event.id}`, { slug: "dos" });
    expect(taken.statusCode).toBe(409);
    expect(errorOf(taken.body).detailCode).toBe("EVENT_SLUG_TAKEN");
  });
});

describe("DELETE /api/events/:id", () => {
  it("lets an organizer delete only a media-free draft (EVENT_DELETE_NOT_ALLOWED otherwise)", async () => {
    const ana = await eventActor();
    const draft = await insertEvent({ status: "draft", organizerId: ana.user.id });
    await insertAlbumMedia(draft.album, { deletedAt: new Date() });
    const refused = await callAs(app, ana, "DELETE", `/api/events/${draft.event.id}`);
    expect(refused.statusCode).toBe(403);
    expect(errorOf(refused.body).detailCode).toBe("EVENT_DELETE_NOT_ALLOWED");
    const empty = await insertEvent({ status: "draft", organizerId: ana.user.id });
    expect((await callAs(app, ana, "DELETE", `/api/events/${empty.event.id}`)).statusCode).toBe(204);
  });

  it("lets an admin delete an event with media: rows purged in the transaction, objects removed after it", async () => {
    const admin = await eventActor({ role: "admin" });
    const ana = await eventActor();
    const target = await insertEvent({ organizerId: ana.user.id });
    const live = await insertAlbumMedia(target.album, { uploadedByUserId: ana.user.id });
    const gone = await insertAlbumMedia(target.album, { uploadedByUserId: ana.user.id, deletedAt: new Date() });
    for (const row of [live, gone]) {
      for (const key of [row.objectKey, row.thumbKey, row.displayKey]) {
        if (key !== null) await storage.simulateUpload(key, Buffer.from("x"), "image/webp");
      }
    }
    expect((await callAs(app, admin, "DELETE", `/api/events/${target.event.id}`)).statusCode).toBe(204);
    expect(await getTestDb().select().from(events).where(eq(events.id, target.event.id))).toEqual([]);
    expect(await getTestDb().select().from(mediaItems).where(eq(mediaItems.albumId, target.album.id))).toEqual([]);
    expect(await getTestDb().select().from(chatRooms).where(eq(chatRooms.eventId, target.event.id))).toEqual([]);
    expect([...storage.objects.keys()].filter((key) => key.startsWith(`events/${target.event.id}/`))).toEqual([]);
    expect((await audits("event.deleted"))[0]?.metadata).toMatchObject({ mediaDeleted: 2, byAdmin: true });
  });
});

describe("participants", () => {
  it("adds only listed, active, verified members for organizers (generic 400) and any active member for admins", async () => {
    const ana = await eventActor();
    const admin = await eventActor({ role: "admin" });
    const listed = await eventActor();
    const unlisted = await eventActor({ profile: { listedInDirectory: false } });
    const unverified = await eventActor({ emailVerified: false });
    const { event } = await insertEvent({ organizerId: ana.user.id });
    const url = `/api/events/${event.id}/participants`;
    for (const id of [unlisted.user.id, unverified.user.id, randomUuid()]) {
      const refused = await callAs(app, ana, "POST", url, { userIds: [listed.user.id, id] });
      expect(refused.statusCode).toBe(400);
      expect(refused.body).not.toContain(id);
    }
    expect(await getTestDb().select().from(eventParticipants).where(eq(eventParticipants.eventId, event.id))).toHaveLength(1);
    expect((await callAs(app, ana, "POST", url, { userIds: [listed.user.id] })).statusCode).toBe(200);
    // Idempotent for existing participants.
    expect((await callAs(app, ana, "POST", url, { userIds: [listed.user.id] })).statusCode).toBe(200);
    expect((await callAs(app, admin, "POST", url, { userIds: [unlisted.user.id] })).statusCode).toBe(200);
    expect((await callAs(app, admin, "POST", url, { userIds: [unverified.user.id] })).statusCode).toBe(400);
    expect((await audits("event.participant_added")).map((row) => row.metadata)).toEqual([
      { userIds: [listed.user.id], role: "participant" },
      { userIds: [unlisted.user.id], role: "participant" }
    ]);
  });

  it("caps an event at 200 participants", async () => {
    const ana = await eventActor();
    const { event } = await insertEvent({ organizerId: ana.user.id });
    const db = getTestDb();
    const filler = await Promise.all(Array.from({ length: 199 }, () => eventActor()));
    await db.insert(eventParticipants).values(filler.map((actor) => ({ eventId: event.id, userId: actor.user.id })));
    const extra = await eventActor();
    const response = await callAs(app, ana, "POST", `/api/events/${event.id}/participants`, { userIds: [extra.user.id] });
    expect(response.statusCode).toBe(409);
  }, 60_000);

  it("guards the last organizer on leave, demote and remove, and allows it once another organizer exists", async () => {
    const ana = await eventActor();
    const bea = await eventActor();
    const { event } = await insertEvent({ organizerId: ana.user.id, participantIds: [bea.user.id] });
    const leave = await callAs(app, ana, "DELETE", `/api/events/${event.id}/participants/me`);
    expect(errorOf(leave.body).detailCode).toBe("EVENT_LAST_ORGANIZER");
    const demote = await callAs(app, ana, "PATCH", `/api/events/${event.id}/participants/${ana.user.id}`, { role: "participant" });
    expect(errorOf(demote.body).detailCode).toBe("EVENT_LAST_ORGANIZER");
    const remove = await callAs(app, ana, "DELETE", `/api/events/${event.id}/participants/${ana.user.id}`);
    expect(errorOf(remove.body).detailCode).toBe("EVENT_LAST_ORGANIZER");
    const promoted = await callAs(app, ana, "PATCH", `/api/events/${event.id}/participants/${bea.user.id}`, { role: "organizer" });
    expect(promoted.statusCode).toBe(200);
    expect((await callAs(app, ana, "DELETE", `/api/events/${event.id}/participants/me`)).statusCode).toBe(204);
    expect((await audits("event.left"))[0]?.metadata).toEqual({ userId: ana.user.id, role: "organizer" });
  });

  it("lets members join published members events only, idempotently, and leave", async () => {
    const ana = await eventActor();
    const bea = await eventActor();
    const open = await insertEvent({ organizerId: ana.user.id });
    const closed = await insertEvent({ organizerId: ana.user.id, visibility: "participants", participantIds: [bea.user.id] });
    const joined = eventDetailSchema.parse((await callAs(app, bea, "POST", `/api/events/${open.event.id}/join`)).json());
    expect(joined.viewerRole).toBe("participant");
    expect(joined.hasChat).toBe(true);
    expect(joined.chatRoomId).toBe(open.roomId);
    expect((await callAs(app, bea, "POST", `/api/events/${open.event.id}/join`)).statusCode).toBe(200);
    expect(await audits("event.joined")).toHaveLength(1);
    const refused = await callAs(app, bea, "POST", `/api/events/${closed.event.id}/join`);
    expect(errorOf(refused.body).detailCode).toBe("EVENT_JOIN_NOT_ALLOWED");
    expect((await callAs(app, bea, "DELETE", `/api/events/${open.event.id}/participants/me`)).statusCode).toBe(204);
    const outsider = await callAs(app, bea, "DELETE", `/api/events/${open.event.id}/participants/me`);
    expect(errorOf(outsider.body).detailCode).toBe("EVENT_NOT_PARTICIPANT");
  });

  it("shows participant ids and avatars only per the privacy rules (Security requirement 4)", async () => {
    const ana = await eventActor();
    const listed = await eventActor({ profile: { avatarKey: null } });
    const unlisted = await eventActor({ displayName: "Prima Oculta", profile: { listedInDirectory: false } });
    const viewer = await eventActor();
    const { event } = await insertEvent({ organizerId: ana.user.id, participantIds: [listed.user.id, unlisted.user.id, viewer.user.id] });
    const asViewer = await detail(viewer, event.year, event.slug);
    const hiddenRow = asViewer.participants.find((p) => p.displayName === "Prima Oculta");
    expect(hiddenRow).toBeDefined();
    expect(hiddenRow).not.toHaveProperty("userId");
    expect(hiddenRow?.avatarUrl).toBeNull();
    expect(JSON.stringify(asViewer)).not.toContain(unlisted.user.id);
    expect(JSON.stringify(asViewer)).not.toContain(unlisted.user.email);
    expect(asViewer.participants.find((p) => p.isSelf)?.userId).toBe(viewer.user.id);
    expect(asViewer.participants.some((p) => p.userId === listed.user.id)).toBe(true);
    // Organizers get every id (they need it to remove or promote).
    const asOrganizer = await detail(ana, event.year, event.slug);
    expect(asOrganizer.participants.some((p) => p.userId === unlisted.user.id)).toBe(true);
    expect(asOrganizer.participants[0]?.role).toBe("organizer");
  });
});

describe("consent notices (Security requirement 3)", () => {
  it("tells an added member who added them, offers Salir, hides dismissed notices and invisible events", async () => {
    const ana = await eventActor({ displayName: "Ana Morales Vega" });
    const bea = await eventActor();
    const trip = await insertEvent({ title: "Viaje a CDMX", organizerId: ana.user.id, visibility: "participants" });
    const draft = await insertEvent({ title: "Borrador", status: "draft", organizerId: ana.user.id });
    const self = await insertEvent({ title: "Propio", organizerId: bea.user.id });
    const added = await callAs(app, ana, "POST", `/api/events/${trip.event.id}/participants`, { userIds: [bea.user.id] });
    expect(added.statusCode).toBe(200);
    await addParticipant(draft.event.id, bea.user.id, "participant", ana.user.id);
    void self;

    const notices = async (): Promise<EventNoticeList> =>
      eventNoticeListSchema.parse((await callAs(app, bea, "GET", "/api/events/notices")).json());
    const first = await notices();
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({
      event: { id: trip.event.id, title: "Viaje a CDMX" },
      addedByName: "Ana Morales Vega",
      role: "participant",
      canLeave: true
    });
    expect((await callAs(app, bea, "DELETE", `/api/events/${trip.event.id}/notice`)).statusCode).toBe(204);
    expect((await callAs(app, bea, "DELETE", `/api/events/${trip.event.id}/notice`)).statusCode).toBe(204);
    expect((await notices()).items).toEqual([]);

    // Re-added after leaving: a fresh notice; "Salir" removes it again.
    await callAs(app, bea, "DELETE", `/api/events/${trip.event.id}/participants/me`);
    await callAs(app, ana, "POST", `/api/events/${trip.event.id}/participants`, { userIds: [bea.user.id] });
    expect((await notices()).items).toHaveLength(1);
    expect((await callAs(app, bea, "DELETE", `/api/events/${trip.event.id}/participants/me`)).statusCode).toBe(204);
    expect((await notices()).items).toEqual([]);
  });
});

describe("albums", () => {
  it("creates up to 20, renames, and deletes only empty albums (soft-deleted media purged with their objects)", async () => {
    const ana = await eventActor();
    const { event, album } = await insertEvent({ organizerId: ana.user.id });
    const created = await callAs(app, ana, "POST", `/api/events/${event.id}/albums`, { title: "Día 2" });
    expect(created.statusCode).toBe(201);
    for (let index = 0; index < 18; index += 1) {
      expect((await callAs(app, ana, "POST", `/api/events/${event.id}/albums`, { title: `Álbum ${index}` })).statusCode).toBe(201);
    }
    expect((await callAs(app, ana, "POST", `/api/events/${event.id}/albums`, { title: "Sobra" })).statusCode).toBe(409);
    const renamed = await callAs(app, ana, "PATCH", `/api/events/${event.id}/albums/${album.id}`, { title: "Llegada" });
    expect(renamed.json()).toMatchObject({ title: "Llegada" });

    const live = await insertAlbumMedia(album, { uploadedByUserId: ana.user.id });
    const busy = await callAs(app, ana, "DELETE", `/api/events/${event.id}/albums/${album.id}`);
    expect(errorOf(busy.body).detailCode).toBe("EVENT_ALBUM_NOT_EMPTY");
    await getTestDb().update(mediaItems).set({ deletedAt: new Date() }).where(eq(mediaItems.id, live.id));
    await storage.simulateUpload(live.objectKey, Buffer.from("x"), "image/jpeg");
    expect((await callAs(app, ana, "DELETE", `/api/events/${event.id}/albums/${album.id}`)).statusCode).toBe(204);
    expect(await getTestDb().select().from(mediaItems).where(eq(mediaItems.id, live.id))).toEqual([]);
    expect(storage.objects.has(live.objectKey)).toBe(false);
    expect(await getTestDb().select().from(eventAlbums).where(and(eq(eventAlbums.eventId, event.id), eq(eventAlbums.id, album.id)))).toEqual([]);
  });
});
