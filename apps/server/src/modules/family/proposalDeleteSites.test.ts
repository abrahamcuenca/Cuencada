/**
 * WP-6.4 [SEC]: the three person-delete sites with pending tree-link
 * proposals (ADR 0001 §8, WP-6.0 "Delete/merge integration"). A pending
 * proposal must name two people (DB CHECK), so each site withdraws or
 * re-points them first; none may answer 500. Fictional people only.
 */
import type { PersonMergeResponse, PersonRevision, Page, Person } from "@cuencada/types";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { type AuthInjectOptions, createUser, loginAs, type TestUser } from "../../../test/helpers/factories.js";
import { insertParentOf, insertPerson } from "../../../test/helpers/family.js";
import type { App } from "../../app.js";
import { auditLogs, familySettings, people, treeLinkProposals } from "../../db/schema/index.js";

let app: App;
let admin: TestUser;
let adminAuth: AuthInjectOptions;
let member: TestUser;
let memberAuth: AuthInjectOptions;

beforeEach(async () => {
  app = await createTestApp();
  admin = await createUser({ role: "admin", emailVerified: true });
  adminAuth = await loginAs(app, admin);
  member = await createUser({ emailVerified: true });
  memberAuth = await loginAs(app, member);
});

afterEach(async () => {
  await app.close();
});

/** Insert a pending proposal straight into the table. */
async function pendingProposal(fromPersonId: string, toPersonId: string, proposedByUserId: string | null = member.id, kind: "same_person" | "relate" = "same_person") {
  const [row] = await getTestDb()
    .insert(treeLinkProposals)
    .values({ kind, relation: kind === "relate" ? "partner_of" : null, fromPersonId, toPersonId, proposedByUserId })
    .returning();
  if (row === undefined) throw new Error("no proposal");
  return row;
}

async function proposal(id: string) {
  const [row] = await getTestDb().select().from(treeLinkProposals).where(eq(treeLinkProposals.id, id));
  return row;
}

async function withdrawAudits(id: string) {
  return getTestDb()
    .select({ metadata: auditLogs.metadata })
    .from(auditLogs)
    .where(and(eq(auditLogs.entityId, id), eq(auditLogs.action, "tree_proposal.withdrawn")));
}

describe("deletePersonTx with pending proposals", () => {
  it("admin delete withdraws them (person_deleted, no resolver) and answers 204", async () => {
    const doomed = await insertPerson();
    const other = await insertPerson();
    const p1 = await pendingProposal(doomed.id, other.id);
    const p2 = await pendingProposal(other.id, doomed.id, null, "relate");
    const response = await app.inject({ method: "DELETE", url: `/api/admin/people/${doomed.id}`, ...adminAuth });
    expect(response.statusCode, response.body).toBe(204);
    expect(await proposal(p1.id)).toMatchObject({ status: "withdrawn", fromPersonId: null, toPersonId: other.id, resolvedByUserId: null });
    expect(await proposal(p2.id)).toMatchObject({ status: "withdrawn", toPersonId: null });
    expect((await withdrawAudits(p1.id))[0]?.metadata).toEqual({ reason: "person_deleted", personId: doomed.id });
  });

  it("admin delete with purgeHistory also works", async () => {
    const doomed = await insertPerson();
    const other = await insertPerson();
    const p1 = await pendingProposal(doomed.id, other.id);
    const response = await app.inject({ method: "DELETE", url: `/api/admin/people/${doomed.id}?purgeHistory=true`, ...adminAuth });
    expect(response.statusCode, response.body).toBe(204);
    expect((await proposal(p1.id))?.status).toBe("withdrawn");
  });

  it("a member deleting their own addition withdraws them too", async () => {
    const self = await insertPerson({ userId: member.id });
    const created = await app.inject({
      method: "POST",
      url: "/api/family/people",
      payload: { fullName: "Hija Nueva Ejemplo", relateTo: { personId: self.id, kind: "child_of" } },
      ...memberAuth
    });
    expect(created.statusCode, created.body).toBe(201);
    const addition = created.json<Person>().id;
    const stranger = await insertPerson();
    const p1 = await pendingProposal(addition, stranger.id, admin.id);
    const response = await app.inject({ method: "DELETE", url: `/api/family/people/${addition}`, ...memberAuth });
    expect(response.statusCode, response.body).toBe(204);
    expect((await proposal(p1.id))?.status).toBe("withdrawn");
  });
});

describe("revert of a person.create with pending proposals", () => {
  it("withdraws them before the delete", async () => {
    const created = await app.inject({ method: "POST", url: "/api/admin/people", payload: { fullName: "Persona Revertida" }, ...adminAuth });
    expect(created.statusCode).toBe(201);
    const personId = created.json<Person>().id;
    const other = await insertPerson();
    const p1 = await pendingProposal(other.id, personId);
    const history = (await app.inject({ method: "GET", url: `/api/admin/people/${personId}/revisions`, ...adminAuth })).json<Page<PersonRevision>>();
    const createRevision = history.items.find((item) => item.action === "person.create");
    if (createRevision === undefined) throw new Error("no create revision");
    const response = await app.inject({ method: "POST", url: `/api/admin/revisions/${createRevision.id}/revert`, ...adminAuth });
    expect(response.statusCode, response.body).toBe(200);
    expect(await getTestDb().select().from(people).where(eq(people.id, personId))).toHaveLength(0);
    expect(await proposal(p1.id)).toMatchObject({ status: "withdrawn", toPersonId: null });
    expect((await withdrawAudits(p1.id))[0]?.metadata).toMatchObject({ reason: "person_deleted" });
  });
});

describe("mergePeopleTx with pending proposals", () => {
  it("re-points them to keep, withdraws collapsed and colliding ones, moves the root; undo restores none", async () => {
    const keep = await insertPerson({ fullName: "Abuelo Ramiro Ejemplo" });
    const duplicate = await insertPerson({ fullName: "Abuelo Ramiro Ejemplo" });
    const uncle = await insertPerson({ fullName: "Tío Pablo Ejemplo" });
    const aunt = await insertPerson({ fullName: "Tía Inés Ejemplo" });
    const otherUser = await createUser({ emailVerified: true });
    // Re-pointed: duplicate ↔ uncle → keep ↔ uncle.
    const moved = await pendingProposal(duplicate.id, uncle.id, member.id, "relate");
    // Collapses: keep ↔ duplicate.
    const collapsed = await pendingProposal(keep.id, duplicate.id, otherUser.id, "relate");
    // Collides: the member already has keep ↔ aunt pending.
    await pendingProposal(keep.id, aunt.id, member.id);
    const colliding = await pendingProposal(aunt.id, duplicate.id, member.id);
    // Another proposer's same pair does not collide (uniqueness is per proposer).
    const otherProposer = await pendingProposal(duplicate.id, aunt.id, otherUser.id);
    await getTestDb().insert(familySettings).values({ id: true, rootPersonId: duplicate.id }).onConflictDoUpdate({ target: familySettings.id, set: { rootPersonId: duplicate.id } });

    const response = await app.inject({ method: "POST", url: `/api/admin/people/${keep.id}/merge`, payload: { duplicateId: duplicate.id }, ...adminAuth });
    expect(response.statusCode, response.body).toBe(200);
    expect(await proposal(moved.id)).toMatchObject({ status: "pending", fromPersonId: keep.id, toPersonId: uncle.id });
    expect(await proposal(otherProposer.id)).toMatchObject({ status: "pending", fromPersonId: keep.id, toPersonId: aunt.id });
    expect(await proposal(collapsed.id)).toMatchObject({ status: "withdrawn" });
    expect(await proposal(colliding.id)).toMatchObject({ status: "withdrawn" });
    expect((await withdrawAudits(colliding.id))[0]?.metadata).toMatchObject({ reason: "person_merged" });
    const [settings] = await getTestDb().select().from(familySettings);
    expect(settings?.rootPersonId).toBe(keep.id);
    const [mergeAudit] = await getTestDb()
      .select({ metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "person.merged"), eq(auditLogs.entityId, keep.id)));
    expect(mergeAudit?.metadata).toMatchObject({ proposalsRepointed: 2, proposalsWithdrawn: 2, tagsMoved: 0, rootMoved: true });

    // Undo (WP-6.0 decision 16): the duplicate is back, the proposals and the root stay on keep.
    const { revisionId } = response.json<PersonMergeResponse>();
    const undo = await app.inject({ method: "POST", url: `/api/admin/revisions/${revisionId}/revert`, ...adminAuth });
    expect(undo.statusCode, undo.body).toBe(200);
    expect(await getTestDb().select().from(people).where(eq(people.id, duplicate.id))).toHaveLength(1);
    expect(await proposal(moved.id)).toMatchObject({ status: "pending", fromPersonId: keep.id });
    expect(await proposal(collapsed.id)).toMatchObject({ status: "withdrawn" });
    const [after] = await getTestDb().select().from(familySettings);
    expect(after?.rootPersonId).toBe(keep.id);
  });

  it("a merge preview (dry run) changes no proposal", async () => {
    const keep = await insertPerson();
    const duplicate = await insertPerson();
    const child = await insertPerson();
    await insertParentOf(duplicate.id, child.id);
    const pending = await pendingProposal(duplicate.id, child.id, member.id, "relate");
    const response = await app.inject({ method: "GET", url: `/api/admin/people/${keep.id}/merge-preview?duplicateId=${duplicate.id}`, ...adminAuth });
    expect(response.statusCode).toBe(200);
    expect(await proposal(pending.id)).toMatchObject({ status: "pending", fromPersonId: duplicate.id });
  });
});
