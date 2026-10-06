import { randomUUID } from "node:crypto";
import type { AdminCuencada, AdminCuencadaDetail, ApiError, DailyMessage, ItineraryItem, LocationItem } from "@cuencada/types";
import { and, eq } from "drizzle-orm";
import type { InjectOptions } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import {
  insertCuencada,
  insertDailyMessage,
  insertItineraryItem,
  insertLocation,
  insertMedia,
  type MutableClock,
  mutableClock
} from "../../../test/helpers/cuencadas.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { type AuthInjectOptions, createUser, loginAs } from "../../../test/helpers/factories.js";
import type { App } from "../../app.js";
import { auditLogs, chatRooms, cuencadaItineraryItems, cuencadas, dailyMessages } from "../../db/schema/index.js";

let app: App;
let clock: MutableClock;
let admin: Awaited<ReturnType<typeof createUser>>;
let adminAuth: AuthInjectOptions;

beforeEach(async () => {
  clock = mutableClock("2026-09-01T18:00:00Z");
  app = await createTestApp({ clock });
  admin = await createUser({ role: "admin" });
  adminAuth = await loginAs(app, admin);
});

afterEach(async () => {
  await app.close();
});

async function audits(action: string): Promise<Array<typeof auditLogs.$inferSelect>> {
  return getTestDb().select().from(auditLogs).where(eq(auditLogs.action, action));
}

function errorOf(body: string): ApiError["error"] {
  return (JSON.parse(body) as ApiError).error; // test-only: the error envelope shape is asserted by the status code
}

const newEdition = {
  year: 2027,
  title: "Cuencada 2027",
  startsAt: "2027-09-12T00:00:00-06:00",
  endsAt: "2027-09-17T23:59:59-06:00",
  city: "Mérida",
  state: "Yucatán",
  description: "La próxima reunión.",
  whatsappUrl: "https://chat.whatsapp.com/NUEVO"
};

describe("admin route guards", () => {
  it("answers 401 without a token and 403 for members on every admin route", async () => {
    const id = randomUUID();
    const routes: Array<Pick<InjectOptions, "method" | "url" | "payload">> = [
      { method: "GET", url: "/api/admin/cuencadas" },
      { method: "POST", url: "/api/admin/cuencadas", payload: newEdition },
      { method: "GET", url: `/api/admin/cuencadas/${id}` },
      { method: "PATCH", url: `/api/admin/cuencadas/${id}`, payload: { title: "X" } },
      { method: "DELETE", url: `/api/admin/cuencadas/${id}` },
      { method: "POST", url: `/api/admin/cuencadas/${id}/itinerary`, payload: { date: "2027-09-12", title: "X" } },
      { method: "PUT", url: `/api/admin/cuencadas/${id}/itinerary/order`, payload: { ids: [id] } },
      { method: "PATCH", url: `/api/admin/itinerary/${id}`, payload: { title: "X" } },
      { method: "DELETE", url: `/api/admin/itinerary/${id}` },
      { method: "POST", url: `/api/admin/cuencadas/${id}/locations`, payload: { name: "X" } },
      { method: "PUT", url: `/api/admin/cuencadas/${id}/locations/order`, payload: { ids: [id] } },
      { method: "PATCH", url: `/api/admin/locations/${id}`, payload: { name: "X" } },
      { method: "DELETE", url: `/api/admin/locations/${id}` },
      { method: "GET", url: `/api/admin/cuencadas/${id}/daily-messages` },
      { method: "PUT", url: `/api/admin/cuencadas/${id}/daily-messages/2027-09-12`, payload: { message: "Hola" } },
      { method: "DELETE", url: `/api/admin/cuencadas/${id}/daily-messages/2027-09-12` },
      { method: "POST", url: `/api/admin/cuencadas/${id}/daily-messages/import`, payload: { text: "2027-09-12|Hola" } }
    ];
    const member = await createUser();
    const memberAuth = await loginAs(app, member);

    for (const route of routes) {
      const anonymous = await app.inject(route);
      const forbidden = await app.inject({ ...route, ...memberAuth });
      expect(anonymous.statusCode, `${route.method} ${route.url}`).toBe(401);
      expect(forbidden.statusCode, `${route.method} ${route.url}`).toBe(403);
    }
  });
});

describe("cuencada CRUD", () => {
  it("creates a draft (slug from year), audits it and rejects a duplicate year with 409", async () => {
    const created = await app.inject({ method: "POST", url: "/api/admin/cuencadas", payload: newEdition, ...adminAuth });
    const duplicate = await app.inject({ method: "POST", url: "/api/admin/cuencadas", payload: newEdition, ...adminAuth });

    expect(created.statusCode).toBe(201);
    const body = created.json<AdminCuencada>();
    expect(body).toMatchObject({
      year: 2027,
      slug: "2027",
      status: "draft",
      isPublished: false,
      timezone: "America/Merida",
      country: "México",
      whatsappUrl: "https://chat.whatsapp.com/NUEVO"
    });
    expect(duplicate.statusCode).toBe(409);
    expect(errorOf(duplicate.body).code).toBe("CONFLICT");
    const rows = await audits("cuencada.created");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorUserId: admin.id, entityType: "cuencada", entityId: body.id });
    // Credential-like links never land in audit metadata.
    expect(JSON.stringify(rows[0]?.metadata)).not.toContain("whatsapp");
  });

  it("rejects invalid input with 400 VALIDATION", async () => {
    const badDates = await app.inject({
      method: "POST",
      url: "/api/admin/cuencadas",
      payload: { ...newEdition, endsAt: "2027-09-01T00:00:00-06:00" },
      ...adminAuth
    });
    const badUrl = await app.inject({
      method: "POST",
      url: "/api/admin/cuencadas",
      payload: { ...newEdition, whatsappUrl: "javascript:alert(1)" },
      ...adminAuth
    });

    expect(badDates.statusCode).toBe(400);
    expect(errorOf(badDates.body).details?.[0]?.path).toBe("endsAt");
    expect(badUrl.statusCode).toBe(400);
  });

  it("lists drafts for admins and returns the edit screen with every item", async () => {
    const draft = await insertCuencada({ year: 2027, isPublished: false });
    await insertCuencada({ year: 2026 });
    await insertItineraryItem(draft.id, { title: "Privada", visibility: "members" });
    await insertDailyMessage(draft.id, "2027-09-12", "Hola");

    const list = await app.inject({ method: "GET", url: "/api/admin/cuencadas", ...adminAuth });
    const detail = await app.inject({ method: "GET", url: `/api/admin/cuencadas/${draft.id}`, ...adminAuth });
    const missing = await app.inject({ method: "GET", url: `/api/admin/cuencadas/${randomUUID()}`, ...adminAuth });
    const invalid = await app.inject({ method: "GET", url: "/api/admin/cuencadas/not-a-uuid", ...adminAuth });

    expect(list.json<AdminCuencada[]>().map((c) => [c.year, c.status])).toEqual([
      [2027, "draft"],
      [2026, "upcoming"]
    ]);
    const body = detail.json<AdminCuencadaDetail>();
    expect(body.cuencada.whatsappUrl).toBe("https://chat.whatsapp.com/SECRETO");
    expect(body.itinerary.map((item) => item.title)).toEqual(["Privada"]);
    expect(body.dailyMessageCount).toBe(1);
    expect(missing.statusCode).toBe(404);
    expect(invalid.statusCode).toBe(400);
  });

  it("sets first_published_at on the first publish (app clock) and keeps it across unpublish/republish", async () => {
    const draft = await insertCuencada({ year: 2027, isPublished: false });
    const url = `/api/admin/cuencadas/${draft.id}`;
    const firstPublishedAt = async (id: string): Promise<string | undefined> => {
      const [row] = await getTestDb().select().from(cuencadas).where(eq(cuencadas.id, id));
      return row?.firstPublishedAt?.toISOString();
    };

    await app.inject({ method: "PATCH", url, payload: { title: "Sigue en borrador" }, ...adminAuth });
    expect(await firstPublishedAt(draft.id)).toBeUndefined();

    await app.inject({ method: "PATCH", url, payload: { isPublished: true }, ...adminAuth });
    expect(await firstPublishedAt(draft.id)).toBe("2026-09-01T18:00:00.000Z");

    clock.set("2026-09-05T12:00:00Z");
    // Access tokens are signed with the app clock: log in again after moving it.
    adminAuth = await loginAs(app, admin);
    const unpublish = await app.inject({ method: "PATCH", url, payload: { isPublished: false }, ...adminAuth });
    expect(unpublish.json<AdminCuencada>().isPublished).toBe(false);
    expect(await firstPublishedAt(draft.id)).toBe("2026-09-01T18:00:00.000Z");
    const republish = await app.inject({ method: "PATCH", url, payload: { isPublished: true }, ...adminAuth });
    const again = await app.inject({ method: "PATCH", url, payload: { isPublished: true, title: "Otra vez" }, ...adminAuth });
    expect([republish.statusCode, again.statusCode]).toEqual([200, 200]);
    expect(await firstPublishedAt(draft.id)).toBe("2026-09-01T18:00:00.000Z");

    const createdPublished = await app.inject({
      method: "POST",
      url: "/api/admin/cuencadas",
      payload: { ...newEdition, year: 2031, isPublished: true },
      ...adminAuth
    });
    const createdDraft = await app.inject({ method: "POST", url: "/api/admin/cuencadas", payload: { ...newEdition, year: 2032 }, ...adminAuth });
    expect([createdPublished.statusCode, createdDraft.statusCode]).toEqual([201, 201]);
    expect(await firstPublishedAt(createdPublished.json<AdminCuencada>().id)).toBe("2026-09-05T12:00:00.000Z");
    expect(await firstPublishedAt(createdDraft.json<AdminCuencada>().id)).toBeUndefined();
  });

  it("publishes once: audits cuencada.published and creates the chat room idempotently", async () => {
    const draft = await insertCuencada({ year: 2027, isPublished: false });
    const url = `/api/admin/cuencadas/${draft.id}`;

    const published = await app.inject({ method: "PATCH", url, payload: { isPublished: true }, ...adminAuth });
    const unpublished = await app.inject({ method: "PATCH", url, payload: { isPublished: false }, ...adminAuth });
    const republished = await app.inject({ method: "PATCH", url, payload: { isPublished: true }, ...adminAuth });

    expect(published.statusCode).toBe(200);
    expect(published.json<AdminCuencada>()).toMatchObject({ isPublished: true, status: "upcoming" });
    expect(unpublished.json<AdminCuencada>().status).toBe("draft");
    expect(republished.statusCode).toBe(200);
    const rooms = await getTestDb().select().from(chatRooms).where(eq(chatRooms.cuencadaId, draft.id));
    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({ kind: "cuencada", title: "Cuencada 2027" });
    const publishedAudits = await audits("cuencada.published");
    expect(publishedAudits).toHaveLength(2);
    expect(publishedAudits.map((row) => row.metadata)).toEqual([
      { year: 2027, chatRoomCreated: true },
      { year: 2027, chatRoomCreated: false }
    ]);
    expect(await audits("cuencada.unpublished")).toHaveLength(1);
    expect(await audits("cuencada.updated")).toHaveLength(0);
  });

  it("creates the chat room when an edition is created already published", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/cuencadas",
      payload: { ...newEdition, isPublished: true },
      ...adminAuth
    });

    const id = created.json<AdminCuencada>().id;
    expect(await getTestDb().select().from(chatRooms).where(eq(chatRooms.cuencadaId, id))).toHaveLength(1);
    expect(await audits("cuencada.published")).toHaveLength(1);
  });

  it("re-validates the merged row on PATCH and audits field names", async () => {
    const edition = await insertCuencada({ year: 2027, isPublished: false });
    const url = `/api/admin/cuencadas/${edition.id}`;

    const before = await app.inject({ method: "PATCH", url, payload: { endsAt: "2027-09-01T00:00:00-06:00" }, ...adminAuth });
    const empty = await app.inject({ method: "PATCH", url, payload: {}, ...adminAuth });
    const ok = await app.inject({ method: "PATCH", url, payload: { title: "Cuencada 2027 en Mérida", year: 2028 }, ...adminAuth });
    const missing = await app.inject({ method: "PATCH", url: `/api/admin/cuencadas/${randomUUID()}`, payload: { title: "X" }, ...adminAuth });

    expect(before.statusCode).toBe(400);
    expect(errorOf(before.body).details?.[0]?.path).toBe("endsAt");
    expect(empty.statusCode).toBe(400);
    expect(ok.statusCode).toBe(200);
    expect(ok.json<AdminCuencada>()).toMatchObject({ title: "Cuencada 2027 en Mérida", year: 2028, slug: "2028" });
    expect(missing.statusCode).toBe(404);
    const rows = await audits("cuencada.updated");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toEqual({ year: 2028, fields: ["title", "year"] });
  });

  it("refuses to change the year of a published edition with 409, but allows it after unpublishing", async () => {
    const edition = await insertCuencada({ year: 2026 });
    const url = `/api/admin/cuencadas/${edition.id}`;

    const locked = await app.inject({ method: "PATCH", url, payload: { year: 2030 }, ...adminAuth });
    const sameYear = await app.inject({ method: "PATCH", url, payload: { year: 2026, title: "Cuencada 2026 en Mérida" }, ...adminAuth });
    const unpublishAndMove = await app.inject({ method: "PATCH", url, payload: { year: 2030, isPublished: false }, ...adminAuth });
    await app.inject({ method: "PATCH", url, payload: { isPublished: false }, ...adminAuth });
    const draftMove = await app.inject({ method: "PATCH", url, payload: { year: 2030 }, ...adminAuth });

    expect(locked.statusCode).toBe(409);
    expect(errorOf(locked.body)).toMatchObject({ code: "CONFLICT", details: [{ path: "year" }] });
    expect(errorOf(locked.body).message).toContain("No se puede cambiar el año de una Cuencada publicada");
    expect(sameYear.statusCode).toBe(200);
    expect(unpublishAndMove.statusCode).toBe(409);
    expect(draftMove.statusCode).toBe(200);
    expect(draftMove.json<AdminCuencada>()).toMatchObject({ year: 2030, slug: "2030", status: "draft" });
  });

  it("answers 409 when PATCH moves an edition onto an existing year", async () => {
    await insertCuencada({ year: 2026 });
    const other = await insertCuencada({ year: 2027, isPublished: false });

    const response = await app.inject({ method: "PATCH", url: `/api/admin/cuencadas/${other.id}`, payload: { year: 2026 }, ...adminAuth });

    expect(response.statusCode).toBe(409);
  });

  it("deletes only drafts that were never published and have no media", async () => {
    const published = await insertCuencada({ year: 2026 });
    const neverPublished = await insertCuencada({ year: 2027, isPublished: false });
    const wasPublished = await insertCuencada({ year: 2028, isPublished: false });
    await getTestDb().insert(chatRooms).values({ kind: "cuencada", cuencadaId: wasPublished.id, title: "Cuencada 2028" });
    const withMedia = await insertCuencada({ year: 2029, isPublished: false });
    await insertMedia(withMedia.id, { uploadStatus: "pending_upload" });
    // Published before (first_published_at set) but without a chat room: still blocked.
    const stamped = await insertCuencada({ year: 2030, isPublished: false, firstPublishedAt: new Date("2026-01-01T00:00:00Z") });

    const blockedPublished = await app.inject({ method: "DELETE", url: `/api/admin/cuencadas/${published.id}`, ...adminAuth });
    const blockedWasPublished = await app.inject({ method: "DELETE", url: `/api/admin/cuencadas/${wasPublished.id}`, ...adminAuth });
    const blockedMedia = await app.inject({ method: "DELETE", url: `/api/admin/cuencadas/${withMedia.id}`, ...adminAuth });
    const blockedStamped = await app.inject({ method: "DELETE", url: `/api/admin/cuencadas/${stamped.id}`, ...adminAuth });
    const deleted = await app.inject({ method: "DELETE", url: `/api/admin/cuencadas/${neverPublished.id}`, ...adminAuth });
    const again = await app.inject({ method: "DELETE", url: `/api/admin/cuencadas/${neverPublished.id}`, ...adminAuth });
    const invalid = await app.inject({ method: "DELETE", url: "/api/admin/cuencadas/123", ...adminAuth });

    expect(blockedPublished.statusCode).toBe(409);
    expect(blockedWasPublished.statusCode).toBe(409);
    expect(blockedMedia.statusCode).toBe(409);
    expect(blockedStamped.statusCode).toBe(409);
    expect(deleted.statusCode).toBe(204);
    expect(deleted.body).toBe("");
    expect(again.statusCode).toBe(404);
    expect(invalid.statusCode).toBe(400);
    expect(await getTestDb().select().from(cuencadas)).toHaveLength(4);
    const rows = await audits("cuencada.deleted");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.entityId).toBe(neverPublished.id);
  });
});

describe("itinerary admin", () => {
  it("persists tags on create and patch, normalized and de-duplicated, and shows them publicly and to members", async () => {
    const edition = await insertCuencada();
    const created = await app.inject({
      method: "POST",
      url: `/api/admin/cuencadas/${edition.id}/itinerary`,
      payload: { date: "2026-09-14", title: "Cenote", tags: [" Incluye comida ", "incluye COMIDA", "Traer traje de baño"] },
      ...adminAuth
    });
    const privateItem = await app.inject({
      method: "POST",
      url: `/api/admin/cuencadas/${edition.id}/itinerary`,
      payload: { date: "2026-09-15", title: "Cena privada", visibility: "members", tags: ["Solo familia"] },
      ...adminAuth
    });
    const unsafe = await app.inject({
      method: "POST",
      url: `/api/admin/cuencadas/${edition.id}/itinerary`,
      payload: { date: "2026-09-15", title: "Mal", tags: ["\u202Eatnec"] },
      ...adminAuth
    });
    expect(created.statusCode).toBe(201);
    expect(created.json<ItineraryItem>().tags).toEqual(["Incluye comida", "Traer traje de baño"]);
    expect(unsafe.statusCode).toBe(400);

    const id = created.json<ItineraryItem>().id;
    const patched = await app.inject({ method: "PATCH", url: `/api/admin/itinerary/${id}`, payload: { tags: ["Playa", "playa"] }, ...adminAuth });
    const untouched = await app.inject({ method: "PATCH", url: `/api/admin/itinerary/${id}`, payload: { title: "Cenote Santa Bárbara" }, ...adminAuth });
    const tooMany = await app.inject({
      method: "PATCH",
      url: `/api/admin/itinerary/${id}`,
      payload: { tags: ["a", "b", "c", "d", "e", "f", "g"] },
      ...adminAuth
    });
    expect(patched.json<ItineraryItem>().tags).toEqual(["Playa"]);
    expect(untouched.json<ItineraryItem>().tags).toEqual(["Playa"]);
    expect(tooMany.statusCode).toBe(400);

    const publicView = await app.inject({ method: "GET", url: "/api/cuencadas/2026" });
    const memberView = await app.inject({ method: "GET", url: "/api/cuencadas/2026/members", ...(await loginAs(app, await createUser())) });
    expect(publicView.json<{ publicItinerary: ItineraryItem[] }>().publicItinerary.map((item) => item.tags)).toEqual([["Playa"]]);
    expect(memberView.json<{ itinerary: ItineraryItem[] }>().itinerary.map((item) => [item.title, item.tags])).toEqual([
      ["Cenote Santa Bárbara", ["Playa"]],
      ["Cena privada", ["Solo familia"]]
    ]);
    expect(privateItem.statusCode).toBe(201);
  });

  it("appends items, enforces same-Cuencada locations and audits", async () => {
    const edition = await insertCuencada();
    const other = await insertCuencada({ year: 2027 });
    const ownLocation = await insertLocation(edition.id);
    const foreignLocation = await insertLocation(other.id);
    const url = `/api/admin/cuencadas/${edition.id}/itinerary`;

    const first = await app.inject({
      method: "POST",
      url,
      payload: { date: "2026-09-13", startTime: "19:30", title: "Llegada", locationId: ownLocation.id },
      ...adminAuth
    });
    const second = await app.inject({ method: "POST", url, payload: { date: "2026-09-14", title: "Cenote" }, ...adminAuth });
    const foreign = await app.inject({
      method: "POST",
      url,
      payload: { date: "2026-09-14", title: "Mal", locationId: foreignLocation.id },
      ...adminAuth
    });
    const badTimes = await app.inject({
      method: "POST",
      url,
      payload: { date: "2026-09-14", title: "Mal", startTime: "10:00", endTime: "09:00" },
      ...adminAuth
    });
    const missing = await app.inject({
      method: "POST",
      url: `/api/admin/cuencadas/${randomUUID()}/itinerary`,
      payload: { date: "2026-09-14", title: "X" },
      ...adminAuth
    });

    expect(first.statusCode).toBe(201);
    expect(first.json<ItineraryItem>()).toMatchObject({ startTime: "19:30", sortOrder: 0, visibility: "public", locationId: ownLocation.id });
    expect(second.json<ItineraryItem>().sortOrder).toBe(1);
    expect(foreign.statusCode).toBe(400);
    expect(errorOf(foreign.body).details?.[0]?.path).toBe("locationId");
    expect(badTimes.statusCode).toBe(400);
    expect(missing.statusCode).toBe(404);
    expect(await audits("itinerary_item.created")).toHaveLength(2);
  });

  it("re-validates merged times and the location on PATCH, then deletes", async () => {
    const edition = await insertCuencada();
    const other = await insertCuencada({ year: 2027 });
    const foreignLocation = await insertLocation(other.id);
    const item = await insertItineraryItem(edition.id, { startTime: "10:00", endTime: "12:00" });
    const url = `/api/admin/itinerary/${item.id}`;

    const merged = await app.inject({ method: "PATCH", url, payload: { endTime: "09:30" }, ...adminAuth });
    const foreign = await app.inject({ method: "PATCH", url, payload: { locationId: foreignLocation.id }, ...adminAuth });
    const ok = await app.inject({ method: "PATCH", url, payload: { startTime: "08:00", endTime: "09:30", priceNote: "$1,000 p/p" }, ...adminAuth });
    const removed = await app.inject({ method: "DELETE", url, ...adminAuth });
    const gone = await app.inject({ method: "PATCH", url, payload: { title: "X" }, ...adminAuth });

    expect(merged.statusCode).toBe(400);
    expect(errorOf(merged.body).details?.[0]?.path).toBe("endTime");
    expect(foreign.statusCode).toBe(400);
    expect(ok.statusCode).toBe(200);
    expect(ok.json<ItineraryItem>()).toMatchObject({ startTime: "08:00", endTime: "09:30", priceNote: "$1,000 p/p" });
    expect(removed.statusCode).toBe(204);
    expect(gone.statusCode).toBe(404);
    expect(await audits("itinerary_item.updated")).toHaveLength(1);
    expect(await audits("itinerary_item.deleted")).toHaveLength(1);
  });

  it("reorders every item in one transaction and rejects partial or foreign lists", async () => {
    const edition = await insertCuencada();
    const other = await insertCuencada({ year: 2027 });
    const a = await insertItineraryItem(edition.id, { title: "A", sortOrder: 0 });
    const b = await insertItineraryItem(edition.id, { title: "B", sortOrder: 1 });
    const c = await insertItineraryItem(edition.id, { title: "C", sortOrder: 2 });
    const foreign = await insertItineraryItem(other.id, { title: "Z" });
    const url = `/api/admin/cuencadas/${edition.id}/itinerary/order`;

    const partial = await app.inject({ method: "PUT", url, payload: { ids: [a.id, b.id] }, ...adminAuth });
    const withForeign = await app.inject({ method: "PUT", url, payload: { ids: [a.id, b.id, foreign.id] }, ...adminAuth });
    const duplicated = await app.inject({ method: "PUT", url, payload: { ids: [a.id, a.id, b.id] }, ...adminAuth });
    const ok = await app.inject({ method: "PUT", url, payload: { ids: [c.id, a.id, b.id] }, ...adminAuth });

    expect(partial.statusCode).toBe(400);
    expect(withForeign.statusCode).toBe(400);
    expect(duplicated.statusCode).toBe(400);
    expect(ok.statusCode).toBe(200);
    expect(ok.json<ItineraryItem[]>().map((item) => [item.title, item.sortOrder])).toEqual([
      ["C", 0],
      ["A", 1],
      ["B", 2]
    ]);
    const [moved] = await getTestDb().select().from(cuencadaItineraryItems).where(eq(cuencadaItineraryItems.id, c.id));
    expect(moved?.updatedAt.toISOString()).toBe("2026-09-01T18:00:00.000Z");
    const [untouched] = await getTestDb()
      .select()
      .from(cuencadaItineraryItems)
      .where(and(eq(cuencadaItineraryItems.id, foreign.id)));
    expect(untouched?.sortOrder).toBe(0);
    expect(await audits("itinerary_item.reordered")).toHaveLength(1);
  });
});

describe("locations admin", () => {
  it("creates, reorders, patches (merged lat/lng) and deletes locations, unlinking itinerary items", async () => {
    const edition = await insertCuencada();
    const url = `/api/admin/cuencadas/${edition.id}/locations`;

    const hotel = await app.inject({
      method: "POST",
      url,
      payload: { name: "Hotel Chariot", kind: "hotel", lat: 20.97, lng: -89.62, url: "https://www.hotelchariotmerida.com/" },
      ...adminAuth
    });
    const cenote = await app.inject({ method: "POST", url, payload: { name: "Cenote", kind: "attraction" }, ...adminAuth });
    const halfCoords = await app.inject({ method: "POST", url, payload: { name: "Mal", lat: 20 }, ...adminAuth });
    expect(hotel.statusCode).toBe(201);
    expect(cenote.json<LocationItem>().sortOrder).toBe(1);
    expect(halfCoords.statusCode).toBe(400);

    const hotelId = hotel.json<LocationItem>().id;
    const cenoteId = cenote.json<LocationItem>().id;
    const reordered = await app.inject({ method: "PUT", url: `${url}/order`, payload: { ids: [cenoteId, hotelId] }, ...adminAuth });
    expect(reordered.json<LocationItem[]>().map((l) => l.name)).toEqual(["Cenote", "Hotel Chariot"]);

    const onlyLat = await app.inject({ method: "PATCH", url: `/api/admin/locations/${hotelId}`, payload: { lat: 21 }, ...adminAuth });
    const clear = await app.inject({
      method: "PATCH",
      url: `/api/admin/locations/${hotelId}`,
      payload: { lat: null, lng: null, description: "Hotel base" },
      ...adminAuth
    });
    expect(onlyLat.statusCode).toBe(400);
    expect(clear.json<LocationItem>()).toMatchObject({ lat: null, lng: null, description: "Hotel base" });

    const item = await insertItineraryItem(edition.id, { locationId: hotelId });
    const removed = await app.inject({ method: "DELETE", url: `/api/admin/locations/${hotelId}`, ...adminAuth });
    const missing = await app.inject({ method: "DELETE", url: `/api/admin/locations/${hotelId}`, ...adminAuth });
    expect(removed.statusCode).toBe(204);
    expect(missing.statusCode).toBe(404);
    const [unlinked] = await getTestDb().select().from(cuencadaItineraryItems).where(eq(cuencadaItineraryItems.id, item.id));
    expect(unlinked?.locationId).toBeNull();
    expect(await audits("location.created")).toHaveLength(2);
    expect(await audits("location.reordered")).toHaveLength(1);
    expect(await audits("location.updated")).toHaveLength(1);
    expect(await audits("location.deleted")).toHaveLength(1);
  });
});

describe("daily messages admin", () => {
  it("upserts, lists and deletes one date", async () => {
    const edition = await insertCuencada();
    const base = `/api/admin/cuencadas/${edition.id}/daily-messages`;

    const created = await app.inject({ method: "PUT", url: `${base}/2026-09-13`, payload: { message: "Hola" }, ...adminAuth });
    const updated = await app.inject({ method: "PUT", url: `${base}/2026-09-13`, payload: { message: "Hola de nuevo" }, ...adminAuth });
    const badDate = await app.inject({ method: "PUT", url: `${base}/2026-13-40`, payload: { message: "X" }, ...adminAuth });
    const blank = await app.inject({ method: "PUT", url: `${base}/2026-09-14`, payload: { message: "   " }, ...adminAuth });
    const list = await app.inject({ method: "GET", url: base, ...adminAuth });
    const removed = await app.inject({ method: "DELETE", url: `${base}/2026-09-13`, ...adminAuth });
    const missing = await app.inject({ method: "DELETE", url: `${base}/2026-09-13`, ...adminAuth });
    const unknownEdition = await app.inject({
      method: "PUT",
      url: `/api/admin/cuencadas/${randomUUID()}/daily-messages/2026-09-13`,
      payload: { message: "X" },
      ...adminAuth
    });

    expect(created.statusCode).toBe(200);
    expect(updated.json<DailyMessage>()).toMatchObject({ id: created.json<DailyMessage>().id, message: "Hola de nuevo" });
    expect(badDate.statusCode).toBe(400);
    expect(blank.statusCode).toBe(400);
    expect(list.json<DailyMessage[]>()).toHaveLength(1);
    expect(removed.statusCode).toBe(204);
    expect(missing.statusCode).toBe(404);
    expect(unknownEdition.statusCode).toBe(404);
    expect(await audits("daily_message.saved")).toHaveLength(2);
    expect(await audits("daily_message.deleted")).toHaveLength(1);
  });

  it("imports text and JSON entries (merge and replace) and audits counts", async () => {
    const edition = await insertCuencada();
    await insertDailyMessage(edition.id, "2026-09-10", "Viejo");
    await insertDailyMessage(edition.id, "2026-09-11", "Se queda");
    const url = `/api/admin/cuencadas/${edition.id}/daily-messages/import`;

    const merge = await app.inject({
      method: "POST",
      url,
      payload: { text: "﻿# comentario\r\n2026-09-10|Nuevo | con barra\r\n\r\n2026-09-12|Mañana", entries: [{ date: "2026-09-13", message: "Hoy" }] },
      ...adminAuth
    });
    expect(merge.statusCode).toBe(200);
    expect(merge.json()).toEqual({ created: 2, updated: 1, deleted: 0 });

    const replace = await app.inject({
      method: "POST",
      url,
      payload: { entries: [{ date: "2026-09-13", message: "Hoy otra vez" }], mode: "replace" },
      ...adminAuth
    });
    expect(replace.json()).toEqual({ created: 0, updated: 1, deleted: 3 });

    const unchanged = await app.inject({
      method: "POST",
      url,
      payload: { entries: [{ date: "2026-09-13", message: "Hoy otra vez" }, { date: "2026-09-14", message: "Nuevo" }] },
      ...adminAuth
    });
    expect(unchanged.json()).toEqual({ created: 1, updated: 0, deleted: 0 });
    await getTestDb().delete(dailyMessages).where(eq(dailyMessages.date, "2026-09-14"));
    const rows = await getTestDb().select().from(dailyMessages).where(eq(dailyMessages.cuencadaId, edition.id));
    expect(rows.map((row) => [row.date, row.message])).toEqual([["2026-09-13", "Hoy otra vez"]]);

    const audit = await audits("daily_message.imported");
    expect(audit.map((row) => row.metadata)).toEqual([
      { mode: "merge", created: 2, updated: 1, deleted: 0 },
      { mode: "replace", created: 0, updated: 1, deleted: 3 },
      { mode: "merge", created: 1, updated: 0, deleted: 0 }
    ]);
  });

  it("writes nothing when any line fails and caps the error details at 100", async () => {
    const edition = await insertCuencada();
    const url = `/api/admin/cuencadas/${edition.id}/daily-messages/import`;
    const badLines = Array.from({ length: 150 }, (_, index) => `linea-mala-${index}`);
    const text = ["2026-09-13|Válido", ...badLines].join("\n");

    const many = await app.inject({ method: "POST", url, payload: { text }, ...adminAuth });
    const duplicate = await app.inject({
      method: "POST",
      url,
      payload: { text: "2026-09-13|Uno", entries: [{ date: "2026-09-13", message: "Dos" }] },
      ...adminAuth
    });
    const empty = await app.inject({ method: "POST", url, payload: {}, ...adminAuth });
    const onlyComments = await app.inject({ method: "POST", url, payload: { text: "# nada" }, ...adminAuth });

    expect(many.statusCode).toBe(400);
    const details = errorOf(many.body).details ?? [];
    expect(details).toHaveLength(100);
    expect(details[0]?.path).toBe("lines.2");
    expect(details[99]?.path).toBe("lines");
    expect(duplicate.statusCode).toBe(400);
    expect(errorOf(duplicate.body).details).toEqual([{ path: "entries.0", message: expect.any(String) }]);
    expect(empty.statusCode).toBe(400);
    expect(onlyComments.statusCode).toBe(400);
    expect(await getTestDb().select().from(dailyMessages)).toHaveLength(0);
    expect(await audits("daily_message.imported")).toHaveLength(0);
  });
});
