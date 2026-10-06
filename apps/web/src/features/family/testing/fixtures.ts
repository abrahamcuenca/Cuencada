/**
 * Test fixtures for the family tree: a small in-memory family graph, a
 * contract-shaped `FamilyTreeView` builder (same rules as the T6-BE plan),
 * and MSW handlers over it. Used by the tests and the screenshot stub.
 */
import type { FamilyTreeView, Person, PersonSummary, Relationship } from "@cuencada/types";
import { type HttpHandler, HttpResponse, http } from "msw";
import { apiUrl, errorBody } from "../../../../test/auth";

/** A deterministic v4-shaped UUID for fixture `n`. */
export function fixtureId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** The `CurrentUser.id` linked to José in the fixtures (matches `makeUser()`). */
export const ME_USER_ID = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";

export const IDS = {
  ernesto: fixtureId(1),
  lucia: fixtureId(2),
  luis: fixtureId(3),
  elsa: fixtureId(4),
  jose: fixtureId(5),
  ana: fixtureId(6),
  ines: fixtureId(7),
  raul: fixtureId(8),
  diego: fixtureId(9),
  marta: fixtureId(10),
  pablo: fixtureId(11),
  sara: fixtureId(12),
  oscar: fixtureId(13),
  valeria: fixtureId(14),
  hugo: fixtureId(15)
} as const;

/** A full `Person` with sensible defaults. */
export function makePerson(id: string, fullName: string, overrides: Partial<Person> = {}): Person {
  return {
    id,
    userId: null,
    fullName,
    nickname: null,
    familyBranch: "Herrera Navarro",
    birthYear: null,
    deathYear: null,
    deceased: false,
    avatarUrl: null,
    ...overrides
  };
}

/** The in-memory graph the handlers serve. Tests mutate it freely. */
export interface FamilyDb {
  people: Map<string, Person>;
  relationships: Relationship[];
  log: Array<{ method: string; path: string; search: string; body: unknown }>;
}

let edgeSeq = 100;

function edge(kind: Relationship["kind"], fromPersonId: string, toPersonId: string): Relationship {
  edgeSeq += 1;
  return { id: fixtureId(edgeSeq), kind, fromPersonId, toPersonId };
}

/**
 * A rich family centred on José: 2 parents, a partner, 3 children, 4
 * siblings, 2 grandparents (Luis's parents) and 2 grandchildren (Inés's).
 */
export function makeFamilyDb(): FamilyDb {
  edgeSeq = 100;
  const people = [
    makePerson(IDS.ernesto, "Ernesto Herrera Ríos", { birthYear: 1890, deathYear: 1961, deceased: true }),
    makePerson(IDS.lucia, "Lucía Soto Campos", { birthYear: 1895, deathYear: 1970, deceased: true }),
    makePerson(IDS.luis, "Luis Herrera Soto", { birthYear: 1921, deathYear: 1998, deceased: true }),
    makePerson(IDS.elsa, "Elsa Navarro Gil", { birthYear: 1925, deathYear: 2010, deceased: true }),
    makePerson(IDS.jose, "José Herrera Navarro", { userId: ME_USER_ID, nickname: "Pepe", birthYear: 1952 }),
    makePerson(IDS.ana, "Ana Morales Vega", { familyBranch: null, birthYear: 1955, userId: fixtureId(901) }),
    makePerson(IDS.ines, "Inés Herrera Morales", { birthYear: 1978, userId: fixtureId(902) }),
    makePerson(IDS.raul, "Raúl Herrera Morales", { birthYear: 1981 }),
    makePerson(IDS.diego, "Diego Herrera Morales", { birthYear: 1985 }),
    makePerson(IDS.marta, "Marta Herrera Navarro", { birthYear: 1948 }),
    makePerson(IDS.pablo, "Pablo Herrera Navarro", { birthYear: 1950, deathYear: 2019, deceased: true }),
    makePerson(IDS.sara, "Sara Herrera Navarro", { birthYear: 1957 }),
    makePerson(IDS.oscar, "Óscar Herrera Navarro", { birthYear: 1960 }),
    makePerson(IDS.valeria, "Valeria Ortiz Herrera", { birthYear: 2005 }),
    makePerson(IDS.hugo, "Hugo Ortiz Herrera", { birthYear: 2008 })
  ];
  const relationships: Relationship[] = [
    edge("parent_of", IDS.ernesto, IDS.luis),
    edge("parent_of", IDS.lucia, IDS.luis),
    edge("partner_of", IDS.luis, IDS.elsa),
    ...[IDS.marta, IDS.pablo, IDS.jose, IDS.sara, IDS.oscar].flatMap((child) => [
      edge("parent_of", IDS.luis, child),
      edge("parent_of", IDS.elsa, child)
    ]),
    edge("partner_of", IDS.jose, IDS.ana),
    ...[IDS.ines, IDS.raul, IDS.diego].flatMap((child) => [edge("parent_of", IDS.jose, child), edge("parent_of", IDS.ana, child)]),
    edge("parent_of", IDS.ines, IDS.valeria),
    edge("parent_of", IDS.ines, IDS.hugo)
  ];
  return { people: new Map(people.map((person) => [person.id, person])), relationships, log: [] };
}

/** The summary of a person (what rings and searches carry). */
export function toSummary(person: Person): PersonSummary {
  const { id, userId, fullName, nickname, deceased, avatarUrl } = person;
  return { id, userId, fullName, nickname, deceased, avatarUrl };
}

function summaries(db: FamilyDb, ids: Iterable<string>): PersonSummary[] {
  const out: PersonSummary[] = [];
  for (const id of new Set(ids)) {
    const person = db.people.get(id);
    if (person) out.push(toSummary(person));
  }
  return out;
}

function parentsOf(db: FamilyDb, id: string): string[] {
  return db.relationships.filter((r) => r.kind === "parent_of" && r.toPersonId === id).map((r) => r.fromPersonId);
}

function childrenOf(db: FamilyDb, id: string): string[] {
  return db.relationships.filter((r) => r.kind === "parent_of" && r.fromPersonId === id).map((r) => r.toPersonId);
}

/**
 * Builds the contract view: the first ring always, the second ring in
 * `extended.people` at depth ≥ 2, and every edge between returned people.
 */
export function buildView(db: FamilyDb, focusId: string, depth: number): FamilyTreeView | null {
  const focus = db.people.get(focusId);
  if (!focus) return null;
  const parentIds = parentsOf(db, focusId);
  const childIds = childrenOf(db, focusId);
  const partnerIds = db.relationships
    .filter((r) => r.kind === "partner_of" && (r.fromPersonId === focusId || r.toPersonId === focusId))
    .map((r) => (r.fromPersonId === focusId ? r.toPersonId : r.fromPersonId));
  const siblingIds = parentIds.flatMap((parent) => childrenOf(db, parent)).filter((id) => id !== focusId);
  const extendedIds = depth >= 2 ? [...parentIds.flatMap((id) => parentsOf(db, id)), ...childIds.flatMap((id) => childrenOf(db, id))] : [];
  const returned = new Set([focusId, ...parentIds, ...childIds, ...partnerIds, ...siblingIds, ...extendedIds]);
  return {
    focus,
    parents: summaries(db, parentIds),
    partners: summaries(db, partnerIds),
    children: summaries(db, childIds),
    siblings: summaries(db, siblingIds),
    depth,
    extended: {
      people: summaries(db, extendedIds),
      relationships: db.relationships.filter((r) => returned.has(r.fromPersonId) && returned.has(r.toPersonId))
    }
  };
}

function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

async function record(db: FamilyDb, request: Request): Promise<unknown> {
  const url = new URL(request.url);
  const text = request.method === "GET" || request.method === "DELETE" ? "" : await request.text();
  const body: unknown = text ? JSON.parse(text) : null;
  db.log.push({ method: request.method, path: url.pathname.replace(/^.*\/api/, ""), search: url.search, body });
  return body;
}

/** Options for {@link familyHandlers}. */
export interface FamilyHandlerOptions {
  /** The caller's own person (`GET /family/tree` without `personId`), or `null` for 404. */
  mePersonId?: string | null;
}

/** MSW handlers for the member and admin family endpoints over `db`. */
export function familyHandlers(db: FamilyDb, { mePersonId = IDS.jose }: FamilyHandlerOptions = {}): HttpHandler[] {
  return [
    http.get(apiUrl("/family/tree"), async ({ request }) => {
      await record(db, request);
      const url = new URL(request.url);
      const personId = url.searchParams.get("personId") ?? mePersonId;
      const depth = Number(url.searchParams.get("depth") ?? "1");
      const view = personId === null ? null : buildView(db, personId, depth);
      if (view === null) return HttpResponse.json(errorBody("NOT_FOUND", "No encontramos a esa persona."), { status: 404 });
      return HttpResponse.json(view);
    }),
    http.get(apiUrl("/family/people"), async ({ request }) => {
      await record(db, request);
      const q = fold(new URL(request.url).searchParams.get("q") ?? "");
      const items = [...db.people.values()]
        .filter((person) => q === "" || fold(`${person.fullName} ${person.nickname ?? ""}`).includes(q))
        .map(toSummary);
      return HttpResponse.json({ items, nextCursor: null });
    }),
    http.get(apiUrl("/family/people/:id"), async ({ request, params }) => {
      await record(db, request);
      const person = db.people.get(String(params.id));
      if (!person) return HttpResponse.json(errorBody("NOT_FOUND", "No encontramos a esa persona."), { status: 404 });
      return HttpResponse.json(person);
    }),
    http.patch(apiUrl("/family/me"), async ({ request }) => {
      const body = await record(db, request);
      const me = mePersonId === null ? undefined : db.people.get(mePersonId);
      if (!me || typeof body !== "object" || body === null) return HttpResponse.json(errorBody("NOT_FOUND"), { status: 404 });
      const updated: Person = { ...me, ...body };
      db.people.set(me.id, updated);
      return HttpResponse.json(updated);
    }),
    http.post(apiUrl("/admin/people"), async ({ request }) => {
      const body = await record(db, request);
      const person = makePerson(fixtureId(500 + db.people.size), "", typeof body === "object" && body !== null ? body : {});
      db.people.set(person.id, person);
      return HttpResponse.json(person, { status: 201 });
    }),
    http.patch(apiUrl("/admin/people/:id"), async ({ request, params }) => {
      const body = await record(db, request);
      const person = db.people.get(String(params.id));
      if (!person || typeof body !== "object" || body === null) return HttpResponse.json(errorBody("NOT_FOUND"), { status: 404 });
      const updated: Person = { ...person, ...body };
      db.people.set(person.id, updated);
      return HttpResponse.json(updated);
    }),
    http.delete(apiUrl("/admin/people/:id"), async ({ request, params }) => {
      await record(db, request);
      const id = String(params.id);
      db.people.delete(id);
      db.relationships = db.relationships.filter((r) => r.fromPersonId !== id && r.toPersonId !== id);
      return new HttpResponse(null, { status: 204 });
    }),
    http.post(apiUrl("/admin/relationships"), async ({ request }) => {
      const body = await record(db, request);
      if (typeof body !== "object" || body === null || !("kind" in body) || !("fromPersonId" in body) || !("toPersonId" in body)) {
        return HttpResponse.json(errorBody("VALIDATION"), { status: 400 });
      }
      const created = edge(body.kind === "partner_of" ? "partner_of" : "parent_of", String(body.fromPersonId), String(body.toPersonId));
      db.relationships.push(created);
      return HttpResponse.json(created, { status: 201 });
    }),
    http.delete(apiUrl("/admin/relationships/:id"), async ({ request, params }) => {
      await record(db, request);
      db.relationships = db.relationships.filter((r) => r.id !== String(params.id));
      return new HttpResponse(null, { status: 204 });
    }),
    http.get(apiUrl("/admin/users"), async ({ request }) => {
      await record(db, request);
      return HttpResponse.json({ items: [], nextCursor: null });
    })
  ];
}
