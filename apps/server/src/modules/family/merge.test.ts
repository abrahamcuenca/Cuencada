/**
 * WP-4.5 [SEC]: "Fusionar personas" (merge, preview, undo) and "Posibles
 * duplicados". Fictional people only.
 */
import type { Page, PersonMergePreview, PersonMergeResponse, PersonRevision, PossibleDuplicate } from "@cuencada/types";
import { eq, inArray, or, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import { insertCuencada } from "../../../test/helpers/cuencadas.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { type AuthInjectOptions, createUser, loginAs, type TestUser } from "../../../test/helpers/factories.js";
import { FakeStorage } from "../../../test/helpers/fakes.js";
import { insertParentOf, insertPartnerOf, insertPerson } from "../../../test/helpers/family.js";
import type { App } from "../../app.js";
import {
  auditLogs,
  cuencadaAttendance,
  invites,
  people,
  personPhotoUploads,
  personRelationships,
  personRevisions
} from "../../db/schema/index.js";

let app: App;
let storage: FakeStorage;
let admin: TestUser;
let adminAuth: AuthInjectOptions;
let member: TestUser;
let memberAuth: AuthInjectOptions;

beforeEach(async () => {
  storage = new FakeStorage();
  app = await createTestApp({ storage });
  admin = await createUser({ role: "admin", emailVerified: true, displayName: "Octavio Admin" });
  adminAuth = await loginAs(app, admin);
  member = await createUser({ emailVerified: true, displayName: "Lucía Ejemplo" });
  memberAuth = await loginAs(app, member);
});

afterEach(async () => {
  await app.close();
});

async function call(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown, auth: AuthInjectOptions = adminAuth) {
  return app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }), ...auth });
}

const merge = (keepId: string, body: Record<string, unknown>, auth?: AuthInjectOptions) =>
  call("POST", `/api/admin/people/${keepId}/merge`, body, auth);
const preview = (keepId: string, duplicateId: string, auth?: AuthInjectOptions) =>
  call("GET", `/api/admin/people/${keepId}/merge-preview?duplicateId=${duplicateId}`, undefined, auth);

async function personRow(id: string) {
  const [row] = await getTestDb().select().from(people).where(eq(people.id, id));
  return row;
}

async function edgesOf(id: string) {
  return getTestDb()
    .select()
    .from(personRelationships)
    .where(or(eq(personRelationships.fromPersonId, id), eq(personRelationships.toPersonId, id)))
    .orderBy(personRelationships.id);
}

/** The whole family state a refused merge must leave untouched. */
async function treeState() {
  const db = getTestDb();
  return {
    people: await db.select().from(people).orderBy(people.id),
    edges: await db.select().from(personRelationships).orderBy(personRelationships.id),
    invites: await db.select({ id: invites.id, personId: invites.personId, status: invites.status }).from(invites).orderBy(invites.id),
    revisions: await db.select({ id: personRevisions.id }).from(personRevisions).orderBy(personRevisions.id)
  };
}

function errorOf(body: string): { code: string; message: string; details?: Array<{ path: string; code?: string; message: string }> } {
  return (JSON.parse(body) as { error: { code: string; message: string; details?: Array<{ path: string; code?: string; message: string }> } }).error; // API error envelope
}

/**
 * The invite race: an admin's tree person "Lucía Ejemplo" with parents and
 * a partner (one edge made by a member), and the person an open invite
 * created for the member's account, with a partner of its own.
 */
async function raceFixture() {
  const mother = await insertPerson({ fullName: "Rosa Ejemplo Vega", deceased: true, deathYear: 2010 });
  const father = await insertPerson({ fullName: "Mario Ejemplo" });
  const tree = await insertPerson({ fullName: "Lucía Ejemplo", birthYear: 1990, familyBranch: "Rama Norte", createdByUserId: admin.id });
  await insertParentOf(mother.id, tree.id);
  await insertParentOf(father.id, tree.id);
  const invited = await insertPerson({
    fullName: "Lucía Ejemplo Pérez",
    userId: member.id,
    createdByUserId: member.id,
    nickname: "Lu",
    birthplace: "Villa Sur",
    birthYear: 1990,
    birthDate: "1990-05-02"
  });
  const partner = await insertPerson({ fullName: "Tomás Muestra", createdByUserId: member.id });
  const [memberEdge] = await getTestDb()
    .insert(personRelationships)
    .values({ kind: "partner_of", fromPersonId: invited.id < partner.id ? invited.id : partner.id, toPersonId: invited.id < partner.id ? partner.id : invited.id, createdByUserId: member.id, createdByMember: true })
    .returning();
  if (memberEdge === undefined) throw new Error("fixture");
  // The duplicate also has the same mother (an exact duplicate edge once moved).
  const sameMother = await insertParentOf(mother.id, invited.id);
  return { mother, father, tree, invited, partner, memberEdge, sameMother };
}

describe("POST /api/admin/people/:id/merge", () => {
  it("merges the invite-created person into the tree person: link moves, blanks filled, edges moved with provenance, duplicate removed", async () => {
    const f = await raceFixture();
    const edition = await insertCuencada({ year: 2101 });
    const otherEdition = await insertCuencada({ year: 2102 });
    await getTestDb().insert(cuencadaAttendance).values([
      { cuencadaId: edition.id, personId: f.tree.id },
      { cuencadaId: edition.id, personId: f.invited.id },
      { cuencadaId: otherEdition.id, personId: f.invited.id }
    ]);

    const response = await merge(f.tree.id, { duplicateId: f.invited.id });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<PersonMergeResponse>();
    expect(body).toMatchObject({ revertible: true, person: { id: f.tree.id, userId: member.id, fullName: "Lucía Ejemplo", nickname: "Lu" } });

    // The kept person: own values, blanks filled from the duplicate (the date falls in the kept year).
    expect(await personRow(f.tree.id)).toMatchObject({
      userId: member.id,
      fullName: "Lucía Ejemplo",
      nickname: "Lu",
      familyBranch: "Rama Norte",
      birthplace: "Villa Sur",
      birthYear: 1990,
      birthDate: "1990-05-02",
      updatedByUserId: admin.id
    });
    expect(await personRow(f.invited.id)).toBeUndefined();

    // Edges: both parents, and the partner edge re-pointed with the same id, creator and member flag.
    const edges = await edgesOf(f.tree.id);
    expect(edges).toHaveLength(3);
    const partnerEdge = edges.find((edge) => edge.kind === "partner_of");
    expect(partnerEdge).toMatchObject({ id: f.memberEdge.id, createdByMember: true, createdByUserId: member.id });
    expect([partnerEdge?.fromPersonId, partnerEdge?.toPersonId].sort()).toEqual([f.tree.id, f.partner.id].sort());
    // The duplicate mother edge was dropped, not doubled.
    expect(edges.filter((edge) => edge.fromPersonId === f.mother.id)).toHaveLength(1);

    // Attendance: moved where the kept person did not attend, dropped where it did.
    const attendance = await getTestDb().select().from(cuencadaAttendance).where(eq(cuencadaAttendance.personId, f.tree.id));
    expect(attendance.map((row) => row.cuencadaId).sort()).toEqual([edition.id, otherEdition.id].sort());

    // One person.merge revision with both snapshots (no emails, keys or contacts); audit with ids and counts only.
    const [revision] = await getTestDb().select().from(personRevisions).where(eq(personRevisions.id, body.revisionId));
    expect(revision).toMatchObject({ action: "person.merge", personId: f.tree.id, actorUserId: admin.id });
    expect(revision?.before).toMatchObject({
      type: "merge",
      personId: f.tree.id,
      duplicatePersonId: f.invited.id,
      keep: { id: f.tree.id, userId: null, nickname: null },
      duplicate: { id: f.invited.id, userId: member.id, nickname: "Lu" },
      duplicateCreatedByUserId: member.id
    });
    expect(revision?.after).toMatchObject({ type: "person", personId: f.tree.id, userId: member.id, nickname: "Lu" });
    expect(JSON.stringify(revision)).not.toMatch(/@|photoKey|objectKey|people\//);
    const [audit] = await getTestDb().select().from(auditLogs).where(eq(auditLogs.action, "person.merged"));
    expect(audit).toMatchObject({ entityId: f.tree.id, metadata: { duplicatePersonId: f.invited.id, linkMoved: true, relationshipsMoved: 1, relationshipsDropped: 1 } });
    expect(JSON.stringify(audit)).not.toMatch(/Lucía|Villa Sur|Lu"/);
    const linked = await getTestDb().select().from(auditLogs).where(inArray(auditLogs.action, ["person.user_linked", "person.user_unlinked"]));
    expect(linked.map((row) => [row.action, row.entityId]).sort()).toEqual(
      [
        ["person.user_linked", f.tree.id],
        ["person.user_unlinked", f.invited.id]
      ].sort()
    );

    // The member now sees themself on the tree person.
    const me = await app.inject({ method: "GET", url: "/api/family/tree", ...memberAuth });
    expect(me.statusCode, me.body).toBe(200);
    expect(me.body).toContain(f.tree.id);
  });

  it("applies per-field choices and refuses merged dates that break a rule (400, nothing changes)", async () => {
    const keep = await insertPerson({ fullName: "Ana Morales", birthYear: 1950 });
    const duplicate = await insertPerson({ fullName: "Ana Morales Vega", birthYear: 1951, birthDate: "1951-02-03", nickname: "Anita" });
    const before = await treeState();
    const bad = await merge(keep.id, { duplicateId: duplicate.id, fields: { birthDate: "duplicate" } });
    expect(bad.statusCode, bad.body).toBe(400);
    expect(errorOf(bad.body).details?.[0]?.path).toBe("birthYear");
    expect(await treeState()).toEqual(before);
    const ok = await merge(keep.id, { duplicateId: duplicate.id, fields: { fullName: "duplicate", birthYear: "duplicate", birthDate: "duplicate", nickname: "keep" } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await personRow(keep.id)).toMatchObject({ fullName: "Ana Morales Vega", birthYear: 1951, birthDate: "1951-02-03", nickname: null });
  });

  it("keeps an explicitly chosen blank", async () => {
    const keep = await insertPerson({ fullName: "Ana Morales" });
    const duplicate = await insertPerson({ fullName: "Ana Morales", bio: "Maestra." });
    expect((await merge(keep.id, { duplicateId: duplicate.id, fields: { bio: "keep" } })).statusCode).toBe(200);
    expect((await personRow(keep.id))?.bio).toBeNull();
  });

  it("refuses two linked people (409 MERGE_BOTH_LINKED) and changes nothing", async () => {
    const other = await createUser({ emailVerified: true });
    const keep = await insertPerson({ fullName: "Beto Ejemplo", userId: other.id });
    const duplicate = await insertPerson({ fullName: "Beto Ejemplo", userId: member.id });
    const before = await treeState();
    const response = await merge(keep.id, { duplicateId: duplicate.id });
    expect(response.statusCode, response.body).toBe(409);
    expect(errorOf(response.body)).toMatchObject({ code: "CONFLICT", details: [{ code: "MERGE_BOTH_LINKED" }] });
    expect(await treeState()).toEqual(before);
    // Keep linked, duplicate not: fine, the link stays.
    const plain = await insertPerson({ fullName: "Beto Ejemplo" });
    expect((await merge(keep.id, { duplicateId: plain.id })).statusCode).toBe(200);
    expect((await personRow(keep.id))?.userId).toBe(other.id);
  });

  it("refuses a merge that would create a cycle or a third parent (409 MERGE_CONFLICT listing the edges)", async () => {
    // Cycle: the duplicate is the parent of the kept person's mother.
    const keep = await insertPerson({ fullName: "Carla Ejemplo" });
    const mother = await insertPerson({ fullName: "Madre Ejemplo" });
    await insertParentOf(mother.id, keep.id);
    const duplicate = await insertPerson({ fullName: "Carla Ejemplo" });
    const cycleEdge = await insertParentOf(duplicate.id, mother.id);
    const before = await treeState();
    const cycle = await merge(keep.id, { duplicateId: duplicate.id });
    expect(cycle.statusCode, cycle.body).toBe(409);
    expect(errorOf(cycle.body)).toMatchObject({ code: "CONFLICT", details: [{ path: `relationships.${cycleEdge.id}`, code: "MERGE_CONFLICT" }] });
    expect(errorOf(cycle.body).details?.[0]?.message).toContain("ciclo");
    expect(await treeState()).toEqual(before);

    // Third parent: two parents each, one shared.
    const p1 = await insertPerson();
    const p2 = await insertPerson();
    const p3 = await insertPerson();
    const a = await insertPerson({ fullName: "Darío Ejemplo" });
    const b = await insertPerson({ fullName: "Darío Ejemplo" });
    await insertParentOf(p1.id, a.id);
    await insertParentOf(p2.id, a.id);
    await insertParentOf(p1.id, b.id);
    const third = await insertParentOf(p3.id, b.id);
    const parents = await merge(a.id, { duplicateId: b.id });
    expect(parents.statusCode, parents.body).toBe(409);
    expect(errorOf(parents.body).details).toEqual([
      expect.objectContaining({ path: `relationships.${third.id}`, code: "MERGE_CONFLICT", message: expect.stringContaining("más de dos padres") as string })
    ]);
    expect(await personRow(b.id)).toBeDefined();
  });

  it("drops a link between the two people (no self-edge) and moves children", async () => {
    const keep = await insertPerson({ fullName: "Elena Ejemplo" });
    const duplicate = await insertPerson({ fullName: "Elena Ejemplo" });
    const child = await insertPerson();
    await insertPartnerOf(keep.id, duplicate.id);
    const childEdge = await insertParentOf(duplicate.id, child.id);
    expect((await merge(keep.id, { duplicateId: duplicate.id })).statusCode).toBe(200);
    const edges = await edgesOf(keep.id);
    expect(edges.map((edge) => [edge.id, edge.kind, edge.fromPersonId, edge.toPersonId])).toEqual([[childEdge.id, "parent_of", keep.id, child.id]]);
  });

  it("serializes opposite merges of the same pair under the tree lock: one wins, the other gets 404", async () => {
    for (let round = 0; round < 4; round += 1) {
      const a = await insertPerson({ fullName: "Quique Ejemplo" });
      const b = await insertPerson({ fullName: "Quique Ejemplo" });
      await insertParentOf((await insertPerson()).id, a.id);
      const [first, second] = await Promise.all([merge(a.id, { duplicateId: b.id }), merge(b.id, { duplicateId: a.id })]);
      expect([first.statusCode, second.statusCode].sort()).toEqual([200, 404]);
      const left = await getTestDb().select({ id: people.id }).from(people).where(inArray(people.id, [a.id, b.id]));
      expect(left).toHaveLength(1);
    }
  });

  it("answers 400 for the same person, 404 for unknown people, 400 for unknown body keys", async () => {
    const keep = await insertPerson();
    expect((await merge(keep.id, { duplicateId: keep.id })).statusCode).toBe(400);
    expect((await merge(keep.id, { duplicateId: "00000000-0000-4000-8000-000000000001" })).statusCode).toBe(404);
    expect((await merge("00000000-0000-4000-8000-000000000001", { duplicateId: keep.id })).statusCode).toBe(404);
    const other = await insertPerson();
    expect((await merge(keep.id, { duplicateId: other.id, userId: member.id })).statusCode).toBe(400);
    expect((await merge(keep.id, { duplicateId: other.id, fields: { userId: "duplicate" } })).statusCode).toBe(400);
  });

  it("moves the duplicate's photo when the kept person has none; deletes the losing objects when both have one", async () => {
    const keep = await insertPerson({ fullName: "Fede Ejemplo" });
    const duplicate = await insertPerson({ fullName: "Fede Ejemplo" });
    const taken = new Date("2026-01-02T03:04:05.000Z");
    await getTestDb().update(people).set({ photoKey: `people/${duplicate.id}/a-256.webp`, photoUpdatedAt: taken }).where(eq(people.id, duplicate.id));
    await getTestDb()
      .insert(personPhotoUploads)
      .values({ personId: duplicate.id, objectKey: `people/${duplicate.id}/pendiente.jpg`, mimeType: "image/jpeg", byteSize: 1, expiresAt: new Date(Date.now() + 60_000) });
    expect((await merge(keep.id, { duplicateId: duplicate.id })).statusCode).toBe(200);
    expect(await personRow(keep.id)).toMatchObject({ photoKey: `people/${duplicate.id}/a-256.webp`, photoUpdatedAt: taken });
    expect(await getTestDb().select({ personId: personPhotoUploads.personId }).from(personPhotoUploads)).toEqual([{ personId: keep.id }]);

    const both = await insertPerson({ fullName: "Fede Ejemplo" });
    const base = `people/${both.id}/b`;
    for (const size of [512, 256, 64]) await storage.put({ key: `${base}-${size}.webp`, body: new Uint8Array([1]), contentType: "image/webp" });
    await storage.put({ key: `people/${duplicate.id}/a-256.webp`, body: new Uint8Array([1]), contentType: "image/webp" });
    await getTestDb().update(people).set({ photoKey: `${base}-256.webp`, photoUpdatedAt: new Date() }).where(eq(people.id, both.id));
    expect((await merge(keep.id, { duplicateId: both.id })).statusCode).toBe(200);
    expect((await personRow(keep.id))?.photoKey).toBe(`people/${duplicate.id}/a-256.webp`);
    expect([...storage.objects.keys()]).toEqual([`people/${duplicate.id}/a-256.webp`]);
  });

  it("moves a pending invite to an unlinked kept person, revokes it when the kept person is linked, keeps history invites", async () => {
    const expiresAt = new Date(Date.now() + 86_400_000);
    const keep = await insertPerson({ fullName: "Gloria Ejemplo" });
    const duplicate = await insertPerson({ fullName: "Gloria Ejemplo" });
    const [pending] = await getTestDb()
      .insert(invites)
      .values({ tokenHash: "w45-hash-1", email: "gloria@example.test", personId: duplicate.id, expiresAt })
      .returning({ id: invites.id });
    const [accepted] = await getTestDb()
      .insert(invites)
      .values({ tokenHash: "w45-hash-2", email: "otra@example.test", personId: duplicate.id, expiresAt, status: "accepted", useCount: 1 })
      .returning({ id: invites.id });
    expect((await merge(keep.id, { duplicateId: duplicate.id })).statusCode).toBe(200);
    const rows = await getTestDb().select({ id: invites.id, personId: invites.personId, status: invites.status }).from(invites).orderBy(invites.tokenHash);
    expect(rows).toEqual([
      { id: pending?.id, personId: keep.id, status: "pending" },
      { id: accepted?.id, personId: keep.id, status: "accepted" }
    ]);

    const linkedKeep = await insertPerson({ fullName: "Hugo Ejemplo", userId: member.id });
    const dup2 = await insertPerson({ fullName: "Hugo Ejemplo" });
    const [pending2] = await getTestDb()
      .insert(invites)
      .values({ tokenHash: "w45-hash-3", email: "hugo@example.test", personId: dup2.id, expiresAt })
      .returning({ id: invites.id });
    expect((await merge(linkedKeep.id, { duplicateId: dup2.id })).statusCode).toBe(200);
    const [revoked] = await getTestDb().select().from(invites).where(eq(invites.id, pending2?.id ?? ""));
    expect(revoked).toMatchObject({ status: "revoked", personId: linkedKeep.id });
    const audit = await getTestDb().select().from(auditLogs).where(eq(auditLogs.action, "invite.revoked"));
    expect(audit).toEqual([expect.objectContaining({ entityId: pending2?.id, metadata: expect.objectContaining({ reason: "person_merged" }) as unknown })]);
  });

  it("is admin-only: a member gets 403 and nothing changes; the merge is rate limited", async () => {
    const keep = await insertPerson({ userId: member.id });
    const duplicate = await insertPerson();
    const before = await treeState();
    expect((await merge(keep.id, { duplicateId: duplicate.id }, memberAuth)).statusCode).toBe(403);
    expect((await preview(keep.id, duplicate.id, memberAuth)).statusCode).toBe(403);
    expect((await call("GET", "/api/admin/family/duplicates", undefined, memberAuth)).statusCode).toBe(403);
    expect(await treeState()).toEqual(before);
    for (let index = 0; index < 30; index += 1) {
      expect((await merge(keep.id, { duplicateId: keep.id })).statusCode).toBe(400);
    }
    expect((await merge(keep.id, { duplicateId: duplicate.id })).statusCode).toBe(429);
  });
});

describe("GET /api/admin/people/:id/merge-preview", () => {
  it("shows both sides, defaults, edges, account and conflicts, and changes nothing", async () => {
    const f = await raceFixture();
    const before = await treeState();
    const response = await preview(f.tree.id, f.invited.id);
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<PersonMergePreview>();
    expect(await treeState()).toEqual(before);
    expect(body.keep).toMatchObject({ person: { id: f.tree.id }, accountName: null, relationshipCount: 2, hasTreePhoto: false });
    expect(body.duplicate).toMatchObject({ person: { id: f.invited.id, userId: member.id }, accountName: "Lucía Ejemplo", relationshipCount: 2 });
    expect(body.defaults).toMatchObject({ fullName: "keep", nickname: "duplicate", birthDate: "duplicate", birthYear: "keep", familyBranch: "keep" });
    expect(body.relationships.moved).toEqual([
      expect.objectContaining({ id: f.memberEdge.id, role: "partner", otherPersonId: f.partner.id, otherPersonName: "Tomás Muestra" })
    ]);
    expect(body.relationships.dropped).toEqual([expect.objectContaining({ id: f.sameMother.id, role: "parent", outcome: "duplicate" })]);
    expect(body).toMatchObject({ account: { result: "moved", bothLinked: false }, blockers: [], photo: { result: "none" } });
    expect(response.body).not.toMatch(/@example|photoKey|people\//);
  });

  it("lists conflicts and blockers instead of refusing", async () => {
    const other = await createUser({ emailVerified: true });
    const keep = await insertPerson({ userId: other.id });
    const mother = await insertPerson({ fullName: "Madre" });
    await insertParentOf(mother.id, keep.id);
    const duplicate = await insertPerson({ userId: member.id });
    const edge = await insertParentOf(duplicate.id, mother.id);
    const response = await preview(keep.id, duplicate.id);
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<PersonMergePreview>();
    expect(body.blockers).toEqual(["MERGE_BOTH_LINKED", "MERGE_CONFLICT"]);
    expect(body.relationships.conflicts).toEqual([expect.objectContaining({ id: edge.id, reason: "cycle", role: "child", otherPersonName: "Madre" })]);
    expect(await edgesOf(duplicate.id)).toHaveLength(1);
  });
});

describe("undo a merge (POST /api/admin/revisions/:revisionId/revert)", () => {
  it("splits the people again: same id, values, link, edges with provenance, attendance and invites", async () => {
    const f = await raceFixture();
    const edition = await insertCuencada({ year: 2103 });
    await getTestDb().insert(cuencadaAttendance).values([{ cuencadaId: edition.id, personId: f.invited.id }]);
    const expiresAt = new Date(Date.now() + 86_400_000);
    const [history] = await getTestDb()
      .insert(invites)
      .values({ tokenHash: "w45-hash-u", email: "lucia@example.test", personId: f.invited.id, expiresAt, status: "accepted", useCount: 1 })
      .returning({ id: invites.id });
    const peopleBefore = { tree: await personRow(f.tree.id), invited: await personRow(f.invited.id) };
    const edgesBefore = await getTestDb().select().from(personRelationships).orderBy(personRelationships.id);

    const merged = (await merge(f.tree.id, { duplicateId: f.invited.id })).json<PersonMergeResponse>();
    const undo = await call("POST", `/api/admin/revisions/${merged.revisionId}/revert`);
    expect(undo.statusCode, undo.body).toBe(200);
    expect(undo.json<PersonRevision>()).toMatchObject({ action: "person.revert", personId: f.tree.id });

    const strip = (row: Awaited<ReturnType<typeof personRow>>) => {
      if (row === undefined) return undefined;
      const { updatedAt: _u, updatedByUserId: _b, createdAt: _c, ...rest } = row;
      return rest;
    };
    expect(strip(await personRow(f.tree.id))).toEqual(strip(peopleBefore.tree));
    expect(strip(await personRow(f.invited.id))).toEqual(strip(peopleBefore.invited));
    const edgesAfter = await getTestDb().select().from(personRelationships).orderBy(personRelationships.id);
    const shape = (rows: typeof edgesBefore) =>
      rows.map(({ id, kind, fromPersonId, toPersonId, createdByMember, createdByUserId }) => ({ id, kind, fromPersonId, toPersonId, createdByMember, createdByUserId }));
    expect(shape(edgesAfter)).toEqual(shape(edgesBefore));
    expect(await getTestDb().select({ personId: cuencadaAttendance.personId }).from(cuencadaAttendance)).toEqual([{ personId: f.invited.id }]);
    const [invite] = await getTestDb().select({ personId: invites.personId }).from(invites).where(eq(invites.id, history?.id ?? ""));
    expect(invite?.personId).toBe(f.invited.id);

    // The merge row is marked undone and cannot be undone twice.
    const [row] = await getTestDb().select().from(personRevisions).where(eq(personRevisions.id, merged.revisionId));
    expect(row?.revertedByRevisionId).not.toBeNull();
    expect((await call("POST", `/api/admin/revisions/${merged.revisionId}/revert`)).statusCode).toBe(409);
  });

  it("refuses (409) when anything changed after the merge, and changes nothing", async () => {
    const keep = await insertPerson({ fullName: "Irene Ejemplo" });
    const duplicate = await insertPerson({ fullName: "Irene Ejemplo" });
    const merged = (await merge(keep.id, { duplicateId: duplicate.id })).json<PersonMergeResponse>();
    expect((await call("PATCH", `/api/admin/people/${keep.id}`, { nickname: "Ire" })).statusCode).toBe(200);
    const before = await treeState();
    const undo = await call("POST", `/api/admin/revisions/${merged.revisionId}/revert`);
    expect(undo.statusCode, undo.body).toBe(409);
    expect(await treeState()).toEqual(before);

    // A new relative after the merge is a change too.
    const keep2 = await insertPerson({ fullName: "Julia Ejemplo" });
    const dup2 = await insertPerson({ fullName: "Julia Ejemplo" });
    const merged2 = (await merge(keep2.id, { duplicateId: dup2.id })).json<PersonMergeResponse>();
    expect((await call("POST", "/api/admin/people", { fullName: "Hija Ejemplo", relateTo: { personId: keep2.id, kind: "child_of" } })).statusCode).toBe(201);
    expect((await call("POST", `/api/admin/revisions/${merged2.revisionId}/revert`)).statusCode).toBe(409);
  });

  it("shows the merge in both people's history; a purge of the removed person erases it", async () => {
    const keep = await insertPerson({ fullName: "Karla Ejemplo" });
    const duplicate = await insertPerson({ fullName: "Karla Ejemplo", bio: "Dato privado." });
    const merged = (await merge(keep.id, { duplicateId: duplicate.id })).json<PersonMergeResponse>();
    for (const id of [keep.id, duplicate.id]) {
      const list = (await call("GET", `/api/admin/people/${id}/revisions`)).json<Page<PersonRevision>>();
      expect(list.items.map((item) => [item.id, item.action, item.revertible])).toContainEqual([merged.revisionId, "person.merge", true]);
    }
    const activity = await call("GET", "/api/admin/family/activity?action=person.merge");
    expect(activity.statusCode, activity.body).toBe(200);
    expect((await call("POST", `/api/admin/people/${duplicate.id}/revisions/purge`, { confirm: true })).json()).toEqual({ deleted: 1 });
    const left = await getTestDb().select().from(personRevisions).where(sql`${personRevisions.before}::text like ${"%Dato privado%"}`);
    expect(left).toHaveLength(0);
  });
});

describe("GET /api/admin/family/duplicates", () => {
  it("pairs same names (case, accents, spaces), a second surname and invite fallbacks; years must fit", async () => {
    const tree = await insertPerson({ fullName: "Lucía Ejemplo", birthYear: 1990 });
    await insertParentOf((await insertPerson({ fullName: "Padre Uno" })).id, tree.id);
    const invited = await insertPerson({ fullName: "  LUCIA   ejemplo ", userId: member.id });
    const surname = await insertPerson({ fullName: "Mateo Muestra", birthYear: 1970 });
    const surname2 = await insertPerson({ fullName: "Mateo Muestra Ríos", birthYear: 1971 });
    await insertParentOf(surname.id, (await insertPerson({ fullName: "Hijo Muestra" })).id); // more relationships: suggested to keep
    await insertPerson({ fullName: "Mateo Muestra", birthYear: 1980 }); // incompatible with both
    await insertPerson({ fullName: "Nora" });
    await insertPerson({ fullName: "Nora Ficticio" }); // one-word name never matches a longer one
    const requested = await insertPerson({ fullName: "Olga Vega" });
    const created = await insertPerson({ fullName: "Olguita V.", userId: (await createUser()).id });
    await getTestDb().insert(auditLogs).values({
      action: "invite.accepted",
      entityType: "invite",
      entityId: "00000000-0000-4000-8000-0000000000aa",
      metadata: { personId: created.id, personLink: "fallback", requestedPersonId: requested.id, personFallbackReason: "linked" }
    });
    const other = await createUser();
    const both1 = await insertPerson({ fullName: "Pablo Ejemplo", userId: other.id });
    const both2 = await insertPerson({ fullName: "Pablo Ejemplo", userId: (await createUser()).id });
    await insertParentOf(both1.id, (await insertPerson({ fullName: "Hija Ejemplo" })).id);

    const response = await call("GET", "/api/admin/family/duplicates?limit=50");
    expect(response.statusCode, response.body).toBe(200);
    const page = response.json<Page<PossibleDuplicate>>();
    const pairs = page.items.map((item) => [item.reason, item.keep.id, item.duplicate.id, item.mergeable]);
    expect(pairs).toEqual([
      ["invite_fallback", requested.id, created.id, true],
      ["same_name", tree.id, invited.id, true],
      ["same_name", both1.id, both2.id, false],
      ["similar_name", surname.id, surname2.id, true]
    ]);
    expect(page.items[1]?.keep).toMatchObject({ linked: false, relationshipCount: 1 });
    expect(response.body).not.toContain(member.id);
    expect(response.body).not.toContain(other.id);

    const first = (await call("GET", "/api/admin/family/duplicates?limit=3")).json<Page<PossibleDuplicate>>();
    expect(first.items).toHaveLength(3);
    expect(first.nextCursor).not.toBeNull();
    const second = (await call("GET", `/api/admin/family/duplicates?limit=3&cursor=${first.nextCursor ?? ""}`)).json<Page<PossibleDuplicate>>();
    expect(second.items.map((item) => item.duplicate.id)).toEqual([surname2.id]);
    expect(second.nextCursor).toBeNull();
    expect((await call("GET", "/api/admin/family/duplicates?cursor=bm9wZQ")).statusCode).toBe(400);
  });
});
