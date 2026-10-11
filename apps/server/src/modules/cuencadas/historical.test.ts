import type { AdminCuencada, ApiError, ChatRoom, CuencadaHome, CuencadaSummary, PublicCuencada } from "@cuencada/types";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import { insertCuencada, type MutableClock, mutableClock } from "../../../test/helpers/cuencadas.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { type AuthInjectOptions, createUser, loginAs } from "../../../test/helpers/factories.js";
import type { App } from "../../app.js";
import { auditLogs, chatRooms } from "../../db/schema/index.js";

/**
 * WP-5.1: past Cuencadas. Undated editions of earlier years are `past`, and
 * historical editions ("Cuencada anterior", before the portal) get no chat
 * room, refuse RSVPs and never become the Home hero. Fixtures are fictional.
 */

let app: App;
let clock: MutableClock;
let adminAuth: AuthInjectOptions;

beforeEach(async () => {
  clock = mutableClock("2026-10-11T18:00:00Z");
  app = await createTestApp({ clock });
  adminAuth = await loginAs(app, await createUser({ role: "admin" }));
});

afterEach(async () => {
  await app.close();
});

function errorOf(body: string): ApiError["error"] {
  return (JSON.parse(body) as ApiError).error; // test-only: the envelope shape is asserted by the status code
}

const historical2019 = {
  year: 2019,
  title: "Cuencada 2019",
  description: "Nos reunimos en la casa de la abuela.",
  isHistorical: true,
  isPublished: true
};

async function createHistorical(payload: Record<string, unknown> = historical2019) {
  return app.inject({ method: "POST", url: "/api/admin/cuencadas", payload, ...adminAuth });
}

describe("POST /api/admin/cuencadas with isHistorical", () => {
  it("creates a published historical edition without dates: past, no chat room, audited", async () => {
    const created = await createHistorical();

    expect(created.statusCode).toBe(201);
    const body = created.json<AdminCuencada>();
    expect(body).toMatchObject({ year: 2019, isHistorical: true, isPublished: true, status: "past", startsAt: null, city: null });
    expect(await getTestDb().select().from(chatRooms).where(eq(chatRooms.cuencadaId, body.id))).toEqual([]);
    const published = await getTestDb().select().from(auditLogs).where(eq(auditLogs.action, "cuencada.published"));
    expect(published.map((row) => row.metadata)).toEqual([{ year: 2019, chatRoomCreated: false }]);
  });

  it("accepts optional dates and place", async () => {
    const created = await createHistorical({
      ...historical2019,
      startsAt: "2019-09-10T00:00:00-06:00",
      endsAt: "2019-09-15T00:00:00-06:00",
      city: "Ciudad Ficticia",
      state: "Estado Ficticio"
    });
    expect(created.statusCode).toBe(201);
    expect(created.json<AdminCuencada>()).toMatchObject({ status: "past", city: "Ciudad Ficticia" });
  });

  it("rejects a historical edition of the current or a future year with 400 on year", async () => {
    for (const year of [2026, 2030]) {
      const response = await createHistorical({ ...historical2019, year });
      expect(response.statusCode, String(year)).toBe(400);
      expect(errorOf(response.body)).toMatchObject({
        code: "VALIDATION",
        message: "Una Cuencada anterior debe ser de un año pasado.",
        details: [{ path: "year", message: "Una Cuencada anterior debe ser de un año pasado." }]
      });
    }
  });

  it("uses the edition's timezone for the current year", async () => {
    // 2027-01-01T03:00Z is still 2026 in Mérida (UTC-6) but already 2027 in Tokyo.
    clock.set("2027-01-01T03:00:00Z");
    adminAuth = await loginAs(app, await createUser({ role: "admin" }));
    const merida = await createHistorical({ ...historical2019, year: 2026 });
    const tokyo = await createHistorical({ ...historical2019, year: 2026, timezone: "Asia/Tokyo" });
    expect(merida.statusCode).toBe(400);
    expect(tokyo.statusCode).toBe(201);
  });
});

describe("PATCH /api/admin/cuencadas/:id with isHistorical", () => {
  it("re-checks the merged year and timezone", async () => {
    const edition = await insertCuencada({ year: 2027, isPublished: false });
    const url = `/api/admin/cuencadas/${edition.id}`;

    const flagged = await app.inject({ method: "PATCH", url, payload: { isHistorical: true }, ...adminAuth });
    expect(flagged.statusCode).toBe(400);
    expect(errorOf(flagged.body).details?.[0]?.path).toBe("year");

    const moved = await app.inject({ method: "PATCH", url, payload: { isHistorical: true, year: 2018 }, ...adminAuth });
    expect(moved.statusCode).toBe(200);
    expect(moved.json<AdminCuencada>()).toMatchObject({ year: 2018, isHistorical: true, status: "draft" });

    const back = await app.inject({ method: "PATCH", url, payload: { year: 2028 }, ...adminAuth });
    expect(back.statusCode).toBe(400);
  });

  it("publishes a historical draft without creating a chat room", async () => {
    const draft = await insertCuencada({ year: 2018, isPublished: false, isHistorical: true });
    const published = await app.inject({
      method: "PATCH",
      url: `/api/admin/cuencadas/${draft.id}`,
      payload: { isPublished: true },
      ...adminAuth
    });
    expect(published.statusCode).toBe(200);
    expect(published.json<AdminCuencada>().status).toBe("past");
    expect(await getTestDb().select().from(chatRooms).where(eq(chatRooms.cuencadaId, draft.id))).toEqual([]);
  });

  it("keeps an existing chat room when an edition becomes historical but hides it, and shows it again when unflagged", async () => {
    const edition = await insertCuencada({ year: 2024, firstPublishedAt: new Date("2024-01-01T00:00:00Z") });
    const [room] = await getTestDb()
      .insert(chatRooms)
      .values({ kind: "cuencada", cuencadaId: edition.id, title: "Cuencada 2024" })
      .returning();
    if (room === undefined) throw new Error("room not inserted");
    const member = await loginAs(app, await createUser({ emailVerified: true }));
    const roomIds = async (): Promise<string[]> => {
      const response = await app.inject({ method: "GET", url: "/api/chat/rooms", ...member });
      expect(response.statusCode).toBe(200);
      return response.json<ChatRoom[]>().map((r) => r.id);
    };
    expect(await roomIds()).toContain(room.id);

    const url = `/api/admin/cuencadas/${edition.id}`;
    expect((await app.inject({ method: "PATCH", url, payload: { isHistorical: true }, ...adminAuth })).statusCode).toBe(200);
    expect(await getTestDb().select().from(chatRooms).where(eq(chatRooms.id, room.id))).toHaveLength(1);
    expect(await roomIds()).not.toContain(room.id);
    const byId = await app.inject({ method: "GET", url: `/api/chat/rooms/${room.id}/messages`, ...member });
    expect(byId.statusCode).toBe(404);

    expect((await app.inject({ method: "PATCH", url, payload: { isHistorical: false }, ...adminAuth })).statusCode).toBe(200);
    expect(await roomIds()).toContain(room.id);
    expect(await getTestDb().select().from(chatRooms).where(eq(chatRooms.cuencadaId, edition.id))).toHaveLength(1);
  });

  it("creates the skipped chat room when a published edition stops being historical", async () => {
    const edition = await insertCuencada({ year: 2020, isHistorical: true });
    const response = await app.inject({
      method: "PATCH",
      url: `/api/admin/cuencadas/${edition.id}`,
      payload: { isHistorical: false },
      ...adminAuth
    });
    expect(response.statusCode).toBe(200);
    expect(await getTestDb().select().from(chatRooms).where(eq(chatRooms.cuencadaId, edition.id))).toHaveLength(1);
  });
});

describe("RSVP on past editions", () => {
  it("refuses an RSVP for a historical edition and for an undated edition of an earlier year with 409", async () => {
    await insertCuencada({ year: 2019, startsAt: null, endsAt: null, isHistorical: true });
    await insertCuencada({ year: 2021, startsAt: null, endsAt: null });
    const member = await loginAs(app, await createUser());
    for (const year of [2019, 2021]) {
      const put = await app.inject({ method: "PUT", url: `/api/cuencadas/${year}/rsvp/me`, payload: { status: "yes" }, ...member });
      expect(put.statusCode, String(year)).toBe(409);
      expect(errorOf(put.body).message).toBe("Esta Cuencada ya pasó; ya no se pueden cambiar las confirmaciones.");
      const me = await app.inject({ method: "GET", url: `/api/cuencadas/${year}/rsvp/me`, ...member });
      expect(me.json<{ editable: boolean }>().editable).toBe(false);
    }
  });
});

describe("public reads of past editions", () => {
  it("lists undated past and historical editions as past, and links the newest one from Home", async () => {
    await insertCuencada({ year: 2019, startsAt: null, endsAt: null, city: null, state: null, isHistorical: true });
    await insertCuencada({ year: 2021, startsAt: null, endsAt: null });
    await insertCuencada({ year: 2027, startsAt: null, endsAt: null });

    const list = (await app.inject({ method: "GET", url: "/api/cuencadas" })).json<CuencadaSummary[]>();
    expect(list.map(({ year, status, isHistorical }) => ({ year, status, isHistorical }))).toEqual([
      { year: 2027, status: "announced", isHistorical: false },
      { year: 2021, status: "past", isHistorical: false },
      { year: 2019, status: "past", isHistorical: true }
    ]);

    const home = (await app.inject({ method: "GET", url: "/api/cuencadas/home" })).json<CuencadaHome>();
    expect(home.mode).toBe("announced");
    expect(home.featured?.year).toBe(2027);
    expect(home.latestPast?.year).toBe(2021);

    const page = (await app.inject({ method: "GET", url: "/api/cuencadas/2019" })).json<PublicCuencada>();
    expect(page).toMatchObject({ status: "past", isHistorical: true });
  });

  it("never features a historical edition, even with dates that would make it active", async () => {
    // Inserted directly: the API would refuse a historical edition of the current year.
    await insertCuencada({
      year: 2025,
      startsAt: new Date("2026-10-10T00:00:00-06:00"),
      endsAt: new Date("2026-10-12T23:59:59-06:00"),
      isHistorical: true
    });
    const home = (await app.inject({ method: "GET", url: "/api/cuencadas/home" })).json<CuencadaHome>();
    expect(home).toMatchObject({ mode: "memories", featured: null });
    expect(home.latestPast?.year).toBe(2025);
  });
});
