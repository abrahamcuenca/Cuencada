/**
 * Pure helpers for the person-centred tree: labels, years, the breadcrumb
 * trail kept in `location.state`, and the extended generations derived from
 * `FamilyTreeView.extended`.
 */
import type { FamilyTreeView, Person, PersonSummary } from "@cuencada/types";

/** Longest breadcrumb trail kept in history state. */
export const TRAIL_MAX = 5;

/** One visited person in the breadcrumb trail. */
export interface TrailEntry {
  id: string;
  name: string;
}

/** Shape of `location.state` on `/arbol/:personId?`. */
export interface TreeLocationState {
  trail: TrailEntry[];
}

function isTrailEntry(value: unknown): value is TrailEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    "name" in value &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    value.id.length <= 64 &&
    value.name.length <= 200
  );
}

/**
 * Reads the trail from an untrusted `location.state` (history entries can be
 * anything, e.g. after a deploy or from another feature).
 *
 * @param state - `location.state`.
 * @returns The validated trail, or `[]`.
 */
export function readTrail(state: unknown): TrailEntry[] {
  if (typeof state !== "object" || state === null || !("trail" in state) || !Array.isArray(state.trail)) return [];
  return state.trail.filter(isTrailEntry).slice(-TRAIL_MAX);
}

/**
 * The trail to carry when moving from `current` to `targetId`. Returning to
 * someone already in the trail cuts it back to before them, so the trail
 * never loops.
 *
 * @param trail - The trail of the current history entry.
 * @param current - The person being left (the current focus), if known.
 * @param targetId - The person being opened.
 * @returns The trail for the new history entry.
 */
export function nextTrail(trail: readonly TrailEntry[], current: TrailEntry | null, targetId: string): TrailEntry[] {
  const withCurrent = current === null ? [...trail] : [...trail.filter((entry) => entry.id !== current.id), current];
  const existing = withCurrent.findIndex((entry) => entry.id === targetId);
  const cut = existing === -1 ? withCurrent : withCurrent.slice(0, existing);
  return cut.slice(-TRAIL_MAX);
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
