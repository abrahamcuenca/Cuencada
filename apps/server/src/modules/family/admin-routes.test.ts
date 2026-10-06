import type { ApiError, Person, Relationship } from "@cuencada/types";
import { eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { type AuthInjectOptions, createUser, loginAs, type TestUser } from "../../../test/helpers/factories.js";
import { insertLineage, insertParentOf, insertPartnerOf, insertPerson } from "../../../test/helpers/family.js";
import type { App } from "../../app.js";
import { auditLogs, people, personRelationships } from "../../db/schema/index.js";

const MISSING_ID = "00000000-0000-4000-8000-000000000000";

let app: App;
let logLines: string[];
let admin: TestUser;
let adminAuth: AuthInjectOptions;
let memberAuth: AuthInjectOptions;

beforeEach(async () => {
  logLines = [];
  app = await createTestApp({ logStream: { write: (line) => logLines.push(line) } });
  admin = await createUser({ role: "admin" });
  adminAuth = await loginAs(app, admin);
  memberAuth = await loginAs(app, await createUser({ emailVerified: true }));
});

afterEach(async () => {
  await app.close();
});

async function auditRows(entityId: string): Promise<(typeof auditLogs.$inferSelect)[]> {
  return getTestDb().select().from(auditLogs).where(eq(auditLogs.entityId, entityId));
}

async function relate(kind: string, fromPersonId: string, toPersonId: string): Promise<{ status: number; body: unknown }> {
  const response = await app.inject({
    method: "POST",
    url: "/api/admin/relationships",
    payload: { kind, fromPersonId, toPersonId },
    ...adminAuth
  });
  return { status: response.statusCode, body: response.json() };
}

describe("admin auth", () => {
  it("answers 401 without a token and 403 for members (even verified) on every admin route", async () => {
    const person = await insertPerson();
    const other = await insertPerson();
    const edge = await insertParentOf(person.id, other.id);
    const routes = [
      { method: "POST" as const, url: "/api/admin/people", payload: { fullName: "X" } },
      { method: "PATCH" as const, url: `/api/admin/people/${person.id}`, payload: { nickname: "x" } },
      { method: "DELETE" as const, url: `/api/admin/people/${person.id}` },
      {
        method: "POST" as const,
        url: "/api/admin/relationships",
        payload: { kind: "partner_of", fromPersonId: person.id, toPersonId: other.id }
      },
      { method: "DELETE" as const, url: `/api/admin/relationships/${edge.id}` }
    ];
    for (const route of routes) {
      expect((await app.inject(route)).statusCode, route.url).toBe(401);
      const forbidden = await app.inject({ ...route, ...memberAuth });
      expect(forbidden.statusCode, route.url).toBe(403);
    }
    expect(await getTestDb().select().from(people)).toHaveLength(2);
    expect(await getTestDb().select().from(personRelationships)).toHaveLength(1);
  });
});

describe("POST /api/admin/people", () => {
  it("creates a person (201), audits ids only and returns every field to the admin", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/people",
      payload: { fullName: "Abuela Rosa", nickname: "Rosi", birthYear: 1940, deathYear: 2019, deceased: true },
      ...adminAuth
    });
    expect(response.statusCode, response.body).toBe(201);
    const person = response.json<Person>();
    expect(person).toMatchObject({ fullName: "Abuela Rosa", nickname: "Rosi", birthYear: 1940, deathYear: 2019, userId: null });

    const [stored] = await getTestDb().select().from(people).where(eq(people.id, person.id));
    expect(stored?.createdByUserId).toBe(admin.id);
    const audits = await auditRows(person.id);
    expect(audits.map((row) => row.action)).toEqual(["person.created"]);
    expect(JSON.stringify(audits)).not.toContain("Rosa");
  });

  it("links an account on create and rejects an unknown or already-linked account", async () => {
    const user = await createUser();
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/people",
      payload: { fullName: "Con Cuenta", userId: user.id },
      ...adminAuth
    });
    expect(created.statusCode).toBe(201);
    const audits = await auditRows(created.json<Person>().id);
    expect(audits.map((row) => row.action).sort()).toEqual(["person.created", "person.user_linked"]);

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/admin/people",
      payload: { fullName: "Otra", userId: user.id },
      ...adminAuth
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json<ApiError>().error.message).toContain("vinculada");

    const unknown = await app.inject({
      method: "POST",
      url: "/api/admin/people",
      payload: { fullName: "Otra", userId: MISSING_ID },
      ...adminAuth
    });
    expect(unknown.statusCode).toBe(400);
  });

  it("answers 400 for invalid input", async () => {
    for (const payload of [
      {},
      { fullName: "" },
      { fullName: "X", birthYear: 2000, deathYear: 1990, deceased: true },
      { fullName: "X", deathYear: 1990 },
      { fullName: "X", birthYear: 1700 }
    ]) {
      const response = await app.inject({ method: "POST", url: "/api/admin/people", payload, ...adminAuth });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(response.json<ApiError>().error.code).toBe("VALIDATION");
    }
  });
});

describe("PATCH /api/admin/people/:id", () => {
  it("updates fields, links and unlinks an account, auditing each step", async () => {
    const person = await insertPerson({ fullName: "Tío Juan" });
    const user = await createUser();

    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/admin/people/${person.id}`,
      payload: { fullName: "Tío Juan Carlos", familyBranch: "Rama Sur" },
      ...adminAuth
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<Person>()).toMatchObject({ fullName: "Tío Juan Carlos", familyBranch: "Rama Sur" });

    const linked = await app.inject({ method: "PATCH", url: `/api/admin/people/${person.id}`, payload: { userId: user.id }, ...adminAuth });
    expect(linked.json<Person>().userId).toBe(user.id);
    // Re-linking the same account to the same person is not a conflict.
    const again = await app.inject({ method: "PATCH", url: `/api/admin/people/${person.id}`, payload: { userId: user.id }, ...adminAuth });
    expect(again.statusCode).toBe(200);
    const unlinked = await app.inject({ method: "PATCH", url: `/api/admin/people/${person.id}`, payload: { userId: null }, ...adminAuth });
    expect(unlinked.json<Person>().userId).toBeNull();

    const audits = await auditRows(person.id);
    expect(audits.map((row) => row.action).sort()).toEqual([
      "person.updated",
      "person.updated",
      "person.updated",
      "person.updated",
      "person.user_linked",
      "person.user_unlinked"
    ]);
    expect(audits.find((row) => row.action === "person.user_linked")?.metadata).toEqual({ userId: user.id });
    expect(JSON.stringify(audits)).not.toContain("Juan");
  });

  it("answers 409 when the account is linked to another person", async () => {
    const user = await createUser();
    await insertPerson({ userId: user.id });
    const other = await insertPerson();
    const response = await app.inject({ method: "PATCH", url: `/api/admin/people/${other.id}`, payload: { userId: user.id }, ...adminAuth });
    expect(response.statusCode).toBe(409);
    expect(response.json<ApiError>().error.code).toBe("CONFLICT");
  });

  it("maps CHECK violations against stored values to 400 with Spanish messages", async () => {
    const person = await insertPerson({ birthYear: 1950 });
    const notDeceased = await app.inject({ method: "PATCH", url: `/api/admin/people/${person.id}`, payload: { deathYear: 2000 }, ...adminAuth });
    expect(notDeceased.statusCode).toBe(400);
    expect(notDeceased.json<ApiError>().error.details?.[0]?.path).toBe("deceased");
    const order = await app.inject({
      method: "PATCH",
      url: `/api/admin/people/${person.id}`,
      payload: { deathYear: 1940, deceased: true },
      ...adminAuth
    });
    expect(order.statusCode).toBe(400);
    expect(order.json<ApiError>().error.message).toContain("fallecimiento");
  });

  it("answers 404 for an unknown person and 400 for an empty body", async () => {
    const missing = await app.inject({ method: "PATCH", url: `/api/admin/people/${MISSING_ID}`, payload: { nickname: "x" }, ...adminAuth });
    expect(missing.statusCode).toBe(404);
    const person = await insertPerson();
    const empty = await app.inject({ method: "PATCH", url: `/api/admin/people/${person.id}`, payload: {}, ...adminAuth });
    expect(empty.statusCode).toBe(400);
  });
});

describe("DELETE /api/admin/people/:id", () => {
  it("deletes an unlinked person and cascades its relationships", async () => {
    const [grandma, mom, kid] = await insertLineage(3);
    if (grandma === undefined || mom === undefined || kid === undefined) throw new Error("fixture");
    const partner = await insertPerson();
    await insertPartnerOf(mom.id, partner.id);

    const response = await app.inject({ method: "DELETE", url: `/api/admin/people/${mom.id}`, ...adminAuth });
    expect(response.statusCode).toBe(204);
    expect(await getTestDb().select().from(people).where(eq(people.id, mom.id))).toEqual([]);
    expect(await getTestDb().select().from(personRelationships)).toEqual([]);
    expect((await auditRows(mom.id)).map((row) => row.action)).toEqual(["person.deleted"]);
  });

  it("answers 409 for a person linked to an account and 404 for an unknown one", async () => {
    const user = await createUser();
    const linked = await insertPerson({ userId: user.id });
    const conflict = await app.inject({ method: "DELETE", url: `/api/admin/people/${linked.id}`, ...adminAuth });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json<ApiError>().error.message).toContain("Desvincúlala");
    expect(await getTestDb().select().from(people).where(eq(people.id, linked.id))).toHaveLength(1);

    const missing = await app.inject({ method: "DELETE", url: `/api/admin/people/${MISSING_ID}`, ...adminAuth });
    expect(missing.statusCode).toBe(404);
  });
});

describe("POST /api/admin/relationships", () => {
  it("creates parent and partner edges (partners stored with from < to) and audits them", async () => {
    const parent = await insertPerson();
    const child = await insertPerson();
    const parentOf = await relate("parent_of", parent.id, child.id);
    expect(parentOf.status).toBe(201);
    expect(parentOf.body).toMatchObject({ kind: "parent_of", fromPersonId: parent.id, toPersonId: child.id });

    const other = await insertPerson();
    // Send the pair in descending order; the server must store it ascending.
    const [high, low] = [other.id, parent.id].sort().reverse();
    if (high === undefined || low === undefined) throw new Error("fixture");
    const partner = await relate("partner_of", high, low);
    expect(partner.status).toBe(201);
    const created = partner.body as Relationship; // response body validated by the route schema
    expect(created.fromPersonId < created.toPersonId).toBe(true);

    const audit = await auditRows(created.id);
    expect(audit[0]).toMatchObject({ action: "relationship.created", entityType: "relationship" });
    expect(audit[0]?.metadata).toEqual({ kind: "partner_of", fromPersonId: created.fromPersonId, toPersonId: created.toPersonId });
  });

  it("rejects a parent_of cycle, including a long one, with 409", async () => {
    const line = await insertLineage(6);
    const top = line[0];
    const bottom = line[5];
    const middle = line[3];
    if (top === undefined || bottom === undefined || middle === undefined) throw new Error("fixture");

    const direct = await relate("parent_of", middle.id, line[2]?.id ?? "");
    expect(direct.status).toBe(409);
    const long = await relate("parent_of", bottom.id, top.id);
    expect(long.status).toBe(409);
    expect((long.body as ApiError).error.message).toContain("ciclo"); // error envelope from the handler
    expect(await getTestDb().select().from(personRelationships)).toHaveLength(5);
  });

  it("lets exactly one of two concurrent opposite parent_of inserts win", async () => {
    for (let round = 0; round < 5; round += 1) {
      const a = await insertPerson();
      const b = await insertPerson();
      const results = await Promise.all([relate("parent_of", a.id, b.id), relate("parent_of", b.id, a.id)]);
      expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
      const edges = await getTestDb()
        .select()
        .from(personRelationships)
        .where(inArray(personRelationships.fromPersonId, [a.id, b.id]));
      expect(edges).toHaveLength(1);
    }
  });

  it("rejects a third parent with 409", async () => {
    const child = await insertPerson();
    const mom = await insertPerson();
    const dad = await insertPerson();
    const third = await insertPerson();
    expect((await relate("parent_of", mom.id, child.id)).status).toBe(201);
    expect((await relate("parent_of", dad.id, child.id)).status).toBe(201);
    const extra = await relate("parent_of", third.id, child.id);
    expect(extra.status).toBe(409);
    expect((extra.body as ApiError).error.message).toContain("dos padres"); // error envelope
  });

  it("rejects duplicates and mirrored partner pairs with 409, self links with 400 and unknown people with 404", async () => {
    const a = await insertPerson();
    const b = await insertPerson();
    expect((await relate("parent_of", a.id, b.id)).status).toBe(201);
    expect((await relate("parent_of", a.id, b.id)).status).toBe(409);
    expect((await relate("partner_of", a.id, b.id)).status).toBe(201);
    expect((await relate("partner_of", b.id, a.id)).status).toBe(409);
    expect((await relate("partner_of", a.id, a.id)).status).toBe(400);
    expect((await relate("parent_of", a.id, a.id.toUpperCase())).status).toBe(400);
    expect((await relate("parent_of", a.id, MISSING_ID)).status).toBe(404);
    expect((await relate("sibling_of", a.id, b.id)).status).toBe(400);
  });
});

describe("DELETE /api/admin/relationships/:id", () => {
  it("deletes an edge (204, audited) and answers 404 for an unknown one", async () => {
    const a = await insertPerson();
    const b = await insertPerson();
    const edge = await insertParentOf(a.id, b.id);
    const response = await app.inject({ method: "DELETE", url: `/api/admin/relationships/${edge.id}`, ...adminAuth });
    expect(response.statusCode).toBe(204);
    expect(await getTestDb().select().from(personRelationships)).toEqual([]);
    expect((await auditRows(edge.id)).map((row) => row.action)).toEqual(["relationship.deleted"]);

    const missing = await app.inject({ method: "DELETE", url: `/api/admin/relationships/${edge.id}`, ...adminAuth });
    expect(missing.statusCode).toBe(404);
  });
});

describe("logging", () => {
  it("never writes people's names to the logs, including on errors and search URLs", async () => {
    const secretName = "Zacarías Quintanilla";
    const user = await createUser();
    const created = await app.inject({
      method: "POST",
      url: "/api/admin/people",
      payload: { fullName: secretName, nickname: "Zaca", userId: user.id },
      ...adminAuth
    });
    expect(created.statusCode).toBe(201);
    const person = created.json<Person>();
    // A conflicting link (DB unique) and a CHECK failure both go through error paths.
    await app.inject({ method: "POST", url: "/api/admin/people", payload: { fullName: secretName, userId: user.id }, ...adminAuth });
    await app.inject({ method: "PATCH", url: `/api/admin/people/${person.id}`, payload: { fullName: secretName, deathYear: 2000 }, ...adminAuth });
    const search = await app.inject({
      method: "GET",
      url: `/api/family/people?q=${encodeURIComponent("Zacarías Quintanilla")}`,
      ...memberAuth
    });
    expect(search.statusCode).toBe(200);
    await app.inject({ method: "DELETE", url: `/api/admin/people/${person.id}`, ...adminAuth });

    expect(logLines.some((line) => line.includes("/api/family/people?q=[REDACTED]"))).toBe(true);
    expect(logLines.length).toBeGreaterThan(0);
    const output = logLines.join("\n");
    expect(output).not.toContain("Zaca");
    expect(output).not.toContain("Quintanilla");
  });
});
