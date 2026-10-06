/**
 * Pure helpers for the person-centred tree: labels, years, the breadcrumb
 * trail kept in `location.state`, and the extended generations derived from
 * `FamilyTreeView.extended`.
 */
import type { FamilyTreeView, Person, PersonSummary } from "@cuencada/types";

/** Longest breadcrumb trail kept in history state. */
export const TRAIL_MAX = 5;

/** One visited person in the breadcrumb trail, as rendered (names resolved from memory). */
export interface TrailEntry {
  id: string;
  name: string;
}

/**
 * Shape of `location.state` on `/arbol/:personId?`: person **ids only** [SEC].
 * History state outlives the session (it is kept by the browser, survives a
 * logout on a shared device and a reload), so no names are written there;
 * they are resolved from the in-memory RTK Query cache when rendering.
 */
export interface TreeLocationState {
  trail: string[];
}

function trailId(value: unknown): string | null {
  // Legacy entries were `{ id, name }`: keep the id, drop the name.
  const id = typeof value === "object" && value !== null && "id" in value ? value.id : value;
  return typeof id === "string" && id.length > 0 && id.length <= 64 ? id : null;
}

/**
 * Reads the trail from an untrusted `location.state` (history entries can be
 * anything, e.g. after a deploy or from another feature).
 *
 * @param state - `location.state`.
 * @returns The validated person ids, oldest first, or `[]`.
 */
export function readTrail(state: unknown): string[] {
  if (typeof state !== "object" || state === null || !("trail" in state) || !Array.isArray(state.trail)) return [];
  return state.trail
    .map(trailId)
    .filter((id): id is string => id !== null)
    .slice(-TRAIL_MAX);
}

/**
 * The trail to carry when moving from `currentId` to `targetId`. Returning to
 * someone already in the trail cuts it back to before them, so the trail
 * never loops.
 *
 * @param trail - The trail (ids) of the current history entry.
 * @param currentId - The person being left (the current focus), if known.
 * @param targetId - The person being opened.
 * @returns The trail for the new history entry.
 */
export function nextTrail(trail: readonly string[], currentId: string | null, targetId: string): string[] {
  const withCurrent = currentId === null ? [...trail] : [...trail.filter((id) => id !== currentId), currentId];
  const existing = withCurrent.indexOf(targetId);
  const cut = existing === -1 ? withCurrent : withCurrent.slice(0, existing);
  return cut.slice(-TRAIL_MAX);
}

/**
 * Names for the trail ids. Ids whose name isn't in memory any more (after a
 * reload, or once the cache let go of them) are skipped rather than shown blank.
 *
 * @param ids - Trail ids from history state.
 * @param names - Person id → full name, from memory.
 * @returns The entries to render.
 */
export function resolveTrail(ids: readonly string[], names: ReadonlyMap<string, string>): TrailEntry[] {
  return ids.flatMap((id) => {
    const name = names.get(id);
    return name === undefined ? [] : [{ id, name }];
  });
}

/**
 * Collects person names from tree views and people pages (the RTK Query
 * cache), into `into`.
 *
 * @param data - Any cached `FamilyTreeView`, `Page<PersonSummary>` or `Person`.
 * @param into - The map to fill.
 */
export function collectPersonNames(data: unknown, into: Map<string, string>): void {
  if (typeof data !== "object" || data === null) return;
  const add = (person: unknown): void => {
    if (typeof person !== "object" || person === null || !("id" in person) || !("fullName" in person)) return;
    if (typeof person.id === "string" && typeof person.fullName === "string") into.set(person.id, person.fullName);
  };
  add(data);
  for (const key of ["focus", "parents", "partners", "children", "siblings", "items"] as const) {
    if (!(key in data)) continue;
    const value: unknown = (data as Record<string, unknown>)[key]; // `key in data` checked just above.
    if (Array.isArray(value)) value.forEach(add);
    else add(value);
  }
  if ("extended" in data && typeof data.extended === "object" && data.extended !== null && "people" in data.extended && Array.isArray(data.extended.people)) {
    data.extended.people.forEach(add);
  }
}

/**
 * @param person - Any person shape with `fullName` and `nickname`.
 * @returns The name to show on a card: the nickname in quotes after the name when present.
 */
export function displayName(person: Pick<PersonSummary, "fullName" | "nickname">): string {
  return person.nickname ? `${person.fullName} «${person.nickname}»` : person.fullName;
}

/**
 * @param person - The focus person (summaries carry no years).
 * @returns e.g. `1930 – 2015`, `n. 1952`, `† 2015`, or `null` when no year is known.
 */
export function lifeYears(person: Pick<Person, "birthYear" | "deathYear" | "deceased">): string | null {
  const { birthYear, deathYear } = person;
  if (birthYear !== null && deathYear !== null) return `${birthYear} – ${deathYear}`;
  if (birthYear !== null) return person.deceased ? `${birthYear} – ?` : `n. ${birthYear}`;
  if (deathYear !== null) return `† ${deathYear}`;
  return null;
}

/** Grandparents and grandchildren derived from a depth ≥ 2 view. */
export interface ExtendedGenerations {
  grandparents: PersonSummary[];
  grandchildren: PersonSummary[];
}

/**
 * Derives the second ring from `extended.relationships` (`parent_of` edges).
 *
 * @param view - A tree view fetched with `depth >= 2`.
 * @returns People who are parents of the focus's parents, and children of the focus's children.
 */
export function extendedGenerations(view: FamilyTreeView): ExtendedGenerations {
  const byId = new Map<string, PersonSummary>();
  for (const person of [...view.parents, ...view.children, ...view.partners, ...view.siblings, ...view.extended.people]) {
    byId.set(person.id, person);
  }
  const parentIds = new Set(view.parents.map((person) => person.id));
  const childIds = new Set(view.children.map((person) => person.id));
  const grandparents = new Map<string, PersonSummary>();
  const grandchildren = new Map<string, PersonSummary>();
  for (const edge of view.extended.relationships) {
    if (edge.kind !== "parent_of") continue;
    if (parentIds.has(edge.toPersonId)) {
      const person = byId.get(edge.fromPersonId);
      if (person && person.id !== view.focus.id) grandparents.set(person.id, person);
    }
    if (childIds.has(edge.fromPersonId)) {
      const person = byId.get(edge.toPersonId);
      if (person && person.id !== view.focus.id) grandchildren.set(person.id, person);
    }
  }
  return {
    grandparents: [...grandparents.values()],
    grandchildren: [...grandchildren.values()]
  };
}
