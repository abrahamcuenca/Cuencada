/**
 * WP-6.4 [SEC]: tree-link proposals (ADR 0001 §8). Members propose "Es la
 * misma persona" / "Conectar con…"; only the proposer and admins read a
 * proposal; admins approve (merge or edge, same transaction) or reject.
 * Fictional people only.
 */
import type { ApiError, Page, TreeLinkProposal, TreeLinkProposalGroup } from "@cuencada/types";
import { and, eq, or } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { type AuthInjectOptions, createUser, loginAs, type TestUser } from "../../../test/helpers/factories.js";
import { insertParentOf, insertPartnerOf, insertPerson } from "../../../test/helpers/family.js";
import type { App } from "../../app.js";
import { auditLogs, people, personRelationships, treeLinkProposals } from "../../db/schema/index.js";

const MISSING_ID = "00000000-0000-4000-8000-000000000000";

let app: App;
let logLines: string[];
let admin: TestUser;
let adminAuth: AuthInjectOptions;
let member: TestUser;
let memberAuth: AuthInjectOptions;
let other: TestUser;
let otherAuth: AuthInjectOptions;

beforeEach(async () => {
  logLines = [];
  app = await createTestApp({ logStream: { write: (line) => logLines.push(line) } });
  admin = await createUser({ role: "admin", emailVerified: true, displayName: "Octavio Admin" });
  adminAuth = await loginAs(app, admin);
  member = await createUser({ emailVerified: true, displayName: "Lucía Ejemplo" });
  memberAuth = await loginAs(app, member);
  other = await createUser({ emailVerified: true, displayName: "Mario Muestra" });
  otherAuth = await loginAs(app, other);
});

afterEach(async () => {
  await app.close();
});

type Method = "GET" | "POST" | "PUT" | "DELETE";

async function call(method: Method, url: string, auth: AuthInjectOptions, payload?: Record<string, unknown>) {
  return app.inject({ method, url, ...(payload === undefined ? {} : { payload }), ...auth });
}

const propose = (payload: Record<string, unknown>, auth: AuthInjectOptions = memberAuth) => call("POST", "/api/family/proposals", auth, payload);
const resolve = (id: string, payload: Record<string, unknown>) => call("POST", `/api/admin/family/proposals/${id}/resolve`, adminAuth, payload);

function errorOf(response: { body: string }): ApiError["error"] {
  return (JSON.parse(response.body) as ApiError).error;
}

async function proposalRow(id: string) {
  const [row] = await getTestDb().select().from(treeLinkProposals).where(eq(treeLinkProposals.id, id));
  return row;
}

/** Two copies of "Abuelo" in two disconnected branches: the root's and a cousin's. */
async function abueloPair() {
  const keep = await insertPerson({ fullName: "Abuelo Ramiro Ejemplo", birthYear: 1930, deceased: true, deathYear: 2001 });
  const duplicate = await insertPerson({ fullName: "Abuelo Ramiro Ejemplo", birthYear: 1930 });
  return { keep, duplicate };
}

describe("POST /api/family/proposals", () => {
  it("creates a pending same_person proposal (201) with current names, audited without the note", async () => {
    const { keep, duplicate } = await abueloPair();
    const response = await propose({ kind: "same_person", fromPersonId: duplicate.id, toPersonId: keep.id, note: "Es mi abuelo, el mismo de la Rama Norte." });
    expect(response.statusCode, response.body).toBe(201);
    const proposal = response.json<TreeLinkProposal>();
    expect(proposal).toMatchObject({
      kind: "same_person",
      status: "pending",
      relation: null,
      isMine: true,
      proposedByName: "Lucía Ejemplo",
      note: "Es mi abuelo, el mismo de la Rama Norte.",
      resolvedAt: null,
      resolutionNote: null
    });
    expect(proposal.from?.id).toBe(duplicate.id);
    expect(proposal.to?.fullName).toBe("Abuelo Ramiro Ejemplo");

    const audits = await getTestDb().select().from(auditLogs).where(eq(auditLogs.entityId, proposal.id));
    expect(audits.map((row) => row.action)).toEqual(["tree_proposal.created"]);
    expect(JSON.stringify(audits)).not.toContain("Rama Norte");
    expect(logLines.join("\n")).not.toContain("Rama Norte");
  });

  it("creates a relate proposal and answers 400 for invalid input", async () => {
    const parent = await insertPerson();
    const child = await insertPerson();
    const ok = await propose({ kind: "relate", relation: "parent_of", fromPersonId: parent.id, toPersonId: child.id });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json<TreeLinkProposal>().relation).toBe("parent_of");

    for (const payload of [
      { kind: "relate", fromPersonId: parent.id, toPersonId: child.id },
      { kind: "same_person", relation: "partner_of", fromPersonId: parent.id, toPersonId: child.id },
      { kind: "same_person", fromPersonId: parent.id, toPersonId: parent.id },
      { kind: "other", fromPersonId: parent.id, toPersonId: child.id },
      { kind: "same_person", fromPersonId: parent.id, toPersonId: child.id, note: "x".repeat(501) },
      { kind: "same_person", fromPersonId: parent.id, toPersonId: child.id, extra: true }
    ]) {
      const response = await propose(payload);
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it("answers 404 when a person does not exist", async () => {
    const person = await insertPerson();
    const response = await propose({ kind: "same_person", fromPersonId: person.id, toPersonId: MISSING_ID });
    expect(response.statusCode).toBe(404);
    expect(await getTestDb().select().from(treeLinkProposals)).toHaveLength(0);
  });

  it("answers 409 PROPOSAL_DUPLICATE only for the caller's own pending pair (either order, any kind)", async () => {
    const { keep, duplicate } = await abueloPair();
    expect((await propose({ kind: "same_person", fromPersonId: duplicate.id, toPersonId: keep.id })).statusCode).toBe(201);
    const again = await propose({ kind: "relate", relation: "partner_of", fromPersonId: keep.id, toPersonId: duplicate.id });
    expect(again.statusCode).toBe(409);
    expect(errorOf(again).details?.[0]).toMatchObject({ path: "proposal", code: "PROPOSAL_DUPLICATE" });
    // Another member proposing the same pair is neither blocked nor told anything.
    const theirs = await propose({ kind: "same_person", fromPersonId: keep.id, toPersonId: duplicate.id }, otherAuth);
    expect(theirs.statusCode, theirs.body).toBe(201);
    expect(theirs.json<TreeLinkProposal>().isMine).toBe(true);
  });

  it("allows 20 proposals per member per rolling day under the lock (429 after), admins exempt", async () => {
    const people_ = await Promise.all(Array.from({ length: 23 }, () => insertPerson()));
    const anchor = people_[0];
    if (anchor === undefined) throw new Error("no anchor");
    // Two old proposals (outside the window) do not count.
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    for (const person of people_.slice(1, 3)) {
      await getTestDb()
        .insert(treeLinkProposals)
        .values({ kind: "same_person", fromPersonId: anchor.id, toPersonId: person.id, proposedByUserId: member.id, status: "withdrawn", resolvedAt: old, createdAt: old });
    }
    for (const person of people_.slice(3, 23)) {
      const response = await propose({ kind: "same_person", fromPersonId: anchor.id, toPersonId: person.id });
      expect(response.statusCode, response.body).toBe(201);
    }
    const extra = await insertPerson();
    const limited = await propose({ kind: "same_person", fromPersonId: anchor.id, toPersonId: extra.id });
    expect(limited.statusCode).toBe(429);
    expect(errorOf(limited).code).toBe("RATE_LIMITED");
    // Concurrent attempts past the limit all fail (the count runs under a per-user lock).
    const burst = await Promise.all([1, 2, 3].map(async () => propose({ kind: "same_person", fromPersonId: extra.id, toPersonId: anchor.id })));
    expect(burst.map((response) => response.statusCode)).toEqual([429, 429, 429]);

    const adminProposal = await propose({ kind: "same_person", fromPersonId: anchor.id, toPersonId: extra.id }, adminAuth);
    expect(adminProposal.statusCode).toBe(201);
  });
});

describe("member reads and withdraw", () => {
  it("lists only the caller's own proposals; another member's is 404 to withdraw", async () => {
    const { keep, duplicate } = await abueloPair();
    const mine = (await propose({ kind: "same_person", fromPersonId: duplicate.id, toPersonId: keep.id, note: "Nota privada" })).json<TreeLinkProposal>();
    await propose({ kind: "same_person", fromPersonId: duplicate.id, toPersonId: keep.id, note: "Nota de Mario" }, otherAuth);

    const list = (await call("GET", "/api/family/proposals", memberAuth)).json<Page<TreeLinkProposal>>();
    expect(list.items.map((item) => item.id)).toEqual([mine.id]);
    expect(JSON.stringify(list)).not.toContain("Nota de Mario");
    expect(JSON.stringify(list)).not.toContain("Mario Muestra");

    const stolen = await call("DELETE", `/api/family/proposals/${mine.id}`, otherAuth);
    expect(stolen.statusCode).toBe(404);
    expect((await proposalRow(mine.id))?.status).toBe("pending");
    expect((await call("DELETE", `/api/family/proposals/${MISSING_ID}`, memberAuth)).statusCode).toBe(404);

    const withdrawn = await call("DELETE", `/api/family/proposals/${mine.id}`, memberAuth);
    expect(withdrawn.statusCode).toBe(204);
    expect(await proposalRow(mine.id)).toMatchObject({ status: "withdrawn", resolvedByUserId: null });
    const twice = await call("DELETE", `/api/family/proposals/${mine.id}`, memberAuth);
    expect(twice.statusCode).toBe(409);
    expect(errorOf(twice).details?.[0]?.code).toBe("PROPOSAL_NOT_PENDING");
    const audits = await getTestDb().select().from(auditLogs).where(eq(auditLogs.entityId, mine.id));
    expect(audits.find((row) => row.action === "tree_proposal.withdrawn")?.metadata).toEqual({ reason: "proposer" });
  });

  it("filters by status and pages newest first", async () => {
    const anchor = await insertPerson();
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const person = await insertPerson();
      ids.push((await propose({ kind: "same_person", fromPersonId: anchor.id, toPersonId: person.id })).json<TreeLinkProposal>().id);
    }
    const first = (await call("GET", "/api/family/proposals?limit=2", memberAuth)).json<Page<TreeLinkProposal>>();
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = (await call("GET", `/api/family/proposals?limit=2&cursor=${first.nextCursor ?? ""}`, memberAuth)).json<Page<TreeLinkProposal>>();
    expect([...first.items, ...second.items].map((item) => item.id).sort()).toEqual([...ids].sort());
    expect((await call("GET", "/api/family/proposals?cursor=nope", memberAuth)).statusCode).toBe(400);
    const rejected = (await call("GET", "/api/family/proposals?status=rejected", memberAuth)).json<Page<TreeLinkProposal>>();
    expect(rejected.items).toEqual([]);
  });

  it("shows people from the current rows, and a deleted one as null", async () => {
    const { keep, duplicate } = await abueloPair();
    const created = (await propose({ kind: "same_person", fromPersonId: duplicate.id, toPersonId: keep.id })).json<TreeLinkProposal>();
    await getTestDb().update(people).set({ fullName: "Ramiro Ejemplo Vega" }).where(eq(people.id, keep.id));
    const [renamed] = (await call("GET", "/api/family/proposals", memberAuth)).json<Page<TreeLinkProposal>>().items;
    expect(renamed?.to?.fullName).toBe("Ramiro Ejemplo Vega");

    expect((await call("DELETE", `/api/admin/people/${duplicate.id}`, adminAuth)).statusCode).toBe(204);
    const [after] = (await call("GET", "/api/family/proposals", memberAuth)).json<Page<TreeLinkProposal>>().items;
    expect(after).toMatchObject({ id: created.id, status: "withdrawn", from: null });
    expect(after?.to?.id).toBe(keep.id);
  });
});

describe("admin queue", () => {
  it("groups proposals by unordered pair, pending groups first", async () => {
    const { keep, duplicate } = await abueloPair();
    const a = await insertPerson();
    const b = await insertPerson();
    const p1 = (await propose({ kind: "same_person", fromPersonId: duplicate.id, toPersonId: keep.id })).json<TreeLinkProposal>();
    const p2 = (await propose({ kind: "same_person", fromPersonId: keep.id, toPersonId: duplicate.id }, otherAuth)).json<TreeLinkProposal>();
    const p3 = (await propose({ kind: "relate", relation: "partner_of", fromPersonId: a.id, toPersonId: b.id })).json<TreeLinkProposal>();
    await call("DELETE", `/api/family/proposals/${p3.id}`, memberAuth);

    const page = (await call("GET", "/api/admin/family/proposals", adminAuth)).json<Page<TreeLinkProposalGroup>>();
    expect(page.items).toHaveLength(2);
    const [first, second] = page.items;
    expect(first?.proposals.map((proposal) => proposal.id).sort()).toEqual([p1.id, p2.id].sort());
    expect(first?.pairKey).toBe([keep.id, duplicate.id].sort().join(":"));
    expect(second?.proposals.map((proposal) => proposal.id)).toEqual([p3.id]);
    expect(first?.proposals.every((proposal) => !proposal.isMine)).toBe(true);

    const pending = (await call("GET", "/api/admin/family/proposals?status=pending&limit=1", adminAuth)).json<Page<TreeLinkProposalGroup>>();
    expect(pending.items).toHaveLength(1);
    expect(pending.nextCursor).toBeNull();

    const one = await call("GET", `/api/admin/family/proposals/${p1.id}`, adminAuth);
    expect(one.statusCode).toBe(200);
    expect(one.json<TreeLinkProposal>().proposedByName).toBe("Lucía Ejemplo");
    expect((await call("GET", `/api/admin/family/proposals/${MISSING_ID}`, adminAuth)).statusCode).toBe(404);
  });
});

describe("POST /api/admin/family/proposals/:id/resolve", () => {
  it("rejects with a note shown to the proposer only (not in the audit), applying to the pair", async () => {
    const { keep, duplicate } = await abueloPair();
    const p1 = (await propose({ kind: "same_person", fromPersonId: duplicate.id, toPersonId: keep.id })).json<TreeLinkProposal>();
    const p2 = (await propose({ kind: "same_person", fromPersonId: keep.id, toPersonId: duplicate.id }, otherAuth)).json<TreeLinkProposal>();
    const response = await resolve(p1.id, { decision: "reject", note: "Son primos, no la misma persona." });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<TreeLinkProposal>()).toMatchObject({ status: "rejected", resolutionNote: "Son primos, no la misma persona.", resolvedByName: "Octavio Admin" });
    expect((await proposalRow(p2.id))?.status).toBe("rejected");
    const [mine] = (await call("GET", "/api/family/proposals", memberAuth)).json<Page<TreeLinkProposal>>().items;
    expect(mine?.resolutionNote).toBe("Son primos, no la misma persona.");
    const audits = await getTestDb().select().from(auditLogs).where(or(eq(auditLogs.entityId, p1.id), eq(auditLogs.entityId, p2.id)));
    expect(audits.filter((row) => row.action === "tree_proposal.rejected")).toHaveLength(2);
    expect(JSON.stringify(audits)).not.toContain("primos");
    expect(logLines.join("\n")).not.toContain("primos");

    const again = await resolve(p1.id, { decision: "approve" });
    expect(again.statusCode).toBe(409);
    expect(errorOf(again).details?.[0]?.code).toBe("PROPOSAL_NOT_PENDING");
    // Nothing merged.
    expect(await getTestDb().select().from(people).where(eq(people.id, duplicate.id))).toHaveLength(1);
  });

  it("approves a same_person proposal by merging (keep = to), in one transaction; the pair's other proposals follow", async () => {
    const { keep, duplicate } = await abueloPair();
    const cousinChild = await insertPerson({ fullName: "Primo Andrés Ejemplo" });
    await insertParentOf(duplicate.id, cousinChild.id);
    const p1 = (await propose({ kind: "same_person", fromPersonId: duplicate.id, toPersonId: keep.id })).json<TreeLinkProposal>();
    const p2 = (await propose({ kind: "same_person", fromPersonId: keep.id, toPersonId: duplicate.id }, otherAuth)).json<TreeLinkProposal>();

    const response = await resolve(p1.id, { decision: "approve", applyToPair: true });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<TreeLinkProposal>();
    expect(body).toMatchObject({ status: "approved", from: null });
    expect(body.to?.id).toBe(keep.id);
    expect(await getTestDb().select().from(people).where(eq(people.id, duplicate.id))).toHaveLength(0);
    const [edge] = await getTestDb().select().from(personRelationships).where(eq(personRelationships.toPersonId, cousinChild.id));
    expect(edge?.fromPersonId).toBe(keep.id);
    expect((await proposalRow(p2.id))?.status).toBe("approved");
    const audits = await getTestDb()
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, p1.id), eq(auditLogs.action, "tree_proposal.approved")));
    expect(audits[0]?.metadata).toMatchObject({ kind: "same_person", keepPersonId: keep.id, duplicatePersonId: duplicate.id });
  });

  it("keeps the chosen person and answers 400 for a keepPersonId outside the pair", async () => {
    const { keep, duplicate } = await abueloPair();
    const p1 = (await propose({ kind: "same_person", fromPersonId: duplicate.id, toPersonId: keep.id })).json<TreeLinkProposal>();
    const outside = await insertPerson();
    const bad = await resolve(p1.id, { decision: "approve", keepPersonId: outside.id });
    expect(bad.statusCode).toBe(400);
    expect((await proposalRow(p1.id))?.status).toBe("pending");
    const rejectWithKeep = await resolve(p1.id, { decision: "reject", keepPersonId: keep.id });
    expect(rejectWithKeep.statusCode).toBe(400);

    const ok = await resolve(p1.id, { decision: "approve", keepPersonId: duplicate.id, fields: { fullName: "keep" } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await getTestDb().select().from(people).where(eq(people.id, keep.id))).toHaveLength(0);
    expect(await getTestDb().select().from(people).where(eq(people.id, duplicate.id))).toHaveLength(1);
  });

  it("leaves the proposal pending when the merge conflicts (both linked → 409 MERGE_BOTH_LINKED)", async () => {
    const a = await insertPerson({ fullName: "Ana Morales Vega", userId: member.id });
    const b = await insertPerson({ fullName: "Ana Morales Vega", userId: other.id });
    const proposal = (await propose({ kind: "same_person", fromPersonId: a.id, toPersonId: b.id }, adminAuth)).json<TreeLinkProposal>();
    const response = await resolve(proposal.id, { decision: "approve" });
    expect(response.statusCode).toBe(409);
    expect(errorOf(response).details?.[0]?.code).toBe("MERGE_BOTH_LINKED");
    expect(await proposalRow(proposal.id)).toMatchObject({ status: "pending", resolvedAt: null, resolutionNote: null });
  });

  it("leaves the proposal pending when the merge's relationships conflict (409 MERGE_CONFLICT)", async () => {
    // keep is a parent of the duplicate's child's ancestor chain: moving the edge would make a cycle.
    const keep = await insertPerson({ fullName: "Bruno Ficticio" });
    const duplicate = await insertPerson({ fullName: "Bruno Ficticio" });
    const child = await insertPerson();
    await insertParentOf(child.id, keep.id);
    await insertParentOf(duplicate.id, child.id);
    const proposal = (await propose({ kind: "same_person", fromPersonId: duplicate.id, toPersonId: keep.id })).json<TreeLinkProposal>();
    const response = await resolve(proposal.id, { decision: "approve" });
    expect(response.statusCode).toBe(409);
    expect(errorOf(response).details?.[0]?.code).toBe("MERGE_CONFLICT");
    expect((await proposalRow(proposal.id))?.status).toBe("pending");
    expect(await getTestDb().select().from(people).where(eq(people.id, duplicate.id))).toHaveLength(1);
  });

  it("approves a relate proposal by creating the edge with admin provenance", async () => {
    const parent = await insertPerson({ fullName: "Abuela Rosa Muestra" });
    const child = await insertPerson({ fullName: "Tía Carmen Muestra" });
    const proposal = (await propose({ kind: "relate", relation: "parent_of", fromPersonId: parent.id, toPersonId: child.id })).json<TreeLinkProposal>();
    const response = await resolve(proposal.id, { decision: "approve" });
    expect(response.statusCode, response.body).toBe(200);
    const [edge] = await getTestDb()
      .select()
      .from(personRelationships)
      .where(and(eq(personRelationships.fromPersonId, parent.id), eq(personRelationships.toPersonId, child.id)));
    expect(edge).toMatchObject({ kind: "parent_of", createdByMember: false, createdByUserId: admin.id });
  });

  it("leaves a relate proposal pending on an edge conflict (cycle, existing edge)", async () => {
    const parent = await insertPerson();
    const child = await insertPerson();
    await insertParentOf(parent.id, child.id);
    const cycle = (await propose({ kind: "relate", relation: "parent_of", fromPersonId: child.id, toPersonId: parent.id })).json<TreeLinkProposal>();
    const response = await resolve(cycle.id, { decision: "approve" });
    expect(response.statusCode).toBe(409);
    expect((await proposalRow(cycle.id))?.status).toBe("pending");

    const a = await insertPerson();
    const b = await insertPerson();
    await insertPartnerOf(a.id, b.id);
    const existing = (await propose({ kind: "relate", relation: "partner_of", fromPersonId: b.id, toPersonId: a.id })).json<TreeLinkProposal>();
    expect((await resolve(existing.id, { decision: "approve" })).statusCode).toBe(409);
    expect((await proposalRow(existing.id))?.status).toBe("pending");
  });

  it("with applyToPair false resolves only that proposal; a different kind for the pair stays pending until the merge withdraws it", async () => {
    const { keep, duplicate } = await abueloPair();
    const p1 = (await propose({ kind: "same_person", fromPersonId: duplicate.id, toPersonId: keep.id })).json<TreeLinkProposal>();
    const p2 = (await propose({ kind: "same_person", fromPersonId: keep.id, toPersonId: duplicate.id }, otherAuth)).json<TreeLinkProposal>();
    expect((await resolve(p1.id, { decision: "reject", applyToPair: false })).statusCode).toBe(200);
    expect((await proposalRow(p2.id))?.status).toBe("pending");

    const third = await createUser({ emailVerified: true });
    const thirdAuth = await loginAs(app, third);
    const relate = (await propose({ kind: "relate", relation: "partner_of", fromPersonId: keep.id, toPersonId: duplicate.id }, thirdAuth)).json<TreeLinkProposal>();
    expect((await resolve(p2.id, { decision: "approve" })).statusCode).toBe(200);
    // keep↔duplicate collapsed by the merge: withdrawn, never pointing at nobody.
    expect(await proposalRow(relate.id)).toMatchObject({ status: "withdrawn" });
  });

  it("answers 404 for an unknown proposal", async () => {
    expect((await resolve(MISSING_ID, { decision: "reject" })).statusCode).toBe(404);
  });
});
