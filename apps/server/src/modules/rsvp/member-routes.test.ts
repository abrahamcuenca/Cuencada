import type { ApiError, Attendee, MyRsvp, MyRsvpResponse, RsvpSummary } from "@cuencada/types";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import { insertCuencada, insertLocation, type MutableClock, mutableClock } from "../../../test/helpers/cuencadas.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { type AuthInjectOptions, createUser, loginAs, type TestUser } from "../../../test/helpers/factories.js";
import type { App } from "../../app.js";
import { auditLogs, cuencadaAttendance, cuencadaRsvps, people, profiles } from "../../db/schema/index.js";

let app: App;
let clock: MutableClock;
let member: TestUser;
let memberAuth: AuthInjectOptions;

beforeEach(async () => {
  clock = mutableClock("2026-09-01T18:00:00Z");
  app = await createTestApp({ clock });
  member = await createUser({
    emailVerified: true,
    displayName: "Beto Cuenca"
  });
  memberAuth = await loginAs(app, member);
});

afterEach(async () => {
  await app.close();
});

function errorOf(body: string): ApiError["error"] {
  return (JSON.parse(body) as ApiError).error; // test-only: the envelope shape is implied by the status code
}

async function insertPerson(fullName: string, userId: string | null = null): Promise<string> {
  const [row] = await getTestDb().insert(people).values({ fullName, userId }).returning({ id: people.id });
  if (row === undefined) throw new Error("insertPerson: no row");
  return row.id;
}

/** Move the app clock and log in again (access tokens are clock-bound, 15 min). */
async function moveClock(iso: string): Promise<void> {
  clock.set(iso);
  memberAuth = await loginAs(app, member);
}

async function putRsvp(year: number, payload: Record<string, unknown>, auth: AuthInjectOptions = memberAuth) {
  return app.inject({
    method: "PUT",
    url: `/api/cuencadas/${year}/rsvp/me`,
    payload,
    ...auth
  });
}

describe("GET /api/cuencadas/:year/rsvp/me", () => {
  it("returns null before the first RSVP, with the deadline and editable flag", async () => {
    await insertCuencada({
      rsvpDeadline: new Date("2026-09-10T12:00:00-06:00")
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/cuencadas/2026/rsvp/me",
      ...memberAuth
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<MyRsvpResponse>()).toEqual({
      rsvp: null,
      deadline: "2026-09-10T18:00:00.000Z",
      editable: true
    });
  });

  it("returns the saved RSVP and editable false for a past edition", async () => {
    const past = await insertCuencada({ year: 2025 });
    await getTestDb().insert(cuencadaRsvps).values({
      cuencadaId: past.id,
      userId: member.id,
      status: "yes",
      guestCount: 2
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/cuencadas/2025/rsvp/me",
      ...memberAuth
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<MyRsvpResponse>();
    expect(body.editable).toBe(false);
    expect(body.rsvp).toMatchObject({
      cuencadaId: past.id,
      status: "yes",
      guestCount: 2
    });
  });

  it("answers 400 for a bad year, 401 without a token and 404 for drafts", async () => {
    await insertCuencada({ year: 2027, isPublished: false });
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/cuencadas/abc/rsvp/me",
          ...memberAuth
        })
      ).statusCode
    ).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/cuencadas/2026/rsvp/me" })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/cuencadas/2027/rsvp/me",
          ...memberAuth
        })
      ).statusCode
    ).toBe(404);
  });

  it("answers 403 while the temporary password is pending", async () => {
    await insertCuencada();
    const pending = await createUser({ mustChangePassword: true });
    const res = await app.inject({
      method: "GET",
      url: "/api/cuencadas/2026/rsvp/me",
      ...(await loginAs(app, pending))
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("PUT /api/cuencadas/:year/rsvp/me", () => {
  it("creates then updates the RSVP on the unique (cuencada, user) and audits without notes", async () => {
    const edition = await insertCuencada();
    const hotel = await insertLocation(edition.id, {
      kind: "hotel",
      name: "Hotel Mérida"
    });
    const created = await putRsvp(2026, {
      status: "yes",
      guestCount: 3,
      arrivalDate: "2026-09-12",
      departureDate: "2026-09-19",
      hotelLocationId: hotel.id,
      notes: "Llegamos tarde"
    });
    expect(created.statusCode).toBe(200);
    expect(created.json<MyRsvp>()).toEqual({
      cuencadaId: edition.id,
      status: "yes",
      guestCount: 3,
      arrivalDate: "2026-09-12",
      departureDate: "2026-09-19",
      hotelLocationId: hotel.id,
      notes: "Llegamos tarde",
      updatedAt: "2026-09-01T18:00:00.000Z"
    });

    await moveClock("2026-09-02T18:00:00Z");
    const updated = await putRsvp(2026, { status: "maybe" });
    expect(updated.statusCode).toBe(200);
    expect(updated.json<MyRsvp>()).toMatchObject({
      status: "maybe",
      guestCount: 0,
      hotelLocationId: null,
      notes: null
    });
    expect(updated.json<MyRsvp>().updatedAt).toBe("2026-09-02T18:00:00.000Z");

    const rows = await getTestDb()
      .select()
      .from(cuencadaRsvps)
      .where(and(eq(cuencadaRsvps.cuencadaId, edition.id), eq(cuencadaRsvps.userId, member.id)));
    expect(rows).toHaveLength(1);

    const audits = await getTestDb().select().from(auditLogs).where(eq(auditLogs.action, "rsvp.saved"));
    expect(audits.map((row) => row.metadata)).toEqual([
      { cuencadaId: edition.id, status: "yes", guestCount: 3, created: true },
      {
        cuencadaId: edition.id,
        status: "maybe",
        guestCount: 0,
        created: false
      }
    ]);
    expect(JSON.stringify(audits)).not.toContain("Llegamos tarde");
  });

  it("answers 400 for schema violations: guests, notes length and departure before arrival", async () => {
    await insertCuencada();
    const cases = [
      { status: "yes", guestCount: 21 },
      { status: "yes", guestCount: -1 },
      { status: "yes", notes: "x".repeat(501) },
      { status: "yes", arrivalDate: "2026-09-15", departureDate: "2026-09-14" },
      { status: "tal vez" }
    ];
    for (const payload of cases) {
      const res = await putRsvp(2026, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(errorOf(res.body).code).toBe("VALIDATION");
    }
  });

  it("answers 400 for dates outside the stay window around the edition", async () => {
    await insertCuencada();
    const early = await putRsvp(2026, {
      status: "yes",
      arrivalDate: "2026-08-29"
    });
    expect(early.statusCode).toBe(400);
    expect(errorOf(early.body).details?.map((detail) => detail.path)).toEqual(["arrivalDate"]);
    const late = await putRsvp(2026, {
      status: "yes",
      departureDate: "2026-10-03"
    });
    expect(late.statusCode).toBe(400);
    expect(
      (
        await putRsvp(2026, {
          status: "yes",
          arrivalDate: "2026-08-30",
          departureDate: "2026-10-02"
        })
      ).statusCode
    ).toBe(200);
  });

  it("answers 400 for a hotel of another edition and for a non-hotel location", async () => {
    const edition = await insertCuencada();
    const other = await insertCuencada({ year: 2027 });
    const foreignHotel = await insertLocation(other.id, { kind: "hotel" });
    const venue = await insertLocation(edition.id, { kind: "venue" });
    for (const hotelLocationId of [foreignHotel.id, venue.id, "00000000-0000-4000-8000-000000000000"]) {
      const res = await putRsvp(2026, { status: "yes", hotelLocationId });
      expect(res.statusCode).toBe(400);
      expect(errorOf(res.body).details).toEqual([
        {
          path: "hotelLocationId",
          message: "Elige un hotel de esta Cuencada."
        }
      ]);
    }
    const rows = await getTestDb().select().from(cuencadaRsvps);
    expect(rows).toHaveLength(0);
  });

  it("applies the deadline at local midnight in the edition's timezone", async () => {
    // Deadline stored as 09:00 on 10 Sep in Mérida (UTC-6); open through 23:59:59 local.
    await insertCuencada({
      rsvpDeadline: new Date("2026-09-10T09:00:00-06:00")
    });
    await moveClock("2026-09-11T05:59:59Z");
    expect((await putRsvp(2026, { status: "yes" })).statusCode).toBe(200);

    await moveClock("2026-09-11T06:00:00Z");
    const closed = await putRsvp(2026, { status: "no" });
    expect(closed.statusCode).toBe(409);
    expect(errorOf(closed.body)).toMatchObject({
      code: "CONFLICT",
      message: "La fecha límite para confirmar asistencia ya pasó."
    });
    const me = await app.inject({
      method: "GET",
      url: "/api/cuencadas/2026/rsvp/me",
      ...memberAuth
    });
    expect(me.json<MyRsvpResponse>()).toMatchObject({
      editable: false,
      rsvp: { status: "yes" }
    });
  });

  it("answers 409 for a past edition and accepts an active one without deadline", async () => {
    await insertCuencada({ year: 2025 });
    const past = await putRsvp(2025, { status: "yes" });
    expect(past.statusCode).toBe(409);
    expect(errorOf(past.body).message).toContain("ya pasó");

    await insertCuencada();
    await moveClock("2026-09-14T18:00:00Z");
    expect((await putRsvp(2026, { status: "yes" })).statusCode).toBe(200);
  });

  it("answers 401 without a token and 404 for a draft", async () => {
    await insertCuencada({ year: 2027, isPublished: false });
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/cuencadas/2027/rsvp/me",
          payload: { status: "yes" }
        })
      ).statusCode
    ).toBe(401);
    expect((await putRsvp(2027, { status: "yes" })).statusCode).toBe(404);
  });
});

describe("GET /api/cuencadas/:year/rsvp/summary", () => {
  it("counts by status, expected people and people per hotel, skipping disabled accounts", async () => {
    const edition = await insertCuencada();
    const hotel = await insertLocation(edition.id, {
      kind: "hotel",
      name: "Hotel Uno"
    });
    const [a, b, c, d] = await Promise.all([
      createUser(),
      createUser(),
      createUser(),
      createUser({ status: "disabled" })
    ]);
    if (a === undefined || b === undefined || c === undefined || d === undefined) throw new Error("users");
    await getTestDb()
      .insert(cuencadaRsvps)
      .values([
        {
          cuencadaId: edition.id,
          userId: member.id,
          status: "yes",
          guestCount: 2,
          hotelLocationId: hotel.id
        },
        { cuencadaId: edition.id, userId: a.id, status: "yes", guestCount: 0 },
        {
          cuencadaId: edition.id,
          userId: b.id,
          status: "maybe",
          guestCount: 4
        },
        { cuencadaId: edition.id, userId: c.id, status: "no" },
        {
          cuencadaId: edition.id,
          userId: d.id,
          status: "yes",
          guestCount: 9,
          hotelLocationId: hotel.id
        }
      ]);
    const res = await app.inject({
      method: "GET",
      url: "/api/cuencadas/2026/rsvp/summary",
      ...memberAuth
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<RsvpSummary>()).toEqual({
      cuencadaId: edition.id,
      yes: 2,
      maybe: 1,
      no: 1,
      expectedPeople: 4,
      byHotel: [{ locationId: hotel.id, name: "Hotel Uno", people: 3 }]
    });
  });

  it("returns zeros without RSVPs and answers 400/401/404", async () => {
    const edition = await insertCuencada();
    const res = await app.inject({
      method: "GET",
      url: "/api/cuencadas/2026/rsvp/summary",
      ...memberAuth
    });
    expect(res.json<RsvpSummary>()).toEqual({
      cuencadaId: edition.id,
      yes: 0,
      maybe: 0,
      no: 0,
      expectedPeople: 0,
      byHotel: []
    });
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/cuencadas/1/rsvp/summary",
          ...memberAuth
        })
      ).statusCode
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/cuencadas/2026/rsvp/summary"
        })
      ).statusCode
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/cuencadas/2030/rsvp/summary",
          ...memberAuth
        })
      ).statusCode
    ).toBe(404);
  });
});

describe("GET /api/cuencadas/:year/attendees", () => {
  it("unions yes RSVPs with attendance, dedupes by person and exposes no contact fields", async () => {
    const edition = await insertCuencada();
    const memberPerson = await insertPerson("Alberto Cuenca", member.id);
    await getTestDb()
      .update(profiles)
      .set({
        avatarKey: "avatars/beto.webp",
        phone: "5550100101",
        city: "Mérida"
      })
      .where(eq(profiles.userId, member.id));
    const maybeUser = await createUser({ displayName: "Carla" });
    const noPersonUser = await createUser({ displayName: "Zoe" });
    const disabled = await createUser({
      displayName: "Deshabilitado",
      status: "disabled"
    });
    const historic = await insertPerson("Abuela Rosa");

    await getTestDb()
      .insert(cuencadaRsvps)
      .values([
        { cuencadaId: edition.id, userId: member.id, status: "yes" },
        { cuencadaId: edition.id, userId: maybeUser.id, status: "maybe" },
        { cuencadaId: edition.id, userId: noPersonUser.id, status: "yes" },
        { cuencadaId: edition.id, userId: disabled.id, status: "yes" }
      ]);
    await getTestDb()
      .insert(cuencadaAttendance)
      .values([
        { cuencadaId: edition.id, personId: memberPerson },
        { cuencadaId: edition.id, personId: historic }
      ]);

    const res = await app.inject({
      method: "GET",
      url: "/api/cuencadas/2026/attendees",
      ...memberAuth
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<Attendee[]>();
    expect(body.map((row) => [row.displayName, row.source, row.rsvpStatus, row.isMe])).toEqual([
      ["Abuela Rosa", "attendance", null, false],
      ["Beto Cuenca", "rsvp", "yes", true],
      ["Zoe", "rsvp", "yes", false]
    ]);
    const me = body.find((row) => row.isMe);
    expect(me).toMatchObject({ personId: memberPerson, userId: member.id });
    expect(me?.avatarUrl).toContain("avatars/beto.webp");
    expect(body.find((row) => row.displayName === "Zoe")).toMatchObject({
      personId: null,
      userId: noPersonUser.id,
      avatarUrl: null
    });
    expect(body.find((row) => row.displayName === "Abuela Rosa")).toMatchObject({ personId: historic, userId: null });
    expect(res.body).not.toContain("5550100101");
    expect(res.body).not.toContain(member.email);
    for (const row of body)
      expect(Object.keys(row).sort()).toEqual([
        "avatarUrl",
        "displayName",
        "isMe",
        "personId",
        "rsvpStatus",
        "source",
        "userId"
      ]);
  });

  it("anonymizes unlisted people for others, keeps them complete for themselves and keeps the count", async () => {
    const edition = await insertCuencada();
    const hidden = await createUser({
      emailVerified: true,
      displayName: "Herminia Oculta",
      profile: { listedInDirectory: false, avatarKey: "avatars/herminia.webp" }
    });
    const hiddenPerson = await insertPerson("Herminia Cuenca Oculta", hidden.id);
    const historicHidden = await createUser({ displayName: "Tío Escondido", profile: { listedInDirectory: false } });
    const historicHiddenPerson = await insertPerson("Tío Escondido Cuenca", historicHidden.id);
    const unlinked = await insertPerson("Abuela Rosa");
    await getTestDb()
      .insert(cuencadaRsvps)
      .values([
        { cuencadaId: edition.id, userId: hidden.id, status: "yes" },
        { cuencadaId: edition.id, userId: member.id, status: "yes" }
      ]);
    await getTestDb()
      .insert(cuencadaAttendance)
      .values([
        { cuencadaId: edition.id, personId: hiddenPerson },
        { cuencadaId: edition.id, personId: historicHiddenPerson },
        { cuencadaId: edition.id, personId: unlinked }
      ]);

    const asOther = await app.inject({ method: "GET", url: "/api/cuencadas/2026/attendees", ...memberAuth });
    expect(asOther.statusCode).toBe(200);
    const others = asOther.json<Attendee[]>();
    // 4 people: the hidden RSVP (deduped with its attendance), the hidden historic one, Rosa, the caller.
    expect(others).toHaveLength(4);
    const anonymous = others.filter((row) => row.displayName === "Familiar");
    expect(anonymous).toHaveLength(2);
    for (const row of anonymous) {
      expect(row).toMatchObject({ personId: null, userId: null, avatarUrl: null, isMe: false });
    }
    expect(others.find((row) => row.displayName === "Abuela Rosa")).toMatchObject({ personId: unlinked });
    for (const leak of [
      hidden.id,
      hiddenPerson,
      historicHidden.id,
      historicHiddenPerson,
      "Herminia",
      "Escondido",
      "herminia.webp"
    ]) {
      expect(asOther.body).not.toContain(leak);
    }

    const asSelf = await app.inject({
      method: "GET",
      url: "/api/cuencadas/2026/attendees",
      ...(await loginAs(app, hidden))
    });
    const self = asSelf.json<Attendee[]>();
    expect(self).toHaveLength(4);
    const mine = self.find((row) => row.isMe);
    expect(mine).toMatchObject({
      personId: hiddenPerson,
      userId: hidden.id,
      displayName: "Herminia Oculta",
      source: "rsvp"
    });
    expect(mine?.avatarUrl).toContain("avatars/herminia.webp");
    expect(self.filter((row) => row.displayName === "Familiar")).toHaveLength(1);
    expect(asSelf.body).not.toContain(historicHiddenPerson);
  });

  it("answers 403 for unverified members, 401 without a token, 400 for a bad year and 404 for drafts", async () => {
    await insertCuencada();
    await insertCuencada({ year: 2027, isPublished: false });
    const unverified = await createUser({ emailVerified: false });
    const res = await app.inject({
      method: "GET",
      url: "/api/cuencadas/2026/attendees",
      ...(await loginAs(app, unverified))
    });
    expect(res.statusCode).toBe(403);
    expect(errorOf(res.body).code).toBe("FORBIDDEN");
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/cuencadas/2026/attendees"
        })
      ).statusCode
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/cuencadas/x/attendees",
          ...memberAuth
        })
      ).statusCode
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/cuencadas/2027/attendees",
          ...memberAuth
        })
      ).statusCode
    ).toBe(404);
  });
});
