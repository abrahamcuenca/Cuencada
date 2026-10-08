import type { ApiError, FamilyTreeView, Page, Person, PersonSummary } from "@cuencada/types";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { type AuthInjectOptions, createUser, loginAs, type TestUser } from "../../../test/helpers/factories.js";
import {
  insertLineage,
  insertParentOf,
  insertPartnerOf,
  insertPerson
} from "../../../test/helpers/family.js";
import type { App } from "../../app.js";
import { auditLogs, people, profiles } from "../../db/schema/index.js";

const PERSON_KEYS = [
  "avatarUrl",
  "bio",
  "birthDate",
  "birthYear",
  "birthplace",
  "deathDate",
  "deathYear",
  "deceased",
  "familyBranch",
  "fullName",
  "id",
  "nickname",
  "userId"
];
const DETAIL_KEYS = [
  ...PERSON_KEYS,
  "canAddRelative",
  "canDelete",
  "canEdit",
  "canEditPhoto",
  "contacts",
  "isLinked",
  "photoSource",
  "photoUrl"
].sort();
const SUMMARY_KEYS = ["avatarUrl", "deceased", "fullName", "id", "nickname", "userId"];

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

function names(list: PersonSummary[]): string[] {
  return list.map((person) => person.fullName);
}

async function getTree(query: string, auth: AuthInjectOptions = memberAuth): Promise<FamilyTreeView> {
  const response = await app.inject({ method: "GET", url: `/api/family/tree${query}`, ...auth });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<FamilyTreeView>();
}

describe("verified-email gate", () => {
  it("answers 401 without a token and 403 for an unverified member on every member route", async () => {
    const unverified = await createUser({ emailVerified: false });
    await insertPerson({ userId: unverified.id });
    const unverifiedAuth = await loginAs(app, unverified);
    const person = await insertPerson();
    const routes = [
      { method: "GET" as const, url: "/api/family/people" },
      { method: "GET" as const, url: `/api/family/people/${person.id}` },
      { method: "GET" as const, url: "/api/family/tree" },
      { method: "PATCH" as const, url: "/api/family/me", payload: { nickname: "x" } },
      { method: "PATCH" as const, url: "/api/family/people/me", payload: { nickname: "x" } }
    ];
    for (const route of routes) {
      const anonymous = await app.inject(route);
      expect(anonymous.statusCode, route.url).toBe(401);
      const forbidden = await app.inject({ ...route, ...unverifiedAuth });
      expect(forbidden.statusCode, route.url).toBe(403);
      expect(forbidden.json<ApiError>().error.code).toBe("EMAIL_UNVERIFIED");
    }
  });
});

describe("GET /api/family/people", () => {
  it("searches name, nickname and branch case-insensitively and pages by name", async () => {
    await insertPerson({ fullName: "Ana Morales" });
    await insertPerson({ fullName: "Beto Pérez", nickname: "El Morales Chico" });
    await insertPerson({ fullName: "Carla Ruiz", familyBranch: "Rama MORALES Mérida" });
    await insertPerson({ fullName: "Dora Sosa" });

    const collected: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = cursor === null ? "?q=morales&limit=2" : `?q=morales&limit=2&cursor=${cursor}`;
      const response = await app.inject({ method: "GET", url: `/api/family/people${query}`, ...memberAuth });
      expect(response.statusCode).toBe(200);
      const page = response.json<Page<PersonSummary>>();
      for (const item of page.items) expect(Object.keys(item).sort()).toEqual(SUMMARY_KEYS);
      collected.push(...names(page.items));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 5);

    expect(collected).toEqual(["Ana Morales", "Beto Pérez", "Carla Ruiz"]);
    expect(pages).toBe(2);
  });

  it("treats LIKE wildcards literally and keeps names out of the cursor", async () => {
    await insertPerson({ fullName: "Ana" });
    await insertPerson({ fullName: "Cien % Real" });
    await insertPerson({ fullName: "Beto" });

    const percent = await app.inject({ method: "GET", url: "/api/family/people?q=%25", ...memberAuth });
    expect(names(percent.json<Page<PersonSummary>>().items)).toEqual(["Cien % Real"]);
    const underscore = await app.inject({ method: "GET", url: "/api/family/people?q=_", ...memberAuth });
    expect(underscore.json<Page<PersonSummary>>().items).toEqual([]);

    const all = await app.inject({ method: "GET", url: "/api/family/people?limit=1", ...memberAuth });
    const page = all.json<Page<PersonSummary>>();
    expect(names(page.items)).toEqual(["Ana"]);
    expect(page.nextCursor).not.toBeNull();
    expect(Buffer.from(page.nextCursor ?? "", "base64url").toString("utf8")).not.toContain("Ana");
  });

  it("answers 400 for a malformed cursor or an out-of-range limit", async () => {
    for (const query of ["?cursor=bm9wZQ", `?cursor=${Buffer.from('["x"]').toString("base64url")}`, "?limit=1000", "?limit=0"]) {
      const response = await app.inject({ method: "GET", url: `/api/family/people${query}`, ...memberAuth });
      expect(response.statusCode, query).toBe(400);
      expect(response.json<ApiError>().error.code).toBe("VALIDATION");
    }
  });
});

describe("GET /api/family/people/:id (privacy)", () => {
  async function getPerson(id: string, auth: AuthInjectOptions = memberAuth): Promise<Person> {
    const response = await app.inject({ method: "GET", url: `/api/family/people/${id}`, ...auth });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<Person>();
    expect(Object.keys(body).sort()).toEqual(DETAIL_KEYS);
    return body;
  }

  it("hides the birth year of living people linked to another account, but not from that account or admins", async () => {
    const other = await createUser({ emailVerified: true });
    const linked = await insertPerson({ fullName: "Vivo Vinculado", userId: other.id, birthYear: 1980 });

    expect(await getPerson(linked.id)).toMatchObject({ birthYear: null, deathYear: null, userId: other.id });
    expect((await getPerson(linked.id, await loginAs(app, other))).birthYear).toBe(1980);
    const admin = await createUser({ role: "admin", emailVerified: true });
    expect((await getPerson(linked.id, await loginAs(app, admin))).birthYear).toBe(1980);
  });

  it("hides the birth year of living unlinked people from members, shows it to admins, and shows both years of deceased people", async () => {
    const child = await insertPerson({ fullName: "Niña", birthYear: 2015 });
    const deceased = await insertPerson({ fullName: "Bisabuelo", birthYear: 1901, deathYear: 1980, deceased: true });
    const deceasedLinked = await insertPerson({
      fullName: "Abuela",
      userId: (await createUser()).id,
      birthYear: 1930,
      deathYear: 2020,
      deceased: true
    });

    expect(await getPerson(child.id)).toMatchObject({ birthYear: null, deathYear: null, deceased: false, avatarUrl: null });
    const admin = await createUser({ role: "admin", emailVerified: true });
    expect((await getPerson(child.id, await loginAs(app, admin))).birthYear).toBe(2015);
    expect(await getPerson(deceased.id)).toMatchObject({ birthYear: 1901, deathYear: 1980, deceased: true });
    expect(await getPerson(deceasedLinked.id)).toMatchObject({ birthYear: 1930, deathYear: 2020 });
  });

  it("answers 404 for an unknown person and 400 for a malformed id", async () => {
    const missing = await app.inject({ method: "GET", url: "/api/family/people/00000000-0000-4000-8000-000000000000", ...memberAuth });
    expect(missing.statusCode).toBe(404);
    const malformed = await app.inject({ method: "GET", url: "/api/family/people/nope", ...memberAuth });
    expect(malformed.statusCode).toBe(400);
  });
});

describe("GET /api/family/tree", () => {
  it("centres on the caller's own person by default with parents, partners, children and full/half siblings", async () => {
    const me = await insertPerson({ fullName: "Yo", userId: member.id, birthYear: 1990 });
    const mom = await insertPerson({ fullName: "Mamá" });
    const dad = await insertPerson({ fullName: "Papá" });
    const sister = await insertPerson({ fullName: "Hermana" });
    const halfBrother = await insertPerson({ fullName: "Medio Hermano" });
    const partner = await insertPerson({ fullName: "Pareja" });
    const kid = await insertPerson({ fullName: "Hijo" });
    await insertParentOf(mom.id, me.id);
    await insertParentOf(dad.id, me.id);
    await insertParentOf(mom.id, sister.id);
    await insertParentOf(dad.id, sister.id);
    await insertParentOf(dad.id, halfBrother.id);
    await insertPartnerOf(partner.id, me.id);
    await insertParentOf(me.id, kid.id);
    await insertParentOf(partner.id, kid.id);

    const tree = await getTree("");
    expect(tree.focus).toMatchObject({ id: me.id, fullName: "Yo", birthYear: 1990 });
    expect(Object.keys(tree.focus).sort()).toEqual(PERSON_KEYS);
    expect(names(tree.parents)).toEqual(["Mamá", "Papá"]);
    expect(names(tree.partners)).toEqual(["Pareja"]);
    expect(names(tree.children)).toEqual(["Hijo"]);
    expect(names(tree.siblings)).toEqual(["Hermana", "Medio Hermano"]);
    expect(tree.depth).toBe(1);
    expect(tree.extended.people).toEqual([]);
    // Every edge between returned people, so admins can find ids to delete.
    expect(tree.extended.relationships).toHaveLength(8);
    for (const summary of [...tree.parents, ...tree.siblings]) expect(Object.keys(summary).sort()).toEqual(SUMMARY_KEYS);
  });

  it("walks a 6-generation line up and down up to the requested depth", async () => {
    const line = await insertLineage(6);
    const focus = line[2];
    if (focus === undefined) throw new Error("fixture");

    const one = await getTree(`?personId=${focus.id}`);
    expect(names(one.parents)).toEqual(["Gen 1"]);
    expect(names(one.children)).toEqual(["Gen 3"]);
    expect(one.extended.people).toEqual([]);

    const two = await getTree(`?personId=${focus.id}&depth=2`);
    expect(names(two.extended.people)).toEqual(["Gen 0", "Gen 4"]);

    const three = await getTree(`?personId=${focus.id}&depth=3`);
    expect(three.depth).toBe(3);
    expect(names(three.extended.people)).toEqual(["Gen 0", "Gen 4", "Gen 5"]);
    expect(three.extended.relationships).toHaveLength(5);
  });

  it("clamps the depth to 4 (FAMILY_TREE_MAX_DEPTH, WP-4.0) and rejects a depth below 1", async () => {
    const line = await insertLineage(6);
    const top = line[0];
    if (top === undefined) throw new Error("fixture");
    const clamped = await getTree(`?personId=${top.id}&depth=50`);
    expect(clamped.depth).toBe(4);
    expect(names(clamped.children)).toEqual(["Gen 1"]);
    expect(names(clamped.extended.people)).toEqual(["Gen 2", "Gen 3", "Gen 4"]);

    for (const depth of ["0", "-1", "1.5", "abc"]) {
      const response = await app.inject({ method: "GET", url: `/api/family/tree?personId=${top.id}&depth=${depth}`, ...memberAuth });
      expect(response.statusCode, depth).toBe(400);
    }
  });

  it("terminates on malicious cyclic data inserted behind the service", async () => {
    const a = await insertPerson({ fullName: "A" });
    const b = await insertPerson({ fullName: "B" });
    const c = await insertPerson({ fullName: "C" });
    await insertParentOf(a.id, b.id);
    await insertParentOf(b.id, c.id);
    await insertParentOf(c.id, a.id); // A → B → C → A
    await insertParentOf(b.id, a.id); // and a 2-cycle A ↔ B
    const self = await insertPerson({ fullName: "D" });

    const tree = await getTree(`?personId=${a.id}&depth=3`);
    expect(tree.focus.id).toBe(a.id);
    expect(names(tree.parents)).toEqual(["B", "C"]);
    expect(names(tree.children)).toEqual(["B"]);
    // The focus never reappears as its own ancestor/descendant.
    const everyone = [...tree.parents, ...tree.children, ...tree.siblings, ...tree.extended.people];
    expect(everyone.some((person) => person.id === a.id)).toBe(false);
    expect(everyone.some((person) => person.id === self.id)).toBe(false);
  });

  it("loads the view in three queries regardless of size (no N+1)", async () => {
    const line = await insertLineage(6);
    const focus = line[3];
    if (focus === undefined) throw new Error("fixture");
    for (let index = 0; index < 5; index += 1) {
      const kid = await insertPerson({ fullName: `Hijo ${index}` });
      await insertParentOf(focus.id, kid.id);
    }
    const selectSpy = vi.spyOn(app.db, "select");
    const executeSpy = vi.spyOn(app.db, "execute");
    const tree = await getTree(`?personId=${focus.id}&depth=3`);
    expect(tree.children).toHaveLength(6);
    // The view issues 2 executes (the walk, the viewer's circle, WP-4.1) + 2 selects (people, edges),
    // independent of the tree size.
    expect(executeSpy).toHaveBeenCalledTimes(2);
    expect(selectSpy.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("answers 404 when the caller has no linked person or the person does not exist, 400 for a bad id", async () => {
    const unlinked = await app.inject({ method: "GET", url: "/api/family/tree", ...memberAuth });
    expect(unlinked.statusCode).toBe(404);
    expect(unlinked.json<ApiError>().error.message).toContain("vinculada");
    const missing = await app.inject({
      method: "GET",
      url: "/api/family/tree?personId=00000000-0000-4000-8000-000000000000",
      ...memberAuth
    });
    expect(missing.statusCode).toBe(404);
    const malformed = await app.inject({ method: "GET", url: "/api/family/tree?personId=nope", ...memberAuth });
    expect(malformed.statusCode).toBe(400);
  });

  it("applies the privacy rules to the focus", async () => {
    const other = await createUser();
    const linked = await insertPerson({ userId: other.id, birthYear: 1975 });
    const tree = await getTree(`?personId=${linked.id}`);
    expect(tree.focus.birthYear).toBeNull();
  });
});

describe("PATCH /api/family/me", () => {
  for (const url of ["/api/family/me", "/api/family/people/me"]) {
    it(`edits the caller's own node with the self field set (${url})`, async () => {
      const me = await insertPerson({ fullName: "Yo Mismo", userId: member.id });
      const response = await app.inject({
        method: "PATCH",
        url,
        payload: { nickname: "Yoyo", familyBranch: "Rama Norte", birthYear: 1991 },
        ...memberAuth
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json<Person>()).toMatchObject({ id: me.id, nickname: "Yoyo", familyBranch: "Rama Norte", birthYear: 1991 });
    });
  }

  it("ignores mass-assigned fields (userId, deceased, death data, id, relationships; WP-4.1 allows fullName)", async () => {
    const me = await insertPerson({ fullName: "Yo Mismo", userId: member.id });
    const victim = await insertPerson({ fullName: "Otra Persona" });
    const otherUser = await createUser();
    const response = await app.inject({
      method: "PATCH",
      url: "/api/family/me",
      payload: {
        nickname: "Nuevo",
        id: victim.id,
        userId: otherUser.id,
        deceased: true,
        deathYear: 2000,
        createdByUserId: otherUser.id,
        parents: [victim.id]
      },
      ...memberAuth
    });
    expect(response.statusCode, response.body).toBe(200);

    const [stored] = await getTestDb().select().from(people).where(eq(people.id, me.id));
    expect(stored).toMatchObject({ fullName: "Yo Mismo", nickname: "Nuevo", userId: member.id, deceased: false, deathYear: null });
    const [untouched] = await getTestDb().select().from(people).where(eq(people.id, victim.id));
    expect(untouched).toMatchObject({ fullName: "Otra Persona", nickname: null, userId: null });

    const [audit] = await getTestDb().select().from(auditLogs).where(eq(auditLogs.entityId, me.id));
    expect(audit).toMatchObject({ action: "person.updated", actorUserId: member.id, entityType: "person" });
    expect(audit?.metadata).toEqual({ fields: ["nickname"], self: true });
  });

  it("answers 400 when nothing editable is sent, even if forbidden keys are", async () => {
    await insertPerson({ userId: member.id });
    for (const payload of [{}, { userId: null }, { deceased: true }, { fullName: "" }, { birthYear: 1700 }]) {
      const response = await app.inject({ method: "PATCH", url: "/api/family/me", payload, ...memberAuth });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(response.json<ApiError>().error.code).toBe("VALIDATION");
    }
  });

  it("answers 400 with a Spanish message when the birth year breaks a CHECK", async () => {
    await insertPerson({ userId: member.id, deceased: true, deathYear: 2000 });
    const response = await app.inject({ method: "PATCH", url: "/api/family/me", payload: { birthYear: 2010 }, ...memberAuth });
    expect(response.statusCode).toBe(400);
    expect(response.json<ApiError>().error.details?.[0]?.path).toBe("birthYear");
  });

  it("answers 404 when the caller is not linked to a person", async () => {
    await insertPerson({ fullName: "Sin cuenta" });
    const response = await app.inject({ method: "PATCH", url: "/api/family/me", payload: { nickname: "x" }, ...memberAuth });
    expect(response.statusCode).toBe(404);
  });
});

describe("account links and avatars (profiles.listed_in_directory)", () => {
  const UPLOAD_ID = "2c3d4e5f-6071-4c8d-9e0f-1a2b3c4d5e6f";

  function avatarKeyFor(userId: string): string {
    return `avatars/${userId}/${UPLOAD_ID}-256.webp`;
  }

  /** A verified member with an avatar, linked to a person who is the caller's parent. */
  async function linkedRelative(options: { listed: boolean; status?: "active" | "disabled" }): Promise<{
    user: TestUser;
    personId: string;
    meId: string;
  }> {
    const user = await createUser({
      emailVerified: true,
      ...(options.status === undefined ? {} : { status: options.status }),
      profile: { fullName: "Pariente Ficticio", listedInDirectory: options.listed }
    });
    await getTestDb()
      .update(profiles)
      .set({ avatarKey: avatarKeyFor(user.id) })
      .where(eq(profiles.userId, user.id));
    const relative = await insertPerson({ fullName: "Pariente Ficticio", userId: user.id });
    const me = await insertPerson({ fullName: "Yo", userId: member.id });
    await insertParentOf(relative.id, me.id);
    return { user, personId: relative.id, meId: me.id };
  }

  async function search(auth: AuthInjectOptions): Promise<PersonSummary | undefined> {
    const response = await app.inject({ method: "GET", url: "/api/family/people?q=pariente", ...auth });
    expect(response.statusCode).toBe(200);
    return response.json<Page<PersonSummary>>().items[0];
  }

  async function detail(personId: string, auth: AuthInjectOptions): Promise<Person> {
    const response = await app.inject({ method: "GET", url: `/api/family/people/${personId}`, ...auth });
    expect(response.statusCode).toBe(200);
    return response.json<Person>();
  }

  it("presigns listed, active accounts' avatars: 256 px on a Person, 64 px on summaries", async () => {
    const { user, personId } = await linkedRelative({ listed: true });

    const person = await detail(personId, memberAuth);
    expect(person.userId).toBe(user.id);
    expect(person.avatarUrl).toContain(`${UPLOAD_ID}-256.webp`);
    expect((await search(memberAuth))?.avatarUrl).toContain(`${UPLOAD_ID}-64.webp`);
    const tree = await getTree("");
    expect(tree.parents[0]).toMatchObject({ id: personId, userId: user.id });
    expect(tree.parents[0]?.avatarUrl).toContain(`${UPLOAD_ID}-64.webp`);
  });

  it("serializes an unlisted linked node and an unlinked node with the same years identically (Security L1)", async () => {
    const hidden = await createUser({ emailVerified: true, profile: { fullName: "Oculto", listedInDirectory: false } });
    const unlisted = await insertPerson({ fullName: "Mismo Nombre", userId: hidden.id, birthYear: 1971, familyBranch: "Rama Sur" });
    const unlinked = await insertPerson({ fullName: "Mismo Nombre", birthYear: 1971, familyBranch: "Rama Sur" });

    const shape = (person: Person): Omit<Person, "id"> => {
      const { id: _id, ...rest } = person;
      return rest;
    };
    const a = await detail(unlisted.id, memberAuth);
    const b = await detail(unlinked.id, memberAuth);
    expect(shape(a)).toEqual(shape(b));
    expect(a).toMatchObject({ userId: null, birthYear: null, avatarUrl: null });
  });

  it("returns userId and avatarUrl null for unlisted accounts in detail, search and tree, keeping name and genealogy", async () => {
    const { personId, meId } = await linkedRelative({ listed: false });

    expect(await detail(personId, memberAuth)).toMatchObject({
      fullName: "Pariente Ficticio",
      userId: null,
      avatarUrl: null
    });
    const found = await search(memberAuth);
    expect(found).toMatchObject({ id: personId, userId: null, avatarUrl: null });

    const tree = await getTree("");
    expect(tree.parents).toEqual([
      expect.objectContaining({ id: personId, fullName: "Pariente Ficticio", userId: null, avatarUrl: null })
    ]);
    expect(tree.extended.relationships).toEqual([
      expect.objectContaining({ fromPersonId: personId, toPersonId: meId })
    ]);
    const focused = await getTree(`?personId=${personId}`);
    expect(focused.focus).toMatchObject({ id: personId, userId: null, avatarUrl: null });

    expect(JSON.stringify([tree, focused, found])).not.toContain("avatars/");
  });

  it("still shows an unlisted account's link and avatar to that member and to admins", async () => {
    const { user, personId } = await linkedRelative({ listed: false });
    const admin = await createUser({ role: "admin", emailVerified: true });

    for (const auth of [await loginAs(app, user), await loginAs(app, admin)]) {
      const person = await detail(personId, auth);
      expect(person.userId).toBe(user.id);
      expect(person.avatarUrl).toContain(`${UPLOAD_ID}-256.webp`);
      expect((await search(auth))?.userId).toBe(user.id);
    }
  });

  it("keeps the link but never presigns the avatar of a disabled account for other members", async () => {
    const { user, personId } = await linkedRelative({ listed: true, status: "disabled" });

    expect(await detail(personId, memberAuth)).toMatchObject({ userId: user.id, avatarUrl: null });
    expect((await getTree("")).parents[0]?.avatarUrl).toBeNull();
  });

  it("returns the caller's own avatar from the self edit, even when unlisted", async () => {
    await getTestDb()
      .update(profiles)
      .set({ avatarKey: avatarKeyFor(member.id), listedInDirectory: false })
      .where(eq(profiles.userId, member.id));
    await insertPerson({ fullName: "Yo", userId: member.id });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/family/me",
      payload: { nickname: "Yoyo" },
      ...memberAuth
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<Person>()).toMatchObject({ userId: member.id, nickname: "Yoyo" });
    expect(response.json<Person>().avatarUrl).toContain(`${UPLOAD_ID}-256.webp`);
  });
});
