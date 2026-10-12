/**
 * WP-6.4 [SEC]: one family tree reads: root setting, extended bands
 * (tíos, primos, tíos abuelos), "Árbol completo" (overview + path) and the
 * admin "Ramas sin conectar" report, with the ADR 0001 §6 privacy rules.
 * Fictional people only.
 */
import type {
  DisconnectedBranchReport,
  ExtendedFamily,
  FamilySettings,
  TreeLinkProposal,
  TreeOverview,
  TreeOverviewPath
} from "@cuencada/types";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { type AuthInjectOptions, createUser, loginAs, type TestUser } from "../../../test/helpers/factories.js";
import { insertParentOf, insertPartnerOf, insertPerson } from "../../../test/helpers/family.js";
import type { App } from "../../app.js";
import { auditLogs, familySettings, people } from "../../db/schema/index.js";

const MISSING_ID = "00000000-0000-4000-8000-000000000000";

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

async function get<T>(url: string, auth: AuthInjectOptions = memberAuth): Promise<{ status: number; body: T }> {
  const response = await app.inject({ method: "GET", url, ...auth });
  return { status: response.statusCode, body: response.json<T>() };
}

async function setRoot(rootPersonId: string | null) {
  return app.inject({ method: "PUT", url: "/api/admin/family/settings", payload: { rootPersonId }, ...adminAuth });
}

/**
 * Bisabuelo + Bisabuela → Abuelo (+ Abuela) and Tío abuelo Teo.
 * Abuelo + Abuela → Papá, Tía Inés (partner: Tío político Luis).
 * Papá → Yo (linked to the member), Hermana. Tía Inés → Primo Andrés, Prima Sara.
 */
async function family() {
  const bisabuelo = await insertPerson({ fullName: "Bisabuelo Ramón Ejemplo", deceased: true, birthYear: 1900, deathYear: 1970 });
  const bisabuela = await insertPerson({ fullName: "Bisabuela Elena Vega", deceased: true });
  const abuelo = await insertPerson({ fullName: "Abuelo Ramiro Ejemplo", deceased: true, birthYear: 1930, deathYear: 2001 });
  const abuela = await insertPerson({ fullName: "Abuela Rosa Muestra", birthYear: 1934 });
  const tioAbuelo = await insertPerson({ fullName: "Tío abuelo Teo Ejemplo" });
  const papa = await insertPerson({ fullName: "Papá Jorge Ejemplo", birthYear: 1960 });
  const tia = await insertPerson({ fullName: "Tía Inés Ejemplo", birthYear: 1962 });
  const tioPolitico = await insertPerson({ fullName: "Tío político Luis Ficticio" });
  const yo = await insertPerson({ fullName: "Lucía Ejemplo", userId: member.id, birthYear: 1990 });
  const hermana = await insertPerson({ fullName: "Hermana Clara Ejemplo", birthYear: 1993 });
  const primo = await insertPerson({ fullName: "Primo Andrés Ejemplo", birthYear: 1991 });
  const prima = await insertPerson({ fullName: "Prima Sara Ejemplo", birthYear: 1995 });
  await insertParentOf(bisabuelo.id, abuelo.id);
  await insertParentOf(bisabuela.id, abuelo.id);
  await insertPartnerOf(bisabuelo.id, bisabuela.id);
  await insertParentOf(bisabuelo.id, tioAbuelo.id);
  await insertPartnerOf(abuelo.id, abuela.id);
  await insertParentOf(abuelo.id, papa.id);
  await insertParentOf(abuela.id, papa.id);
  // Tía Inés is recorded on the grandmother only: still a tía, and still in the outline (the couple's child).
  await insertParentOf(abuela.id, tia.id);
  await insertPartnerOf(tia.id, tioPolitico.id);
  await insertParentOf(papa.id, yo.id);
  await insertParentOf(papa.id, hermana.id);
  await insertParentOf(tia.id, primo.id);
  await insertParentOf(tia.id, prima.id);
  return { bisabuelo, bisabuela, abuelo, abuela, tioAbuelo, papa, tia, tioPolitico, yo, hermana, primo, prima };
}

describe("family settings", () => {
  it("reads 'no root' when the row is missing, upserts on PUT (audited) and validates the person", async () => {
    await getTestDb().delete(familySettings);
    expect((await get<FamilySettings>("/api/family/settings")).body).toEqual({ root: null, updatedAt: null });
    const root = await insertPerson({ fullName: "Bisabuelo Ramón Ejemplo" });
    const saved = await setRoot(root.id);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json<FamilySettings>().root?.id).toBe(root.id);
    const read = await get<FamilySettings>("/api/family/settings");
    expect(read.body.root?.fullName).toBe("Bisabuelo Ramón Ejemplo");
    expect(read.body.updatedAt).not.toBeNull();
    const audits = await getTestDb().select().from(auditLogs).where(eq(auditLogs.action, "family_settings.updated"));
    expect(audits[0]?.metadata).toEqual({ rootPersonId: root.id });

    expect((await setRoot(MISSING_ID)).statusCode).toBe(400);
    expect((await setRoot(null)).json<FamilySettings>().root).toBeNull();
    expect((await get<FamilySettings>("/api/admin/family/settings", adminAuth)).body.root).toBeNull();
  });

  it("deleting the root person clears it (SET NULL)", async () => {
    const root = await insertPerson();
    await setRoot(root.id);
    await app.inject({ method: "DELETE", url: `/api/admin/people/${root.id}`, ...adminAuth });
    expect((await get<FamilySettings>("/api/family/settings")).body.root).toBeNull();
  });
});

describe("GET /api/family/tree/extended", () => {
  it("computes tíos (with partners), primos and tíos abuelos for the caller by default", async () => {
    const f = await family();
    const { status, body } = await get<ExtendedFamily>("/api/family/tree/extended");
    expect(status).toBe(200);
    expect(body.focusId).toBe(f.yo.id);
    expect(body.tios.map((person) => person.id).sort()).toEqual([f.tia.id, f.tioPolitico.id].sort());
    expect(body.primos.map((person) => person.id).sort()).toEqual([f.primo.id, f.prima.id].sort());
    expect(body.tiosAbuelos.map((person) => person.id)).toEqual([f.tioAbuelo.id]);
    expect(body.truncated).toBe(false);
    // Summaries only: no years, no branch.
    expect(JSON.stringify(body)).not.toContain("1991");

    const forPrimo = await get<ExtendedFamily>(`/api/family/tree/extended?personId=${f.primo.id}`);
    expect(forPrimo.body.tios.map((person) => person.id)).toEqual([f.papa.id]);
    expect(forPrimo.body.primos.map((person) => person.id).sort()).toEqual([f.yo.id, f.hermana.id].sort());
  });

  it("answers 404 for an unknown person and for a caller without a person", async () => {
    expect((await get(`/api/family/tree/extended?personId=${MISSING_ID}`)).status).toBe(404);
    expect((await get("/api/family/tree/extended")).status).toBe(404);
    expect((await get("/api/family/tree/extended?personId=nope")).status).toBe(400);
  });

  it("terminates on corrupt, cyclic data", async () => {
    const a = await insertPerson();
    const b = await insertPerson();
    await insertParentOf(a.id, b.id);
    await insertParentOf(b.id, a.id);
    const { status } = await get<ExtendedFamily>(`/api/family/tree/extended?personId=${a.id}`);
    expect(status).toBe(200);
  });
});

describe("GET /api/family/overview", () => {
  it("returns an empty outline without a root, with viewerConnected null", async () => {
    await getTestDb().delete(familySettings);
    const { body } = await get<TreeOverview>("/api/family/overview");
    expect(body).toEqual({ rootId: null, nodes: [], viewerConnected: null });
  });

  it("outlines descendants from the root, names only, with privacy-filtered years and lazy paging", async () => {
    const f = await family();
    await setRoot(f.bisabuelo.id);
    const { status, body } = await get<TreeOverview>("/api/family/overview?depth=2");
    expect(status).toBe(200);
    expect(body.rootId).toBe(f.bisabuelo.id);
    expect(body.viewerConnected).toBe(true);
    const ids = body.nodes.map((node) => node.id);
    expect(ids[0]).toBe(f.bisabuelo.id);
    // Generation 1: Abuelo and Tío abuelo; generation 2: Papá and Tía Inés (the couple's children).
    expect(new Set(ids)).toEqual(new Set([f.bisabuelo.id, f.abuelo.id, f.tioAbuelo.id, f.papa.id, f.tia.id]));
    expect(ids.indexOf(f.abuelo.id)).toBeLessThan(ids.indexOf(f.papa.id));
    const root = body.nodes[0];
    expect(root).toMatchObject({ parentId: null, birthYear: 1900, deathYear: 1970, deceased: true, childrenCount: 2, hasMore: false });
    expect(root?.partners).toEqual([{ id: f.bisabuela.id, name: "Bisabuela Elena Vega" }]);
    const abuelo = body.nodes.find((node) => node.id === f.abuelo.id);
    expect(abuelo).toMatchObject({ parentId: f.bisabuelo.id, childrenCount: 2, hasMore: false });
    const papa = body.nodes.find((node) => node.id === f.papa.id);
    expect(papa).toMatchObject({ parentId: f.abuelo.id, childrenCount: 2, hasMore: true });
    // Papá is in the member's circle (their parent): living year visible. Tía Inés is not: hidden.
    expect(papa?.birthYear).toBe(1960);
    expect(body.nodes.find((node) => node.id === f.tia.id)?.birthYear).toBeNull();
    // [SEC] Names only: no photo or account fields.
    for (const node of body.nodes) {
      expect(Object.keys(node).sort()).toEqual(["birthYear", "childrenCount", "deathYear", "deceased", "hasMore", "id", "name", "nickname", "parentId", "partners"]);
    }

    // Lazy: the next generation under Papá.
    const more = await get<TreeOverview>(`/api/family/overview?personId=${f.papa.id}&depth=1`);
    expect(more.body.nodes.map((node) => node.id).sort()).toEqual([f.papa.id, f.yo.id, f.hermana.id].sort());
    expect(more.body.nodes.find((node) => node.id === f.yo.id)?.birthYear).toBe(1990);

    // An admin sees every year.
    const asAdmin = await get<TreeOverview>("/api/family/overview?depth=2", adminAuth);
    expect(asAdmin.body.nodes.find((node) => node.id === f.tia.id)?.birthYear).toBe(1962);
    expect(asAdmin.body.viewerConnected).toBeNull();
  });

  it("validates depth and answers 404 for an unknown start", async () => {
    expect((await get("/api/family/overview?depth=4")).status).toBe(400);
    expect((await get(`/api/family/overview?personId=${MISSING_ID}`)).status).toBe(404);
  });

  it("reports viewerConnected false for a member in a disconnected branch", async () => {
    const root = await insertPerson();
    const child = await insertPerson();
    await insertParentOf(root.id, child.id);
    await insertPerson({ userId: member.id });
    await setRoot(root.id);
    expect((await get<TreeOverview>("/api/family/overview")).body.viewerConnected).toBe(false);
  });
});

describe("GET /api/family/overview/path", () => {
  it("returns the outline path from the root (empty when not in it)", async () => {
    const f = await family();
    await setRoot(f.bisabuelo.id);
    expect((await get<TreeOverviewPath>(`/api/family/overview/path?personId=${f.prima.id}`)).body.ids).toEqual([
      f.bisabuelo.id,
      f.abuelo.id,
      f.tia.id,
      f.prima.id
    ]);
    expect((await get<TreeOverviewPath>(`/api/family/overview/path?personId=${f.bisabuelo.id}`)).body.ids).toEqual([f.bisabuelo.id]);
    const stranger = await insertPerson();
    expect((await get<TreeOverviewPath>(`/api/family/overview/path?personId=${stranger.id}`)).body.ids).toEqual([]);
    expect((await get("/api/family/overview/path")).status).toBe(400);
  });
});

describe("GET /api/admin/family/branches", () => {
  it("lists components the root cannot reach, with matches and no account ids; approving the proposal clears it", async () => {
    const f = await family();
    await setRoot(f.bisabuelo.id);
    // A cousin's branch: their own copy of the grandfather, partner and child.
    const cousin = await createUser({ emailVerified: true, displayName: "Primo Carlos Vega" });
    const cousinAuth = await loginAs(app, cousin);
    const copy = await insertPerson({ fullName: "Abuelo Ramiro Ejemplo", nickname: "Ramiro", birthYear: 1931 });
    const copyPartner = await insertPerson({ fullName: "Abuela Rosa Muestra" });
    const cousinParent = await insertPerson({ fullName: "Tío Pablo Ejemplo" });
    const cousinSelf = await insertPerson({ fullName: "Primo Carlos Vega", userId: cousin.id });
    await insertPartnerOf(copy.id, copyPartner.id);
    await insertParentOf(copy.id, cousinParent.id);
    await insertParentOf(cousinParent.id, cousinSelf.id);
    await insertPerson({ fullName: "Persona Suelta" });

    const { status, body } = await get<DisconnectedBranchReport>("/api/admin/family/branches", adminAuth);
    expect(status).toBe(200);
    expect(body.rootPersonId).toBe(f.bisabuelo.id);
    expect(body.items).toHaveLength(1);
    const [branch] = body.items;
    expect(branch).toMatchObject({ size: 4, linkedAccounts: 1 });
    expect(branch?.people[0]?.id).toBe(copy.id);
    // Both copies (grandfather and grandmother) match their originals, with the partner signal.
    expect(branch?.suggestedMatches.map((match) => [match.person.id, match.candidate.id])).toEqual(
      expect.arrayContaining([
        [copy.id, f.abuelo.id],
        [copyPartner.id, f.abuela.id]
      ])
    );
    const best = branch?.suggestedMatches.find((match) => match.person.id === copy.id);
    expect(best?.candidate.id).toBe(f.abuelo.id);
    expect(best?.reasons).toEqual(expect.arrayContaining(["same_name", "same_partner"]));
    expect(best?.score).toBeGreaterThanOrEqual(90);
    // [SEC] no account ids anywhere in the report.
    expect(JSON.stringify(body)).not.toContain(cousin.id);
    expect(JSON.stringify(body)).not.toContain(member.id);

    const singles = await get<DisconnectedBranchReport>("/api/admin/family/branches?includeSingles=true", adminAuth);
    expect(singles.body.items).toHaveLength(2);

    // The cousin is not connected to the root: the CTA's signal.
    expect((await get<TreeOverview>("/api/family/overview", cousinAuth)).body.viewerConnected).toBe(false);

    // The cousin proposes "Es la misma persona"; the admin approves (merge keeps the root's copy).
    const proposed = await app.inject({
      method: "POST",
      url: "/api/family/proposals",
      payload: { kind: "same_person", fromPersonId: copy.id, toPersonId: f.abuelo.id, note: "Es mi abuelo" },
      ...cousinAuth
    });
    expect(proposed.statusCode, proposed.body).toBe(201);
    const resolved = await app.inject({
      method: "POST",
      url: `/api/admin/family/proposals/${proposed.json<TreeLinkProposal>().id}/resolve`,
      payload: { decision: "approve" },
      ...adminAuth
    });
    expect(resolved.statusCode, resolved.body).toBe(200);

    expect((await get<DisconnectedBranchReport>("/api/admin/family/branches", adminAuth)).body.items).toEqual([]);
    expect((await get<TreeOverview>("/api/family/overview", cousinAuth)).body.viewerConnected).toBe(true);
    const extended = await get<ExtendedFamily>("/api/family/tree/extended", cousinAuth);
    // Carlos's primos now include Lucía and her sister (Papá is his tío, over the grandfather he now shares).
    expect(extended.body.primos.map((person) => person.id).sort()).toEqual([f.yo.id, f.hermana.id].sort());
    expect(extended.body.tios.map((person) => person.id)).toEqual([f.papa.id]);
    expect(await getTestDb().select().from(people).where(eq(people.id, copy.id))).toHaveLength(0);
  });

  it("without a root lists every component but the largest", async () => {
    await getTestDb().delete(familySettings);
    const a = await insertPerson();
    const b = await insertPerson();
    const c = await insertPerson();
    await insertParentOf(a.id, b.id);
    await insertParentOf(b.id, c.id);
    const d = await insertPerson();
    const e = await insertPerson();
    await insertPartnerOf(d.id, e.id);
    const { body } = await get<DisconnectedBranchReport>("/api/admin/family/branches", adminAuth);
    expect(body.rootPersonId).toBeNull();
    expect(body.items.map((item) => item.size)).toEqual([2]);
    expect((await get("/api/admin/family/branches?cursor=bad", adminAuth)).status).toBe(400);
  });

  it("pages largest first", async () => {
    await getTestDb().delete(familySettings);
    for (let size = 2; size <= 4; size += 1) {
      let previous = await insertPerson();
      for (let index = 1; index < size; index += 1) {
        const next = await insertPerson();
        await insertParentOf(previous.id, next.id);
        previous = next;
      }
    }
    const big = await insertPerson();
    let previous = big;
    for (let index = 0; index < 5; index += 1) {
      const next = await insertPerson();
      await insertParentOf(previous.id, next.id);
      previous = next;
    }
    const first = await get<DisconnectedBranchReport>("/api/admin/family/branches?limit=2", adminAuth);
    expect(first.body.items.map((item) => item.size)).toEqual([4, 3]);
    expect(first.body.nextCursor).not.toBeNull();
    const second = await get<DisconnectedBranchReport>(`/api/admin/family/branches?limit=2&cursor=${first.body.nextCursor ?? ""}`, adminAuth);
    expect(second.body.items.map((item) => item.size)).toEqual([2]);
    expect(second.body.nextCursor).toBeNull();
  });
});
