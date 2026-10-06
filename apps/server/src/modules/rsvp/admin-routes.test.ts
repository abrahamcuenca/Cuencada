import { randomUUID } from "node:crypto";
import type { AdminRsvpRow, ApiError, AttendanceRecord } from "@cuencada/types";
import { eq } from "drizzle-orm";
import type { InjectOptions } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import { insertCuencada, insertLocation, mutableClock } from "../../../test/helpers/cuencadas.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { type AuthInjectOptions, createUser, loginAs, type TestUser } from "../../../test/helpers/factories.js";
import type { App } from "../../app.js";
import { auditLogs, cuencadaAttendance, cuencadaRsvps, people } from "../../db/schema/index.js";

let app: App;
let admin: TestUser;
let adminAuth: AuthInjectOptions;

beforeEach(async () => {
  app = await createTestApp({ clock: mutableClock("2026-09-01T18:00:00Z") });
  admin = await createUser({ role: "admin", emailVerified: true });
  adminAuth = await loginAs(app, admin);
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

async function audits(action: string): Promise<Array<typeof auditLogs.$inferSelect>> {
  return getTestDb().select().from(auditLogs).where(eq(auditLogs.action, action));
}

describe("admin RSVP/attendance guards", () => {
  it("answers 401 without a token and 403 for members on every admin route", async () => {
    const id = randomUUID();
    const routes: Array<Pick<InjectOptions, "method" | "url" | "payload">> = [
      { method: "GET", url: `/api/admin/cuencadas/${id}/rsvps` },
      { method: "GET", url: `/api/admin/cuencadas/${id}/rsvps.csv` },
      { method: "GET", url: `/api/admin/cuencadas/${id}/attendance` },
      {
        method: "POST",
        url: `/api/admin/cuencadas/${id}/attendance`,
        payload: { add: [id] }
      },
      {
        method: "PUT",
        url: `/api/admin/cuencadas/${id}/attendance`,
        payload: { personIds: [] }
      }
    ];
    const memberAuth = await loginAs(app, await createUser({ emailVerified: true }));
    for (const route of routes) {
      expect((await app.inject(route)).statusCode, `${route.method} ${route.url}`).toBe(401);
      expect((await app.inject({ ...route, ...memberAuth })).statusCode, `${route.method} ${route.url}`).toBe(403);
    }
  });

  it("answers 400 for a bad id and 404 for an unknown edition", async () => {
    for (const path of ["rsvps", "rsvps.csv", "attendance"]) {
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/api/admin/cuencadas/nope/${path}`,
            ...adminAuth
          })
        ).statusCode
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/api/admin/cuencadas/${randomUUID()}/${path}`,
            ...adminAuth
          })
        ).statusCode
      ).toBe(404);
    }
  });
});

describe("GET /api/admin/cuencadas/:id/rsvps", () => {
  it("lists every RSVP with name, email, dates and hotel, drafts included", async () => {
    const edition = await insertCuencada({ isPublished: false });
    const hotel = await insertLocation(edition.id, {
      kind: "hotel",
      name: "Hotel Uno"
    });
    const ana = await createUser({ displayName: "Ana" });
    const personId = await insertPerson("Ana Cuenca", ana.id);
    await getTestDb().insert(cuencadaRsvps).values({
      cuencadaId: edition.id,
      userId: ana.id,
      status: "yes",
      guestCount: 2,
      arrivalDate: "2026-09-12",
      departureDate: "2026-09-19",
      hotelLocationId: hotel.id,
      notes: "Vegetariana"
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/admin/cuencadas/${edition.id}/rsvps`,
      ...adminAuth
    });
    expect(res.statusCode).toBe(200);
    const [row] = res.json<AdminRsvpRow[]>();
    expect(row).toMatchObject({
      userId: ana.id,
      personId,
      displayName: "Ana",
      email: ana.email,
      status: "yes",
      guestCount: 2,
      arrivalDate: "2026-09-12",
      departureDate: "2026-09-19",
      hotelName: "Hotel Uno",
      notes: "Vegetariana"
    });
  });
});

describe("GET /api/admin/cuencadas/:id/rsvps.csv", () => {
  it("exports a BOM-prefixed, injection-safe UTF-8 CSV and audits the row count", async () => {
    const edition = await insertCuencada();
    const evil = await createUser({ displayName: '=HYPERLINK("http://x")' });
    const plain = await createUser({ displayName: "José Ñúñez" });
    await getTestDb()
      .insert(cuencadaRsvps)
      .values([
        {
          cuencadaId: edition.id,
          userId: evil.id,
          status: "yes",
          notes: '@SUM(1+1), "hola"'
        },
        {
          cuencadaId: edition.id,
          userId: plain.id,
          status: "no",
          notes: "-10"
        }
      ]);
    const res = await app.inject({
      method: "GET",
      url: `/api/admin/cuencadas/${edition.id}/rsvps.csv`,
      ...adminAuth
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(res.headers["content-disposition"]).toBe('attachment; filename="cuencada-2026-rsvps.csv"');
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.rawPayload.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));

    const lines = res.body.replace(/^\uFEFF/, "").split("\r\n");
    expect(lines[0]).toBe(
      "userId,personId,displayName,email,status,guestCount,arrivalDate,departureDate,hotelName,notes,updatedAt"
    );
    expect(res.body).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(res.body).toContain(`"'@SUM(1+1), ""hola"""`);
    expect(res.body).toContain(",'-10,");
    expect(res.body).toContain("José Ñúñez");
    expect(lines.filter((line) => line !== "")).toHaveLength(3);

    const [audit] = await audits("rsvp.exported");
    expect(audit).toMatchObject({
      actorUserId: admin.id,
      entityType: "cuencada",
      entityId: edition.id,
      metadata: { rows: 2 }
    });
  });
});

describe("admin RSVP views and unlisted members", () => {
  it("shows unlisted members complete to admins in the table and the CSV", async () => {
    const edition = await insertCuencada();
    const hidden = await createUser({ displayName: "Herminia Oculta", profile: { listedInDirectory: false } });
    const personId = await insertPerson("Herminia Cuenca", hidden.id);
    await getTestDb().insert(cuencadaRsvps).values({ cuencadaId: edition.id, userId: hidden.id, status: "yes" });

    const table = await app.inject({ method: "GET", url: `/api/admin/cuencadas/${edition.id}/rsvps`, ...adminAuth });
    expect(table.json<AdminRsvpRow[]>()).toEqual([
      expect.objectContaining({ userId: hidden.id, personId, displayName: "Herminia Oculta", email: hidden.email })
    ]);

    const csv = await app.inject({ method: "GET", url: `/api/admin/cuencadas/${edition.id}/rsvps.csv`, ...adminAuth });
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain(`${hidden.id},${personId},Herminia Oculta,${hidden.email},yes,`);
  });
});

describe("admin attendance", () => {
  it("adds and removes people with POST, ignoring duplicates, and audits counts only", async () => {
    const edition = await insertCuencada({ year: 2019 });
    const [rosa, juan, luis] = [await insertPerson("Rosa"), await insertPerson("Juan"), await insertPerson("Luis")];
    const url = `/api/admin/cuencadas/${edition.id}/attendance`;

    const first = await app.inject({
      method: "POST",
      url,
      payload: { add: [rosa, juan, rosa] },
      ...adminAuth
    });
    expect(first.statusCode).toBe(200);
    expect(first.json<AttendanceRecord[]>().map((row) => row.displayName)).toEqual(["Juan", "Rosa"]);

    const second = await app.inject({
      method: "POST",
      url,
      payload: { add: [luis, juan], remove: [rosa] },
      ...adminAuth
    });
    expect(second.json<AttendanceRecord[]>().map((row) => row.displayName)).toEqual(["Juan", "Luis"]);

    const list = await app.inject({ method: "GET", url, ...adminAuth });
    expect(list.json<AttendanceRecord[]>()).toEqual([
      {
        personId: juan,
        displayName: "Juan",
        createdAt: "2026-09-01T18:00:00.000Z"
      },
      {
        personId: luis,
        displayName: "Luis",
        createdAt: "2026-09-01T18:00:00.000Z"
      }
    ]);
    expect((await audits("attendance.updated")).map((row) => row.metadata)).toEqual([
      { mode: "patch", added: 2, removed: 0, total: 2 },
      { mode: "patch", added: 1, removed: 1, total: 2 }
    ]);
  });

  it("answers 400 for an empty POST, an overlap and unknown people, writing nothing", async () => {
    const edition = await insertCuencada();
    const rosa = await insertPerson("Rosa");
    const url = `/api/admin/cuencadas/${edition.id}/attendance`;
    expect((await app.inject({ method: "POST", url, payload: {}, ...adminAuth })).statusCode).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          payload: { add: [rosa], remove: [rosa] },
          ...adminAuth
        })
      ).statusCode
    ).toBe(400);
    const unknown = await app.inject({
      method: "POST",
      url,
      payload: { add: [rosa, randomUUID()] },
      ...adminAuth
    });
    expect(unknown.statusCode).toBe(400);
    expect(errorOf(unknown.body).details?.map((detail) => detail.path)).toEqual(["add.1"]);
    expect(await getTestDb().select().from(cuencadaAttendance)).toHaveLength(0);
  });

  it("replaces the whole set with PUT and audits added/removed counts", async () => {
    const edition = await insertCuencada({ year: 2018 });
    const other = await insertCuencada({ year: 2017 });
    const [rosa, juan, luis] = [await insertPerson("Rosa"), await insertPerson("Juan"), await insertPerson("Luis")];
    await getTestDb()
      .insert(cuencadaAttendance)
      .values([
        { cuencadaId: edition.id, personId: rosa },
        { cuencadaId: edition.id, personId: juan },
        { cuencadaId: other.id, personId: rosa }
      ]);
    const url = `/api/admin/cuencadas/${edition.id}/attendance`;

    const replaced = await app.inject({
      method: "PUT",
      url,
      payload: { personIds: [juan, luis] },
      ...adminAuth
    });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json<AttendanceRecord[]>().map((row) => row.personId)).toEqual([juan, luis]);

    const cleared = await app.inject({
      method: "PUT",
      url,
      payload: { personIds: [] },
      ...adminAuth
    });
    expect(cleared.json<AttendanceRecord[]>()).toEqual([]);
    // The other edition is untouched.
    expect(
      await getTestDb().select().from(cuencadaAttendance).where(eq(cuencadaAttendance.cuencadaId, other.id))
    ).toHaveLength(1);

    expect((await audits("attendance.updated")).map((row) => row.metadata)).toEqual([
      { mode: "replace", added: 1, removed: 1, total: 2 },
      { mode: "replace", added: 0, removed: 2, total: 0 }
    ]);
  });

  it("answers 400 for duplicate or unknown ids on PUT and keeps the previous set", async () => {
    const edition = await insertCuencada();
    const rosa = await insertPerson("Rosa");
    await getTestDb().insert(cuencadaAttendance).values({ cuencadaId: edition.id, personId: rosa });
    const url = `/api/admin/cuencadas/${edition.id}/attendance`;
    expect(
      (
        await app.inject({
          method: "PUT",
          url,
          payload: { personIds: [rosa, rosa] },
          ...adminAuth
        })
      ).statusCode
    ).toBe(400);
    const unknown = await app.inject({
      method: "PUT",
      url,
      payload: { personIds: [randomUUID()] },
      ...adminAuth
    });
    expect(unknown.statusCode).toBe(400);
    expect(errorOf(unknown.body).details?.map((detail) => detail.path)).toEqual(["personIds.0"]);
    expect(await getTestDb().select().from(cuencadaAttendance)).toHaveLength(1);
    expect(await audits("attendance.updated")).toHaveLength(0);
  });
});
