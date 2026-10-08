/**
 * WP-4.1 [SEC]: admin family writes with revisions, "Deshacer", history
 * purge, the activity feed, retention, and person delete with photo
 * objects. Fictional people only.
 */
import { randomUUID } from "node:crypto";
import type { FamilyActivityItem, Page, PersonDetails, PersonRevision } from "@cuencada/types";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { type AuthInjectOptions, createUser, loginAs, type TestUser } from "../../../test/helpers/factories.js";
import { FakeStorage } from "../../../test/helpers/fakes.js";
import { insertParentOf, insertPerson } from "../../../test/helpers/family.js";
import type { App } from "../../app.js";
import { auditLogs, invites, people, personPhotoUploads, personRelationships, personRevisions } from "../../db/schema/index.js";
import { personPhotoKeys } from "./personPhoto.js";
import { purgeExpiredRevisions } from "./revisions.js";

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
  member = await createUser({ emailVerified: true, displayName: "Ana Morales" });
  memberAuth = await loginAs(app, member);
});

afterEach(async () => {
  await app.close();
});

async function call(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown, auth: AuthInjectOptions = adminAuth) {
  return app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }), ...auth });
}

async function history(personId: string): Promise<PersonRevision[]> {
  const response = await call("GET", `/api/admin/people/${personId}/revisions?limit=100`);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<Page<PersonRevision>>().items;
}

async function revert(revisionId: string) {
  return call("POST", `/api/admin/revisions/${revisionId}/revert`);
}

async function personRow(id: string) {
  const [row] = await getTestDb().select().from(people).where(eq(people.id, id));
  return row;
}

describe("admin people writes", () => {
  it("creates with dates, birthplace, bio and relateTo; edges are admin-made; revisions carry personId", async () => {
    const anchor = await insertPerson({ fullName: "José Herrera Navarro" });
    const response = await call("POST", "/api/admin/people", {
      fullName: "Ana Morales Vega",
      birthDate: "1955-04-10",
      birthplace: "Pueblo Norte",
      bio: "Maestra.",
      relateTo: { personId: anchor.id, kind: "partner_of" }
    });
    expect(response.statusCode, response.body).toBe(201);
    const created = response.json<PersonDetails>();
    expect(created).toMatchObject({ birthYear: 1955, birthDate: "1955-04-10", birthplace: "Pueblo Norte", bio: "Maestra." });
    // Partners are stored with from < to, so look at both endpoints.
    const [edge] = await getTestDb()
      .select()
      .from(personRelationships)
      .where(sql`${personRelationships.fromPersonId} = ${created.id} or ${personRelationships.toPersonId} = ${created.id}`);
    expect(edge).toMatchObject({ kind: "partner_of", createdByMember: false, createdByUserId: admin.id });
    const items = await history(created.id);
    expect(items.map((item) => item.action).sort()).toEqual(["person.create", "relationship.create"]);
    expect(items.every((item) => item.actor?.displayName === "Octavio Admin" && item.revertible)).toBe(true);
    // The anchor's history shows the relationship too (either endpoint).
    expect((await history(anchor.id)).map((item) => item.action)).toEqual(["relationship.create"]);
  });

  it("re-checks the merged dates on PATCH (400, never a DB 500)", async () => {
    const person = await insertPerson({ birthYear: 1950, birthDate: "1950-03-04" });
    for (const payload of [{ birthYear: 1951 }, { deathDate: "1949-12-31" }, { deceased: false, deathYear: 2000 }]) {
      const response = await call("PATCH", `/api/admin/people/${person.id}`, payload);
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    const ok = await call("PATCH", `/api/admin/people/${person.id}`, { birthDate: null, birthYear: 1951 });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it("never moves a linked person to another account in one step (409 PERSON_LINKED_TO_OTHER); unlink first", async () => {
    const other = await createUser({ emailVerified: true });
    const person = await insertPerson({ userId: member.id });
    const moved = await call("PATCH", `/api/admin/people/${person.id}`, { userId: other.id });
    expect(moved.statusCode, moved.body).toBe(409);
    expect(moved.json<{ error: { code: string; details: Array<{ code?: string; path: string }> } }>().error).toMatchObject({
      code: "CONFLICT",
      details: [{ path: "userId", code: "PERSON_LINKED_TO_OTHER" }]
    });
    expect((await personRow(person.id))?.userId).toBe(member.id);
    // Same account again is a no-op change, not a move.
    expect((await call("PATCH", `/api/admin/people/${person.id}`, { userId: member.id })).statusCode).toBe(200);
    expect((await call("PATCH", `/api/admin/people/${person.id}`, { userId: null })).statusCode).toBe(200);
    expect((await call("PATCH", `/api/admin/people/${person.id}`, { userId: other.id })).statusCode).toBe(200);
    expect((await personRow(person.id))?.userId).toBe(other.id);
  });

  it("writes revisions for admin relationship create and delete", async () => {
    const parent = await insertPerson();
    const child = await insertPerson();
    const created = await call("POST", "/api/admin/relationships", { kind: "parent_of", fromPersonId: parent.id, toPersonId: child.id });
    expect(created.statusCode).toBe(201);
    const id = created.json<{ id: string }>().id;
    expect((await call("DELETE", `/api/admin/relationships/${id}`)).statusCode).toBe(204);
    expect((await history(child.id)).map((item) => item.action)).toEqual(["relationship.delete", "relationship.create"]);
  });
});

describe("POST /api/admin/revisions/:revisionId/revert", () => {
  it("restores the values before an update, records person.revert, and refuses a second undo", async () => {
    const person = await insertPerson({ fullName: "Luis Morales", nickname: "Lucho" });
    expect((await call("PATCH", `/api/admin/people/${person.id}`, { nickname: "Don Luis", birthplace: "Villa Sur" })).statusCode).toBe(200);
    const [update] = await history(person.id);
    if (update === undefined) throw new Error("no revision");
    const response = await revert(update.id);
    expect(response.statusCode, response.body).toBe(200);
    const record = response.json<PersonRevision>();
    expect(record).toMatchObject({ action: "person.revert", revertible: false, personId: person.id });
    expect(record.after).toMatchObject({ personId: person.id, nickname: "Lucho", birthplace: null });
    expect(await personRow(person.id)).toMatchObject({ nickname: "Lucho", birthplace: null, updatedByUserId: admin.id });
    const again = await revert(update.id);
    expect(again.statusCode).toBe(409);
    const items = await history(person.id);
    expect(items.find((item) => item.id === update.id)).toMatchObject({ revertedByRevisionId: record.id, revertible: false });
    const audit = await getTestDb().select().from(auditLogs).where(eq(auditLogs.action, "person.revision_reverted"));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain("Lucho");
  });

  it("answers 409 when the person changed after the revision (stale)", async () => {
    const person = await insertPerson({ nickname: "Uno" });
    await call("PATCH", `/api/admin/people/${person.id}`, { nickname: "Dos" });
    await call("PATCH", `/api/admin/people/${person.id}`, { nickname: "Tres" });
    const items = await history(person.id);
    const older = items.at(-1);
    if (older === undefined) throw new Error("no revision");
    expect((await revert(older.id)).statusCode).toBe(409);
    expect((await personRow(person.id))?.nickname).toBe("Tres");
  });

  it("undoes a member's addition: the person and its edge go, both revisions are marked reverted", async () => {
    const self = await insertPerson({ userId: member.id, fullName: "Ana Morales Vega" });
    const created = await call("POST", "/api/family/people", { fullName: "Hija Nueva", relateTo: { personId: self.id, kind: "child_of" } }, memberAuth);
    expect(created.statusCode, created.body).toBe(201);
    const childId = created.json<PersonDetails>().id;
    const feed = await call("GET", `/api/admin/family/activity?actorUserId=${member.id}`);
    const items = feed.json<Page<FamilyActivityItem>>().items;
    expect(items.map((item) => item.action).sort()).toEqual(["person.create", "relationship.create"]);
    expect(items.every((item) => item.personName === "Hija Nueva")).toBe(true);
    const create = items.find((item) => item.action === "person.create");
    if (create === undefined) throw new Error("no create");
    const response = await revert(create.id);
    expect(response.statusCode, response.body).toBe(200);
    expect(await personRow(childId)).toBeUndefined();
    expect(await getTestDb().select().from(personRelationships).where(eq(personRelationships.toPersonId, childId))).toHaveLength(0);
    const after = (await call("GET", `/api/admin/family/activity?actorUserId=${member.id}`)).json<Page<FamilyActivityItem>>().items;
    expect(after.every((item) => item.revertedByRevisionId !== null && !item.revertible)).toBe(true);
    // The revert row names the deleted person (snapshot) in the feed.
    const all = (await call("GET", "/api/admin/family/activity?action=person.revert")).json<Page<FamilyActivityItem>>().items;
    expect(all[0]).toMatchObject({ action: "person.revert", personName: "Hija Nueva", personId: null });
  });

  it("undoing an addition cleans up like a delete: pending invites revoked, photo objects removed", async () => {
    const self = await insertPerson({ userId: member.id });
    const created = await call("POST", "/api/family/people", { fullName: "Hija Con Foto", relateTo: { personId: self.id, kind: "child_of" } }, memberAuth);
    const childId = created.json<PersonDetails>().id;
    // Server-generated key layout (WP-4.3): only keys in it are ever deleted.
    const base = personPhotoKeys(childId, randomUUID(), "image/jpeg").large.replace(/-256\.webp$/, "");
    for (const size of [512, 256, 64]) await storage.put({ key: `${base}-${size}.webp`, body: new Uint8Array([1]), contentType: "image/webp" });
    await storage.put({ key: `people/${childId}/pendiente.jpg`, body: new Uint8Array([1]), contentType: "image/jpeg" });
    await getTestDb().update(people).set({ photoKey: `${base}-256.webp`, photoUpdatedAt: new Date() }).where(eq(people.id, childId));
    await getTestDb()
      .insert(personPhotoUploads)
      .values({ personId: childId, objectKey: `people/${childId}/pendiente.jpg`, mimeType: "image/jpeg", byteSize: 1, expiresAt: new Date(Date.now() + 60_000) });
    const [invite] = await getTestDb()
      .insert(invites)
      .values({ tokenHash: "d".repeat(64), email: "hija@example.com", personId: childId, expiresAt: new Date(Date.now() + 86_400_000) })
      .returning();
    // The photo/invite writes changed nothing the snapshot covers, so the undo is not stale.
    const create = (await history(childId)).find((item) => item.action === "person.create");
    if (create === undefined || invite === undefined) throw new Error("fixture");
    const response = await revert(create.id);
    expect(response.statusCode, response.body).toBe(200);
    expect(await personRow(childId)).toBeUndefined();
    const [after] = await getTestDb().select().from(invites).where(eq(invites.id, invite.id));
    expect(after).toMatchObject({ status: "revoked", personId: null });
    const audits = await getTestDb().select().from(auditLogs).where(eq(auditLogs.action, "invite.revoked"));
    expect(audits[0]).toMatchObject({ entityId: invite.id, metadata: { personId: childId, reason: "person_deleted" } });
    expect([...storage.objects.keys()].filter((key) => key.startsWith(`people/${childId}/`))).toEqual([]);
  });

  it("refuses to undo an addition that has other edges since", async () => {
    const anchor = await insertPerson();
    const created = (await call("POST", "/api/admin/people", { fullName: "Nueva", relateTo: { personId: anchor.id, kind: "child_of" } })).json<PersonDetails>();
    await insertParentOf((await insertPerson()).id, created.id);
    const create = (await history(created.id)).find((item) => item.action === "person.create");
    if (create === undefined) throw new Error("no create");
    expect((await revert(create.id)).statusCode).toBe(409);
    expect(await personRow(created.id)).toBeDefined();
  });

  it("restores a deleted person with the edges deleted with it", async () => {
    const parent = await insertPerson({ fullName: "Padre" });
    const person = await insertPerson({ fullName: "Persona Borrada", birthYear: 1990, birthDate: "1990-01-02" });
    const child = await insertPerson({ fullName: "Hijo" });
    await insertParentOf(parent.id, person.id);
    await insertParentOf(person.id, child.id);
    expect((await call("DELETE", `/api/admin/people/${person.id}`)).statusCode).toBe(204);
    const items = await history(person.id);
    expect(items.map((item) => item.action).sort()).toEqual(["person.delete", "relationship.delete", "relationship.delete"]);
    const deletion = items.find((item) => item.action === "person.delete");
    if (deletion === undefined) throw new Error("no delete");
    expect(deletion.personId).toBeNull();
    const response = await revert(deletion.id);
    expect(response.statusCode, response.body).toBe(200);
    expect(await personRow(person.id)).toMatchObject({ fullName: "Persona Borrada", birthDate: "1990-01-02" });
    const edges = await getTestDb().select().from(personRelationships).where(sql`${personRelationships.fromPersonId} = ${person.id} or ${personRelationships.toPersonId} = ${person.id}`);
    expect(edges).toHaveLength(2);
    expect((await history(person.id)).filter((item) => item.revertedByRevisionId !== null)).toHaveLength(3);
  });

  it("undoes relationship create and delete, and keeps the cycle checks on re-adding", async () => {
    const a = await insertPerson();
    const b = await insertPerson();
    const created = (await call("POST", "/api/admin/relationships", { kind: "parent_of", fromPersonId: a.id, toPersonId: b.id })).json<{ id: string }>();
    const [createRevision] = await history(b.id);
    if (createRevision === undefined) throw new Error("no revision");
    expect((await revert(createRevision.id)).statusCode).toBe(200);
    expect(await getTestDb().select().from(personRelationships).where(eq(personRelationships.id, created.id))).toHaveLength(0);

    const again = (await call("POST", "/api/admin/relationships", { kind: "parent_of", fromPersonId: a.id, toPersonId: b.id })).json<{ id: string }>();
    await call("DELETE", `/api/admin/relationships/${again.id}`);
    // Meanwhile the opposite edge appears: re-adding would make a cycle.
    await insertParentOf(b.id, a.id);
    const deleteRevision = (await history(b.id)).find((item) => item.action === "relationship.delete");
    if (deleteRevision === undefined) throw new Error("no revision");
    expect((await revert(deleteRevision.id)).statusCode).toBe(409);
  });

  it("refuses photo and revert revisions (409) and unknown ids (404)", async () => {
    const person = await insertPerson();
    const [photo] = await getTestDb()
      .insert(personRevisions)
      .values({
        action: "person.photo",
        personId: person.id,
        actorUserId: admin.id,
        before: null,
        after: { type: "photo", personId: person.id, id: person.id, hasPhoto: true, photoUpdatedAt: new Date().toISOString() }
      })
      .returning();
    if (photo === undefined) throw new Error("fixture");
    expect((await revert(photo.id)).statusCode).toBe(409);
    expect((await revert("00000000-0000-4000-8000-000000000000")).statusCode).toBe(404);
  });

  it("re-checks the dates of a restored snapshot (400)", async () => {
    const person = await insertPerson({ nickname: "Actual" });
    const [bad] = await getTestDb()
      .insert(personRevisions)
      .values({
        action: "person.update",
        personId: person.id,
        actorUserId: admin.id,
        before: {
          type: "person",
          personId: person.id,
          id: person.id,
          userId: null,
          fullName: person.fullName,
          nickname: null,
          familyBranch: null,
          birthYear: 1990,
          deathYear: null,
          birthDate: "1991-01-01",
          deathDate: null,
          birthplace: null,
          bio: null,
          deceased: false
        },
        after: {
          type: "person",
          personId: person.id,
          id: person.id,
          userId: null,
          fullName: person.fullName,
          nickname: "Actual",
          familyBranch: null,
          birthYear: null,
          deathYear: null,
          birthDate: null,
          deathDate: null,
          birthplace: null,
          bio: null,
          deceased: false
        }
      })
      .returning();
    if (bad === undefined) throw new Error("fixture");
    expect((await revert(bad.id)).statusCode).toBe(400);
  });
});

describe("history purge and person delete", () => {
  it("purges every revision about a person, also after the delete, with {confirm:true} only", async () => {
    const other = await insertPerson({ fullName: "Otra Persona" });
    const person = (await call("POST", "/api/admin/people", { fullName: "Para Borrar", relateTo: { personId: other.id, kind: "partner_of" } })).json<PersonDetails>();
    await call("PATCH", `/api/admin/people/${person.id}`, { bio: "Datos privados." });
    expect((await call("DELETE", `/api/admin/people/${person.id}`)).statusCode).toBe(204);
    expect((await call("POST", `/api/admin/people/${person.id}/revisions/purge`, { confirm: false })).statusCode).toBe(400);
    expect((await call("POST", `/api/admin/people/${person.id}/revisions/purge`, {})).statusCode).toBe(400);
    const purge = await call("POST", `/api/admin/people/${person.id}/revisions/purge`, { confirm: true });
    expect(purge.statusCode, purge.body).toBe(200);
    expect(purge.json<{ deleted: number }>().deleted).toBe(5);
    expect(await history(person.id)).toHaveLength(0);
    const rows = await getTestDb().select().from(personRevisions);
    expect(JSON.stringify(rows)).not.toContain(person.id);
    const [audit] = await getTestDb().select().from(auditLogs).where(eq(auditLogs.action, "person.revisions_purged"));
    expect(audit?.metadata).toEqual({ deleted: 5 });
  });

  it("deletes the photo objects (current derivatives and pending uploads) with the person", async () => {
    const person = await insertPerson({ fullName: "Con Foto" });
    const base = personPhotoKeys(person.id, randomUUID(), "image/jpeg").large.replace(/-256\.webp$/, "");
    for (const size of [512, 256, 64]) await storage.put({ key: `${base}-${size}.webp`, body: new Uint8Array([1]), contentType: "image/webp" });
    await storage.put({ key: `people/${person.id}/pendiente.jpg`, body: new Uint8Array([1]), contentType: "image/jpeg" });
    await storage.put({ key: "people/otra/foto-256.webp", body: new Uint8Array([1]), contentType: "image/webp" });
    await getTestDb().update(people).set({ photoKey: `${base}-256.webp`, photoUpdatedAt: new Date() }).where(eq(people.id, person.id));
    await getTestDb()
      .insert(personPhotoUploads)
      .values({ personId: person.id, objectKey: `people/${person.id}/pendiente.jpg`, mimeType: "image/jpeg", byteSize: 1, expiresAt: new Date(Date.now() + 60_000) });
    expect((await call("DELETE", `/api/admin/people/${person.id}`)).statusCode).toBe(204);
    expect([...storage.objects.keys()]).toEqual(["people/otra/foto-256.webp"]);
  });

  it("with purgeHistory=true leaves no revision about the person", async () => {
    const person = await insertPerson({ fullName: "Solicitud de Borrado" });
    await call("PATCH", `/api/admin/people/${person.id}`, { bio: "Algo privado." });
    const response = await call("DELETE", `/api/admin/people/${person.id}?purgeHistory=true`);
    expect(response.statusCode, response.body).toBe(204);
    expect(await personRow(person.id)).toBeUndefined();
    expect(await history(person.id)).toHaveLength(0);
    expect((await call("DELETE", `/api/admin/people/${person.id}?purgeHistory=quizas`)).statusCode).toBe(400);
  });

  it("revokes the person's pending invites in the same transaction (admin and member delete), audited with ids", async () => {
    const person = await insertPerson({ fullName: "Con Invitación" });
    const [pending] = await getTestDb()
      .insert(invites)
      .values({ tokenHash: "a".repeat(64), email: "pendiente@example.com", personId: person.id, expiresAt: new Date(Date.now() + 86_400_000) })
      .returning();
    const [accepted] = await getTestDb()
      .insert(invites)
      .values({
        tokenHash: "b".repeat(64),
        email: "aceptada@example.com",
        personId: person.id,
        status: "accepted",
        acceptedAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000)
      })
      .returning();
    if (pending === undefined || accepted === undefined) throw new Error("fixture");
    expect((await call("DELETE", `/api/admin/people/${person.id}`)).statusCode).toBe(204);
    const [afterPending] = await getTestDb().select().from(invites).where(eq(invites.id, pending.id));
    expect(afterPending).toMatchObject({ status: "revoked", personId: null });
    expect(afterPending?.revokedAt).not.toBeNull();
    const [afterAccepted] = await getTestDb().select().from(invites).where(eq(invites.id, accepted.id));
    expect(afterAccepted?.status).toBe("accepted");
    const audits = await getTestDb().select().from(auditLogs).where(eq(auditLogs.action, "invite.revoked"));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ entityId: pending.id, metadata: { personId: person.id, reason: "person_deleted" } });
    expect(JSON.stringify(audits)).not.toContain("pendiente@example.com");

    // Member delete of their own addition does the same.
    const self = await insertPerson({ userId: member.id });
    const mine = (await call("POST", "/api/family/people", { fullName: "Mía", relateTo: { personId: self.id, kind: "child_of" } }, memberAuth)).json<PersonDetails>();
    const [mineInvite] = await getTestDb()
      .insert(invites)
      .values({ tokenHash: "c".repeat(64), email: "mia@example.com", personId: mine.id, expiresAt: new Date(Date.now() + 86_400_000) })
      .returning();
    expect((await call("DELETE", `/api/family/people/${mine.id}`, undefined, memberAuth)).statusCode).toBe(204);
    const [afterMine] = await getTestDb().select().from(invites).where(eq(invites.id, mineInvite?.id ?? ""));
    expect(afterMine?.status).toBe("revoked");
  });

  it("never deadlocks (no 500) when an admin delete races a member edit of the same person (lock order tree → person)", async () => {
    const self = await insertPerson({ userId: member.id });
    for (let round = 0; round < 8; round += 1) {
      const created = await call("POST", "/api/family/people", { fullName: `Carrera ${round}`, relateTo: { personId: self.id, kind: "child_of" } }, memberAuth);
      expect(created.statusCode, created.body).toBe(201);
      const id = created.json<PersonDetails>().id;
      const [removed, edited, selfEdit] = await Promise.all([
        call("DELETE", `/api/admin/people/${id}`),
        call("PATCH", `/api/family/people/${id}`, { nickname: `N${round}` }, memberAuth),
        call("PATCH", "/api/family/me", { nickname: `Yo ${round}` }, memberAuth)
      ]);
      expect(removed.statusCode, removed.body).toBe(204);
      expect([200, 404], edited.body).toContain(edited.statusCode);
      expect(selfEdit.statusCode, selfEdit.body).toBe(200);
      expect(await personRow(id)).toBeUndefined();
    }
  });

  it("keeps the 409 for linked people", async () => {
    const person = await insertPerson({ userId: member.id });
    expect((await call("DELETE", `/api/admin/people/${person.id}?purgeHistory=true`)).statusCode).toBe(409);
    expect(await personRow(person.id)).toBeDefined();
  });
});

describe("GET /api/admin/family/activity", () => {
  it("lists every change newest first with keyset pages and filters by actor and action", async () => {
    const people = [];
    for (let index = 0; index < 5; index += 1) {
      people.push((await call("POST", "/api/admin/people", { fullName: `Persona ${index}` })).json<PersonDetails>());
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const url: string = `/api/admin/family/activity?limit=2${cursor === null ? "" : `&cursor=${cursor}`}`;
      const page = (await call("GET", url)).json<Page<FamilyActivityItem>>();
      seen.push(...page.items.map((item) => item.personName ?? ""));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual(["Persona 4", "Persona 3", "Persona 2", "Persona 1", "Persona 0"]);
    expect((await call("GET", `/api/admin/family/activity?actorUserId=${member.id}`)).json<Page<FamilyActivityItem>>().items).toHaveLength(0);
    expect((await call("GET", "/api/admin/family/activity?action=person.update")).json<Page<FamilyActivityItem>>().items).toHaveLength(0);
    expect((await call("GET", "/api/admin/family/activity?action=nope")).statusCode).toBe(400);
    expect((await call("GET", "/api/admin/family/activity?cursor=bad!")).statusCode).toBe(400);
  });

  it("is admin-only, like every revision route", async () => {
    const person = await insertPerson();
    for (const [method, url, payload] of [
      ["GET", "/api/admin/family/activity", undefined],
      ["GET", `/api/admin/people/${person.id}/revisions`, undefined],
      ["POST", `/api/admin/people/${person.id}/revisions/purge`, { confirm: true }],
      ["POST", "/api/admin/revisions/00000000-0000-4000-8000-000000000000/revert", undefined]
    ] as const) {
      expect((await call(method, url, payload, memberAuth)).statusCode, url).toBe(403);
    }
  });
});

describe("revision snapshots and retention", () => {
  it("never store emails, contacts, object keys or tokens", async () => {
    const linkedUser = await createUser({ emailVerified: true, profile: { phone: "+525550001111" } });
    const person = await insertPerson({ fullName: "Con Cuenta", userId: linkedUser.id, photoKey: "people/x/foto-256.webp", photoUpdatedAt: new Date() });
    await call("PATCH", `/api/admin/people/${person.id}`, { nickname: "Apodo" });
    const rows = await getTestDb().select({ before: personRevisions.before, after: personRevisions.after }).from(personRevisions);
    const text = JSON.stringify(rows);
    expect(text).not.toContain(linkedUser.email);
    expect(text).not.toContain("5550001111");
    expect(text).not.toContain("people/x");
    expect(text).not.toMatch(/photoKey|objectKey|email|token/i);
  });

  it("deletes revisions older than one year", async () => {
    const person = await insertPerson();
    await call("PATCH", `/api/admin/people/${person.id}`, { nickname: "Viejo" });
    await call("PATCH", `/api/admin/people/${person.id}`, { nickname: "Nuevo" });
    const [oldest] = (await history(person.id)).slice(-1);
    if (oldest === undefined) throw new Error("fixture");
    await getTestDb().update(personRevisions).set({ createdAt: new Date(Date.now() - 366 * 86_400_000) }).where(eq(personRevisions.id, oldest.id));
    expect(await purgeExpiredRevisions(app.db, new Date())).toBe(1);
    expect(await history(person.id)).toHaveLength(1);
    expect(await purgeExpiredRevisions(app.db, new Date())).toBe(0);
  });
});
