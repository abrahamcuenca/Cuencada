/**
 * Test fixtures for "Fusionar personas" (WP-4.5): a contract-shaped merge
 * preview built from the in-memory family, possible-duplicate pairs, and MSW
 * handlers for the three admin endpoints. Fictional people only.
 */
import {
  type DuplicateCandidate,
  type ErrorCode,
  type Person,
  type PersonMergePreview,
  type PersonMergeSide,
  type PersonMergeValues,
  type PossibleDuplicate,
  defaultMergeChoices
} from "@cuencada/types";
import { type HttpHandler, HttpResponse, http } from "msw";
import { apiUrl, errorBody } from "../../../../test/auth";
import { type FamilyDb, fixtureId, makePerson } from "./fixtures";

/** The duplicate of Raúl in the merge tests: same human, created by an invite. */
export const DUPLICATE_ID = fixtureId(30);

/** Add Raúl's duplicate ("Raúl Herrera M.", linked to an account) to `db`. */
export function addDuplicate(db: FamilyDb, overrides: Partial<Person> = {}): Person {
  const person = makePerson(DUPLICATE_ID, "Raúl Herrera M.", { familyBranch: null, nickname: "Rulo", birthYear: 1981, birthDate: "1981-07-09", userId: fixtureId(903), ...overrides });
  db.people.set(person.id, person);
  return person;
}

function valuesOf(person: Person): PersonMergeValues {
  return {
    fullName: person.fullName,
    nickname: person.nickname,
    familyBranch: person.familyBranch,
    birthYear: person.birthYear,
    birthDate: person.birthDate ?? null,
    deathYear: person.deathYear,
    deathDate: person.deathDate ?? null,
    deceased: person.deceased,
    birthplace: person.birthplace ?? null,
    bio: person.bio ?? null
  };
}

function side(db: FamilyDb, person: Person): PersonMergeSide {
  return {
    person,
    values: valuesOf(person),
    accountName: person.userId === null ? null : `Cuenta de ${person.fullName}`,
    hasTreePhoto: false,
    relationshipCount: db.relationships.filter((edge) => edge.fromPersonId === person.id || edge.toPersonId === person.id).length
  };
}

/**
 * A preview of merging `duplicateId` into `keepId`: defaults from the
 * contract, the duplicate's account moves, one partner edge moves.
 */
export function makePreview(db: FamilyDb, keepId: string, duplicateId: string, overrides: Partial<PersonMergePreview> = {}): PersonMergePreview {
  const keep = db.people.get(keepId);
  const duplicate = db.people.get(duplicateId);
  if (keep === undefined || duplicate === undefined) throw new Error("makePreview: unknown person");
  return {
    keep: side(db, keep),
    duplicate: side(db, duplicate),
    defaults: defaultMergeChoices(valuesOf(keep), valuesOf(duplicate)),
    relationships: {
      moved: [{ id: fixtureId(700), kind: "partner_of", otherPersonId: fixtureId(31), otherPersonName: "Carmen Ficticio", role: "partner", outcome: "moved" }],
      dropped: [{ id: fixtureId(701), kind: "parent_of", otherPersonId: fixtureId(5), otherPersonName: "José Herrera Navarro", role: "parent", outcome: "duplicate" }],
      conflicts: []
    },
    photo: { result: "none", deletesDuplicatePhoto: false },
    account: { result: keep.userId === null && duplicate.userId !== null ? "moved" : keep.userId !== null ? "keep" : "none", bothLinked: keep.userId !== null && duplicate.userId !== null },
    invites: { move: 0, revoke: 0 },
    attendance: { move: 1, drop: 0 },
    blockers: keep.userId !== null && duplicate.userId !== null ? ["MERGE_BOTH_LINKED"] : [],
    ...overrides
  };
}

function candidate(db: FamilyDb, person: Person): DuplicateCandidate {
  return {
    id: person.id,
    fullName: person.fullName,
    nickname: person.nickname,
    familyBranch: person.familyBranch,
    birthYear: person.birthYear,
    deathYear: person.deathYear,
    deceased: person.deceased,
    linked: person.userId !== null,
    relationshipCount: side(db, person).relationshipCount
  };
}

/** A possible-duplicate pair over `db`. */
export function makePair(db: FamilyDb, keepId: string, duplicateId: string, overrides: Partial<PossibleDuplicate> = {}): PossibleDuplicate {
  const keep = db.people.get(keepId);
  const duplicate = db.people.get(duplicateId);
  if (keep === undefined || duplicate === undefined) throw new Error("makePair: unknown person");
  return { keep: candidate(db, keep), duplicate: candidate(db, duplicate), reason: "similar_name", mergeable: true, ...overrides };
}

/** What the merge handlers serve; tests mutate it. */
export interface MergeState {
  pairs: PossibleDuplicate[];
  /** Per `keep:duplicate` preview overrides. */
  previews: Map<string, Partial<PersonMergePreview>>;
  /** Answer the next merge with this error instead. */
  mergeError: { status: number; code: ErrorCode; message: string } | null;
}

/** An empty {@link MergeState}. */
export function makeMergeState(): MergeState {
  return { pairs: [], previews: new Map(), mergeError: null };
}

async function log(db: FamilyDb, request: Request): Promise<unknown> {
  const url = new URL(request.url);
  const body: unknown = request.method === "GET" ? undefined : await request.clone().json().catch(() => undefined);
  db.log.push({ method: request.method, path: url.pathname.replace(/^\/api/, ""), search: url.search, body });
  return body;
}

/** MSW handlers for the merge endpoints over `db` and `state`. Register before `familyHandlers`. */
export function mergeHandlers(db: FamilyDb, state: MergeState): HttpHandler[] {
  return [
    http.get(apiUrl("/admin/family/duplicates"), async ({ request }) => {
      await log(db, request);
      return HttpResponse.json({ items: state.pairs, nextCursor: null });
    }),
    http.get(apiUrl("/admin/people/:id/merge-preview"), async ({ request, params }) => {
      await log(db, request);
      const keepId = String(params.id);
      const duplicateId = new URL(request.url).searchParams.get("duplicateId") ?? "";
      if (!db.people.has(keepId) || !db.people.has(duplicateId)) return HttpResponse.json(errorBody("NOT_FOUND", "No encontramos a esa persona."), { status: 404 });
      return HttpResponse.json(makePreview(db, keepId, duplicateId, state.previews.get(`${keepId}:${duplicateId}`)));
    }),
    http.post(apiUrl("/admin/people/:id/merge"), async ({ request, params }) => {
      const body = await log(db, request);
      if (state.mergeError !== null) {
        const { status, code, message } = state.mergeError;
        state.mergeError = null;
        return HttpResponse.json(errorBody(code, message), { status });
      }
      const keep = db.people.get(String(params.id));
      const duplicateId = typeof body === "object" && body !== null && "duplicateId" in body ? String(body.duplicateId) : "";
      const duplicate = db.people.get(duplicateId);
      if (keep === undefined || duplicate === undefined) return HttpResponse.json(errorBody("NOT_FOUND"), { status: 404 });
      const merged: Person = { ...keep, userId: keep.userId ?? duplicate.userId, nickname: keep.nickname ?? duplicate.nickname };
      db.people.set(keep.id, merged);
      db.people.delete(duplicate.id);
      state.pairs = [];
      return HttpResponse.json({ person: merged, revisionId: fixtureId(750), revertible: true });
    })
  ];
}
