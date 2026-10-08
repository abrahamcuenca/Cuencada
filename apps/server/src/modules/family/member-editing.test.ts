/**
 * WP-4.1 [SEC]: member family editing over the qualifying own-family circle
 * (ADR 0001 §6, Security M1). Fictional people only.
 */
import type { ApiError, PersonDetails } from "@cuencada/types";
import { and, count, eq, or } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { type AuthInjectOptions, createUser, loginAs, type TestUser } from "../../../test/helpers/factories.js";
import { insertLineage, insertParentOf, insertPartnerOf, insertPerson } from "../../../test/helpers/family.js";
import type { App } from "../../app.js";
import { auditLogs, people, personRelationships, personRevisions } from "../../db/schema/index.js";
import { loadFamilyCircle } from "./circle.js";

let app: App;
let member: TestUser;
let memberAuth: AuthInjectOptions;

beforeEach(async () => {
  app = await createTestApp();
  member = await createUser({ emailVerified: true });
  memberAuth = await loginAs(app, member);
});

afterEach(async () => {
  await app.close();
});

type PersonRow = Awaited<ReturnType<typeof insertPerson>>;

/**
 * Self (linked to `member`), parent, grandparent, partner, partner's parent,
 * child; plus a sibling with a child, and an unrelated person.
 */
async function family(): Promise<Record<"self" | "parent" | "grandparent" | "partner" | "inLaw" | "child" | "sibling" | "nephew" | "stranger", PersonRow>> {
  const self = await insertPerson({ fullName: "Ana Morales Vega", userId: member.id, birthYear: 1980 });
  const parent = await insertPerson({ fullName: "Luis Morales Ríos", birthYear: 1950, birthDate: "1950-03-04", birthplace: "Pueblo Norte" });
  const grandparent = await insertPerson({ fullName: "Elsa Ríos Gil", birthYear: 1925, deathYear: 2001, deceased: true, birthplace: "Villa Sur" });
  const partner = await insertPerson({ fullName: "Beto Pérez Sosa", birthYear: 1979 });
  const inLaw = await insertPerson({ fullName: "Marta Sosa Luna", birthYear: 1955 });
  const child = await insertPerson({ fullName: "Inés Pérez Morales", birthYear: 2010 });
  const sibling = await insertPerson({ fullName: "Raúl Morales Vega", birthYear: 1982, birthplace: "Pueblo Norte" });
  const nephew = await insertPerson({ fullName: "Hugo Morales Ortiz", birthYear: 2012 });
  const stranger = await insertPerson({ fullName: "Óscar Ajeno Ruiz", birthYear: 1970, birthDate: "1970-07-07", birthplace: "Ciudad Lejana" });
  await insertParentOf(parent.id, self.id);
  await insertParentOf(grandparent.id, parent.id);
  await insertPartnerOf(self.id, partner.id);
  await insertParentOf(inLaw.id, partner.id);
  await insertParentOf(self.id, child.id);
  await insertParentOf(parent.id, sibling.id);
  await insertParentOf(sibling.id, nephew.id);
  return { self, parent, grandparent, partner, inLaw, child, sibling, nephew, stranger };
}

async function post(payload: unknown, auth: AuthInjectOptions = memberAuth) {
  return app.inject({ method: "POST", url: "/api/family/people", payload: payload as Record<string, unknown>, ...auth });
}

async function patch(id: string, payload: unknown, auth: AuthInjectOptions = memberAuth) {
  return app.inject({ method: "PATCH", url: `/api/family/people/${id}`, payload: payload as Record<string, unknown>, ...auth });
}

async function del(id: string, auth: AuthInjectOptions = memberAuth) {
  return app.inject({ method: "DELETE", url: `/api/family/people/${id}`, ...auth });
}

function issue(body: string): { code: string; detail: string | undefined } {
  const parsed = JSON.parse(body) as ApiError; // test-only: the envelope shape is asserted by the contract tests
  return { code: parsed.error.code, detail: parsed.error.details?.[0]?.code };
}

async function peopleCount(): Promise<number> {
  const [row] = await getTestDb().select({ total: count() }).from(people);
  return row?.total ?? 0;
}

async function edgesOf(id: string) {
  return getTestDb()
    .select()
    .from(personRelationships)
    .where(or(eq(personRelationships.fromPersonId, id), eq(personRelationships.toPersonId, id)));
}

async function revisionsOf(id: string) {
  return getTestDb().select().from(personRevisions).where(eq(personRevisions.personId, id));
}

describe("loadFamilyCircle", () => {
  it("includes self, partners, children and ancestors of self and partners, and nobody else", async () => {
    const f = await family();
    const circle = await loadFamilyCircle(app.db, member.id);
    expect(circle.selfId).toBe(f.self.id);
    expect([...circle.ids].sort()).toEqual([f.self, f.parent, f.grandparent, f.partner, f.inLaw, f.child].map((p) => p.id).sort());
    expect([...circle.close].sort()).toEqual([f.parent, f.partner, f.child].map((p) => p.id).sort());
  });

  it("walks ancestors up to 4 generations only (FAMILY_TREE_MAX_DEPTH)", async () => {
    const line = await insertLineage(7, "Ancestro");
    const self = line[6];
    if (self === undefined) throw new Error("fixture");
    await getTestDb().update(people).set({ userId: member.id }).where(eq(people.id, self.id));
    const circle = await loadFamilyCircle(app.db, member.id);
    expect(circle.ids.has(line[2]?.id ?? "")).toBe(true);
    expect(circle.ids.has(line[1]?.id ?? "")).toBe(false);
  });

  it("is empty for a member who is not in the tree", async () => {
    await family();
    const outsider = await createUser({ emailVerified: true });
    const circle = await loadFamilyCircle(app.db, outsider.id);
    expect(circle.selfId).toBeNull();
    expect(circle.ids.size).toBe(0);
  });

  it("ignores a member-made edge whose creator did not create an endpoint (planted in the DB)", async () => {
    const f = await family();
    // A member edge from the member's parent to a stranger, neither created by the member.
    await getTestDb()
      .insert(personRelationships)
      .values({ kind: "parent_of", fromPersonId: f.stranger.id, toPersonId: f.parent.id, createdByMember: true, createdByUserId: member.id });
    const circle = await loadFamilyCircle(app.db, member.id);
    expect(circle.ids.has(f.stranger.id)).toBe(false);
    // The same edge as an admin edge would count.
    await getTestDb().update(personRelationships).set({ createdByMember: false }).where(eq(personRelationships.fromPersonId, f.stranger.id));
    expect((await loadFamilyCircle(app.db, member.id)).ids.has(f.stranger.id)).toBe(true);
  });

  it("fails closed when the creating account of a member edge is gone", async () => {
    const f = await family();
    const created = await post({ fullName: "Nueva Hija", relateTo: { personId: f.self.id, kind: "child_of" } });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json<PersonDetails>().id;
    expect((await loadFamilyCircle(app.db, member.id)).ids.has(id)).toBe(true);
    await getTestDb().update(personRelationships).set({ createdByUserId: null }).where(eq(personRelationships.toPersonId, id));
    expect((await loadFamilyCircle(app.db, member.id)).ids.has(id)).toBe(false);
  });
});

describe("POST /api/family/people", () => {
  it("creates a child of the member with a member edge, revisions and audit in one transaction", async () => {
    const f = await family();
    const response = await post({
      fullName: "Valeria Pérez Morales",
      birthDate: "2015-06-01",
      birthplace: "Pueblo Norte",
      bio: "Le gusta dibujar.",
      relateTo: { personId: f.self.id, kind: "child_of" }
    });
    expect(response.statusCode, response.body).toBe(201);
    const created = response.json<PersonDetails>();
    expect(created).toMatchObject({
      fullName: "Valeria Pérez Morales",
      birthYear: 2015,
      birthDate: "2015-06-01",
      birthplace: "Pueblo Norte",
      bio: "Le gusta dibujar.",
      canEdit: true,
      canAddRelative: true,
      canDelete: true,
      isLinked: false,
      userId: null
    });
    const [edge] = await edgesOf(created.id);
    expect(edge).toMatchObject({ kind: "parent_of", fromPersonId: f.self.id, toPersonId: created.id, createdByMember: true, createdByUserId: member.id });
    const [row] = await getTestDb().select().from(people).where(eq(people.id, created.id));
    expect(row).toMatchObject({ createdByUserId: member.id, updatedByUserId: member.id });
    const revisions = await revisionsOf(created.id);
    expect(revisions.map((revision) => revision.action).sort()).toEqual(["person.create", "relationship.create"]);
    for (const revision of revisions) {
      expect(revision.actorUserId).toBe(member.id);
      expect(revision.after).toMatchObject({ personId: created.id });
    }
    const audits = await getTestDb().select().from(auditLogs).where(eq(auditLogs.actorUserId, member.id));
    const familyAudits = audits.filter((audit) => audit.action.startsWith("person.") || audit.action.startsWith("relationship."));
    expect(familyAudits.map((audit) => audit.action).sort()).toEqual(["person.created", "relationship.created"]);
    expect(JSON.stringify(audits)).not.toContain("Valeria");
  });

  it("adds a parent, a partner and grandparents through the circle (ancestors of self and partners)", async () => {
    const f = await family();
    const inLawParent = await post({ fullName: "Abuelo Político", deceased: true, relateTo: { personId: f.inLaw.id, kind: "parent_of" } });
    expect(inLawParent.statusCode, inLawParent.body).toBe(201);
    const greatGrand = await post({ fullName: "Bisabuela Ríos", relateTo: { personId: f.grandparent.id, kind: "parent_of" } });
    expect(greatGrand.statusCode, greatGrand.body).toBe(201);
    const secondPartner = await post({ fullName: "Segunda Pareja", relateTo: { personId: f.self.id, kind: "partner_of" } });
    expect(secondPartner.statusCode, secondPartner.body).toBe(201);
  });

  it("refuses a relative of someone outside the circle with 403 FAMILY_NOT_IN_CIRCLE and writes nothing", async () => {
    const f = await family();
    const before = await peopleCount();
    for (const anchor of [f.sibling, f.nephew, f.stranger]) {
      const response = await post({ fullName: "Intrusa", relateTo: { personId: anchor.id, kind: "child_of" } });
      expect(response.statusCode, response.body).toBe(403);
      expect(issue(response.body)).toEqual({ code: "FORBIDDEN", detail: "FAMILY_NOT_IN_CIRCLE" });
    }
    expect(await peopleCount()).toBe(before);
    expect(await getTestDb().select().from(personRevisions)).toHaveLength(0);
  });

  it("answers 400 to userId, unknown keys or an existing-to-existing edge, and there is no member relationship route", async () => {
    const f = await family();
    const before = await peopleCount();
    for (const payload of [
      { fullName: "Con Cuenta", userId: member.id, relateTo: { personId: f.self.id, kind: "child_of" } },
      { fullName: "Sin Relación" },
      { fullName: "Arista", relateTo: { personId: f.self.id, kind: "child_of", fromPersonId: f.stranger.id } },
      { kind: "parent_of", fromPersonId: f.stranger.id, toPersonId: f.self.id },
      { fullName: "Fechas", birthDate: "1990-01-01", birthYear: 1991, relateTo: { personId: f.self.id, kind: "child_of" } }
    ]) {
      const response = await post(payload);
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    for (const method of ["POST", "DELETE"] as const) {
      const response = await app.inject({
        method,
        url: "/api/family/relationships",
        payload: { kind: "parent_of", fromPersonId: f.stranger.id, toPersonId: f.self.id },
        ...memberAuth
      });
      expect(response.statusCode).toBe(404);
    }
    expect(await peopleCount()).toBe(before);
  });

  it("keeps the cycle and two-parent checks (409) and rolls the person back", async () => {
    const f = await family();
    await insertParentOf((await insertPerson({ fullName: "Otra Madre" })).id, f.self.id);
    const before = await peopleCount();
    const third = await post({ fullName: "Tercer Padre", relateTo: { personId: f.self.id, kind: "parent_of" } });
    expect(third.statusCode, third.body).toBe(409);
    expect(await peopleCount()).toBe(before);
  });

  it("cannot reach anybody else's relatives through any sequence of member requests", async () => {
    const f = await family();
    // New parent-in-law, then their new child (a new sibling-in-law), then that person's new partner…
    let last = f.inLaw.id;
    for (const [name, kind] of [
      ["Suegra Nueva", "partner_of"],
      ["Cuñado Nuevo", "child_of"],
      ["Pareja del Cuñado", "partner_of"]
    ] as const) {
      const response = await post({ fullName: name, relateTo: { personId: last, kind } });
      expect(response.statusCode, response.body).toBe(201);
      last = response.json<PersonDetails>().id;
    }
    const circle = await loadFamilyCircle(app.db, member.id);
    for (const outsider of [f.sibling, f.nephew, f.stranger]) {
      expect(circle.ids.has(outsider.id)).toBe(false);
      const edit = await patch(outsider.id, { nickname: "Hackeado" });
      expect(edit.statusCode).toBe(403);
      expect(issue(edit.body).detail).toBe("FAMILY_NOT_IN_CIRCLE");
    }
    const [stranger] = await getTestDb().select({ nickname: people.nickname }).from(people).where(eq(people.id, f.stranger.id));
    expect(stranger?.nickname).toBeNull();
  });
});

describe("PATCH /api/family/people/:id", () => {
  it("edits someone in the circle (merged dates re-checked) and records a revision", async () => {
    const f = await family();
    const response = await patch(f.parent.id, { nickname: "Don Luis", birthplace: "Pueblo Sur", bio: "Carpintero." });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<PersonDetails>()).toMatchObject({ nickname: "Don Luis", birthplace: "Pueblo Sur", birthDate: "1950-03-04" });
    const [revision] = await revisionsOf(f.parent.id);
    expect(revision).toMatchObject({ action: "person.update", actorUserId: member.id });
    expect(revision?.before).toMatchObject({ personId: f.parent.id, nickname: null });
    expect(revision?.after).toMatchObject({ personId: f.parent.id, nickname: "Don Luis" });
    // A new year that contradicts the stored date: 400 (not a DB 500).
    const mismatch = await patch(f.parent.id, { birthYear: 1951 });
    expect(mismatch.statusCode, mismatch.body).toBe(400);
    expect(JSON.parse(mismatch.body).error.details[0].path).toBe("birthYear");
    // Death before the stored birth date.
    const order = await patch(f.parent.id, { deathDate: "1949-01-01" });
    expect(order.statusCode, order.body).toBe(400);
  });

  it("lets the member edit their own node fully", async () => {
    const f = await family();
    const response = await patch(f.self.id, { fullName: "Ana Morales Vega de Pérez", birthDate: "1980-02-02" });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<PersonDetails>()).toMatchObject({ birthYear: 1980, birthDate: "1980-02-02", canEdit: true });
  });

  it("answers 403 PERSON_LINKED_TO_OTHER for a relative with their own account, and FAMILY_NOT_IN_CIRCLE outside", async () => {
    const f = await family();
    const partnerUser = await createUser({ emailVerified: true });
    await getTestDb().update(people).set({ userId: partnerUser.id }).where(eq(people.id, f.partner.id));
    const linked = await patch(f.partner.id, { nickname: "Betito" });
    expect(linked.statusCode).toBe(403);
    expect(issue(linked.body)).toEqual({ code: "FORBIDDEN", detail: "PERSON_LINKED_TO_OTHER" });
    const outside = await patch(f.sibling.id, { nickname: "Rulo" });
    expect(issue(outside.body)).toEqual({ code: "FORBIDDEN", detail: "FAMILY_NOT_IN_CIRCLE" });
    const rows = await getTestDb().select({ nickname: people.nickname }).from(people).where(or(eq(people.id, f.partner.id), eq(people.id, f.sibling.id)));
    expect(rows.every((row) => row.nickname === null)).toBe(true);
  });

  it("answers 400 for userId or unknown keys and 404 for an unknown person", async () => {
    const f = await family();
    expect((await patch(f.parent.id, { userId: member.id })).statusCode).toBe(400);
    expect((await patch(f.parent.id, { nickname: "x", createdByUserId: member.id })).statusCode).toBe(400);
    expect((await patch("00000000-0000-4000-8000-000000000000", { nickname: "x" })).statusCode).toBe(404);
  });
});

describe("DELETE /api/family/people/:id", () => {
  it("deletes the member's own unlinked addition and its edge in one transaction, with revisions", async () => {
    const f = await family();
    const created = (await post({ fullName: "Error de Captura", relateTo: { personId: f.self.id, kind: "child_of" } })).json<PersonDetails>();
    const response = await del(created.id);
    expect(response.statusCode, response.body).toBe(204);
    expect(await getTestDb().select().from(people).where(eq(people.id, created.id))).toHaveLength(0);
    expect(await edgesOf(created.id)).toHaveLength(0);
    const revisions = await getTestDb()
      .select({ action: personRevisions.action, before: personRevisions.before })
      .from(personRevisions)
      .where(and(eq(personRevisions.actorUserId, member.id)));
    expect(revisions.map((revision) => revision.action).sort()).toEqual([
      "person.create",
      "person.delete",
      "relationship.create",
      "relationship.delete"
    ]);
  });

  it("answers 403 NOT_CREATOR for another member's addition and for admin-made people", async () => {
    const f = await family();
    const other = await createUser({ emailVerified: true });
    const otherAuth = await loginAs(app, other);
    await getTestDb().update(people).set({ userId: other.id }).where(eq(people.id, f.partner.id));
    const theirs = (await post({ fullName: "Hija de Beto", relateTo: { personId: f.partner.id, kind: "child_of" } }, otherAuth)).json<PersonDetails>();
    for (const id of [theirs.id, f.parent.id]) {
      const response = await del(id);
      expect(response.statusCode).toBe(403);
      expect(issue(response.body)).toEqual({ code: "FORBIDDEN", detail: "NOT_CREATOR" });
    }
    expect(await getTestDb().select().from(people).where(eq(people.id, theirs.id))).toHaveLength(1);
  });

  it("answers 409 PERSON_HAS_RELATIONSHIPS when the addition has other edges", async () => {
    const f = await family();
    const created = (await post({ fullName: "Nuevo Hijo", relateTo: { personId: f.self.id, kind: "child_of" } })).json<PersonDetails>();
    // A later addition hanging from it (made with the grandchild, not with it).
    const grandchild = await post({ fullName: "Nieto Nuevo", relateTo: { personId: created.id, kind: "child_of" } });
    expect(grandchild.statusCode, grandchild.body).toBe(201);
    const blocked = await del(created.id);
    expect(blocked.statusCode).toBe(409);
    expect(issue(blocked.body)).toEqual({ code: "CONFLICT", detail: "PERSON_HAS_RELATIONSHIPS" });
    // An admin edge also blocks.
    const other = (await post({ fullName: "Otro Hijo", relateTo: { personId: f.self.id, kind: "child_of" } })).json<PersonDetails>();
    await insertParentOf(f.partner.id, other.id);
    expect(issue((await del(other.id)).body).detail).toBe("PERSON_HAS_RELATIONSHIPS");
    expect(await edgesOf(other.id)).toHaveLength(2);
  });

  it("answers 403 PERSON_LINKED_TO_OTHER when an admin linked the addition to an account", async () => {
    const f = await family();
    const created = (await post({ fullName: "Hijo con Cuenta", relateTo: { personId: f.self.id, kind: "child_of" } })).json<PersonDetails>();
    const kid = await createUser({ emailVerified: true });
    await getTestDb().update(people).set({ userId: kid.id }).where(eq(people.id, created.id));
    expect(issue((await del(created.id)).body).detail).toBe("PERSON_LINKED_TO_OTHER");
  });
});

describe("GET /api/family/people/:id (PersonDetails privacy, WP-4.1)", () => {
  it("shows living people's dates and birthplace to the circle, self and admins only", async () => {
    const f = await family();
    const get = async (id: string, auth: AuthInjectOptions = memberAuth): Promise<PersonDetails> => {
      const response = await app.inject({ method: "GET", url: `/api/family/people/${id}`, ...auth });
      expect(response.statusCode, response.body).toBe(200);
      return response.json<PersonDetails>();
    };
    expect(await get(f.parent.id)).toMatchObject({ birthYear: 1950, birthDate: "1950-03-04", birthplace: "Pueblo Norte", canEdit: true });
    expect(await get(f.stranger.id)).toMatchObject({ birthYear: null, birthDate: null, birthplace: null, canEdit: false, canAddRelative: false });
    expect(await get(f.sibling.id)).toMatchObject({ birthYear: null, birthplace: null });
    // Deceased: shown to every verified member.
    const outsider = await createUser({ emailVerified: true });
    const outsiderAuth = await loginAs(app, outsider);
    expect(await get(f.grandparent.id, outsiderAuth)).toMatchObject({ birthYear: 1925, deathYear: 2001, birthplace: "Villa Sur" });
    expect(await get(f.parent.id, outsiderAuth)).toMatchObject({ birthYear: null, birthDate: null, birthplace: null, canEdit: false });
    const admin = await createUser({ role: "admin", emailVerified: true });
    expect(await get(f.stranger.id, await loginAs(app, admin))).toMatchObject({
      birthDate: "1970-07-07",
      birthplace: "Ciudad Lejana",
      canEdit: true,
      canDelete: false
    });
    // The tree focus follows the same rule.
    const tree = await app.inject({ method: "GET", url: `/api/family/tree?personId=${f.parent.id}`, ...memberAuth });
    expect(tree.json<{ focus: PersonDetails }>().focus).toMatchObject({ birthDate: "1950-03-04", birthplace: "Pueblo Norte" });
    const treeOut = await app.inject({ method: "GET", url: `/api/family/tree?personId=${f.parent.id}`, ...outsiderAuth });
    expect(treeOut.json<{ focus: PersonDetails }>().focus).toMatchObject({ birthDate: null, birthplace: null, birthYear: null });
  });

  it("flags close relatives as photo editors and keeps canEdit off for a relative linked to another account", async () => {
    const f = await family();
    const partnerUser = await createUser({ emailVerified: true });
    await getTestDb().update(people).set({ userId: partnerUser.id }).where(eq(people.id, f.partner.id));
    const partner = (await app.inject({ method: "GET", url: `/api/family/people/${f.partner.id}`, ...memberAuth })).json<PersonDetails>();
    // WP-4.3: close relatives change the photo of people without an account only; a linked person's photo is theirs.
    expect(partner).toMatchObject({ canEdit: false, canEditPhoto: false, canAddRelative: true, isLinked: true });
    const child = (await app.inject({ method: "GET", url: `/api/family/people/${f.child.id}`, ...memberAuth })).json<PersonDetails>();
    expect(child).toMatchObject({ canEditPhoto: true });
    const grand = (await app.inject({ method: "GET", url: `/api/family/people/${f.grandparent.id}`, ...memberAuth })).json<PersonDetails>();
    expect(grand).toMatchObject({ canEdit: true, canEditPhoto: false });
  });
});

describe("own additions that get an account (PR #46 L1)", () => {
  it("leave the creator's circle (no living dates, no edit) and stop the own-additions walk", async () => {
    const f = await family();
    const sister = (
      await post({ fullName: "Hermana Nueva", birthDate: "1984-04-04", birthplace: "Pueblo Norte", relateTo: { personId: f.parent.id, kind: "child_of" } })
    ).json<PersonDetails>();
    const niece = (await post({ fullName: "Sobrina Nueva", relateTo: { personId: sister.id, kind: "child_of" } })).json<PersonDetails>();
    let circle = await loadFamilyCircle(app.db, member.id);
    expect(circle.ids.has(sister.id) && circle.ids.has(niece.id)).toBe(true);

    const sisterUser = await createUser({ emailVerified: true });
    await getTestDb().update(people).set({ userId: sisterUser.id }).where(eq(people.id, sister.id));
    circle = await loadFamilyCircle(app.db, member.id);
    expect(circle.ids.has(sister.id)).toBe(false);
    expect(circle.ids.has(niece.id)).toBe(false);

    const read = (await app.inject({ method: "GET", url: `/api/family/people/${sister.id}`, ...memberAuth })).json<PersonDetails>();
    expect(read).toMatchObject({ birthDate: null, birthYear: null, birthplace: null, canEdit: false, canAddRelative: false });
    const edit = await patch(sister.id, { nickname: "Hermanita" });
    expect(edit.statusCode).toBe(403);
    const nieceEdit = await patch(niece.id, { nickname: "Sobri" });
    expect(issue(nieceEdit.body)).toEqual({ code: "FORBIDDEN", detail: "FAMILY_NOT_IN_CIRCLE" });
    const [row] = await getTestDb().select({ nickname: people.nickname }).from(people).where(eq(people.id, niece.id));
    expect(row?.nickname).toBeNull();
  });

  it("keep the creator's own child in the circle through the normal rules (qualifying member edge)", async () => {
    const f = await family();
    const child = (await post({ fullName: "Hijo Nuevo", birthDate: "2015-05-05", relateTo: { personId: f.self.id, kind: "child_of" } })).json<PersonDetails>();
    const childUser = await createUser({ emailVerified: true });
    await getTestDb().update(people).set({ userId: childUser.id }).where(eq(people.id, child.id));
    expect((await loadFamilyCircle(app.db, member.id)).ids.has(child.id)).toBe(true);
    const read = (await app.inject({ method: "GET", url: `/api/family/people/${child.id}`, ...memberAuth })).json<PersonDetails>();
    // Dates visible (circle), but not editable: the child has their own account.
    expect(read).toMatchObject({ birthDate: "2015-05-05", canEdit: false });
  });
});

describe("death data on the member's own linked node (PR #46 L2)", () => {
  it("answers 403 ADMIN_ONLY_FIELD for deceased, deathYear or deathDate and changes nothing", async () => {
    const f = await family();
    for (const payload of [{ deceased: true }, { deathYear: 2030 }, { deathDate: "2030-01-01" }, { nickname: "x", deathYear: 2030, deceased: true }]) {
      const response = await patch(f.self.id, payload);
      expect(response.statusCode, JSON.stringify(payload)).toBe(403);
      expect(issue(response.body)).toEqual({ code: "FORBIDDEN", detail: "ADMIN_ONLY_FIELD" });
    }
    const [row] = await getTestDb().select().from(people).where(eq(people.id, f.self.id));
    expect(row).toMatchObject({ deceased: false, deathYear: null, nickname: null });
    expect(await revisionsOf(f.self.id)).toHaveLength(0);
  });

  it("lets the member change name, nickname, branch, birth date/year, birthplace and bio of their own node", async () => {
    const f = await family();
    const response = await patch(f.self.id, {
      fullName: "Ana Morales Vega de Pérez",
      nickname: "Anita",
      familyBranch: "Rama Norte",
      birthDate: "1980-02-02",
      birthplace: "Pueblo Norte",
      bio: "Maestra."
    });
    expect(response.statusCode, response.body).toBe(200);
  });

  it("still lets a member record the death of an unlinked relative in their circle", async () => {
    const f = await family();
    const response = await patch(f.parent.id, { deathYear: 2020 });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<PersonDetails>()).toMatchObject({ deceased: true, deathYear: 2020 });
  });

  it("aligns PATCH /api/family/me: the same fields are accepted, death data is stripped", async () => {
    const f = await family();
    const response = await app.inject({
      method: "PATCH",
      url: "/api/family/me",
      payload: { fullName: "Ana M. Vega", birthDate: "1980-03-03", birthplace: "Villa Sur", bio: "Hola.", deceased: true, deathYear: 2030 },
      ...memberAuth
    });
    expect(response.statusCode, response.body).toBe(200);
    const [row] = await getTestDb().select().from(people).where(eq(people.id, f.self.id));
    expect(row).toMatchObject({ fullName: "Ana M. Vega", birthYear: 1980, birthDate: "1980-03-03", birthplace: "Villa Sur", bio: "Hola.", deceased: false, deathYear: null });
  });
});

describe("rate limit", () => {
  it("allows 60 member family writes per hour per user, then answers 429", async () => {
    await insertPerson({ userId: member.id, fullName: "Ana Morales Vega" });
    for (let index = 0; index < 60; index += 1) {
      const response = await app.inject({ method: "PATCH", url: "/api/family/me", payload: { nickname: `N${index}` }, ...memberAuth });
      expect(response.statusCode, response.body).toBe(200);
    }
    const limited = await app.inject({ method: "PATCH", url: "/api/family/me", payload: { nickname: "Tope" }, ...memberAuth });
    expect(limited.statusCode).toBe(429);
    const create = await post({ fullName: "Tarde", relateTo: { personId: "00000000-0000-4000-8000-000000000001", kind: "child_of" } });
    expect(create.statusCode).toBe(429);
  });
});

describe("PATCH /api/family/me (merged dates)", () => {
  it("answers 400 on birthYear when it contradicts the stored birth date", async () => {
    await insertPerson({ userId: member.id, fullName: "Ana Morales Vega", birthYear: 1980, birthDate: "1980-01-01" });
    const response = await app.inject({ method: "PATCH", url: "/api/family/me", payload: { birthYear: 1981 }, ...memberAuth });
    expect(response.statusCode, response.body).toBe(400);
    expect(JSON.parse(response.body).error.details[0].path).toBe("birthYear");
  });
});
