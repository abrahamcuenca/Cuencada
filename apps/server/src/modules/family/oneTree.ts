/**
 * "One family tree" reads (WP-6.4, ADR 0001 §6 and §8), over the in-memory
 * graph (`graph.ts`):
 *
 * - {@link loadExtendedFamily}: the tíos, primos and tíos abuelos bands of a
 *   person, as `PersonSummary` (no years) under the usual photo and link rules.
 * - {@link loadTreeOverview}: "Árbol completo", the descendants outline from
 *   the root (or any person), a few generations per request. **Names only**:
 *   no photos, no account ids; living people's birth years only for self,
 *   admins and the qualifying circle; death years only for the deceased.
 * - {@link loadOverviewPath}: the outline path from the root to a person ("Ir a mí").
 * - {@link loadDisconnectedBranches}: admin-only "Ramas sin conectar", the
 *   connected components the root cannot reach, with suggested matches
 *   (`duplicates.ts` `scoreMatch`), linked accounts as a count only.
 */
import {
  type BranchMatch,
  type DisconnectedBranch,
  type DisconnectedBranchReport,
  EXTENDED_FAMILY_BAND_MAX,
  type ExtendedFamily,
  type PersonSummary,
  TREE_OVERVIEW_MAX_NODES,
  type TreeOverview,
  type TreeOverviewNode,
  type TreeOverviewPath
} from "@cuencada/types";
import { inArray } from "drizzle-orm";
import { people } from "../../db/schema/index.js";
import type { DbOrTx } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import type { AvatarUrlDeps } from "../profile/avatar.js";
import { AvatarSize } from "../profile/constants.js";
import { type MatchProfile, nameTokens, normalizedName, scoreMatch } from "./duplicates.js";
import { type FamilyGraph, componentOf, components, loadFamilyGraph, neighbours, outlineChildren, outlinePath, step } from "./graph.js";
import {
  canSeePrivateLife,
  compareByName,
  type PersonViewRow,
  presignPersonAvatars,
  selectPersonViews,
  toPersonSummary,
  type Viewer
} from "./repository.js";
import { readRootPersonId } from "./settings.js";

const PERSON_NOT_FOUND = "No encontramos a esa persona.";
/** Longest outline path returned (the contract's cap). */
const PATH_MAX = 64;
/** Partners listed beside one outline node. */
const OVERVIEW_PARTNERS_MAX = 10;
/** Representatives per branch and matches per branch (contract caps). */
const BRANCH_PEOPLE_MAX = 5;
const BRANCH_MATCHES_MAX = 10;

/** What these reads need from the app. */
export type OneTreeDeps = AvatarUrlDeps & { db: DbOrTx };

/** Rows for `ids` keyed by id (one statement; none for an empty list). */
async function rowsById(db: DbOrTx, ids: Iterable<string>): Promise<Map<string, PersonViewRow>> {
  const list = [...new Set(ids)];
  if (list.length === 0) return new Map();
  const rows = await selectPersonViews(db, inArray(people.id, list));
  return new Map(rows.map((row) => [row.id, row]));
}

/** @throws AppError `NOT_FOUND` when `id` is not a person. */
async function assertPerson(db: DbOrTx, graph: FamilyGraph, id: string): Promise<void> {
  if (graph.ids.has(id)) return;
  if ((await rowsById(db, [id])).size === 0) throw new AppError("NOT_FOUND", PERSON_NOT_FOUND);
}

/* -------------------------------------------------------------------------- */
/* Extended bands                                                              */
/* -------------------------------------------------------------------------- */

/** The band ids of `focusId` (pure: exported for the tests). */
export function extendedBandIds(graph: FamilyGraph, focusId: string): { tios: string[]; primos: string[]; tiosAbuelos: string[] } {
  const parents = neighbours(graph.parentsOf, focusId);
  const grandparents = step(graph.parentsOf, parents);
  const greatGrandparents = step(graph.parentsOf, grandparents);
  const siblings = step(graph.childrenOf, parents);
  // Direct line and siblings never appear in a band (also guards corrupt, cyclic data).
  const taken = new Set<string>([focusId, ...parents, ...grandparents, ...greatGrandparents, ...siblings]);
  const fresh = (ids: readonly string[]): string[] => {
    const out = ids.filter((id) => !taken.has(id));
    for (const id of out) taken.add(id);
    return out;
  };
  const bloodTios = fresh(step(graph.childrenOf, grandparents));
  const tioPartners = fresh(step(graph.partnersOf, bloodTios));
  const primos = fresh(step(graph.childrenOf, bloodTios));
  const tiosAbuelos = fresh(step(graph.childrenOf, greatGrandparents));
  return { tios: [...bloodTios, ...tioPartners], primos, tiosAbuelos };
}

/**
 * Tíos (siblings of the parents, full or half, plus their partners), primos
 * (children of those siblings) and tíos abuelos (siblings of the grandparents).
 *
 * @param deps - Client, storage and logger.
 * @param focusId - The person (the route defaults it to the caller's own).
 * @param viewer - The caller (photo and link rules).
 * @throws AppError `NOT_FOUND` for an unknown person.
 */
export async function loadExtendedFamily(deps: OneTreeDeps, focusId: string, viewer: Viewer): Promise<ExtendedFamily> {
  const graph = await loadFamilyGraph(deps.db);
  await assertPerson(deps.db, graph, focusId);
  const bands = extendedBandIds(graph, focusId);
  const byId = await rowsById(deps.db, [...bands.tios, ...bands.primos, ...bands.tiosAbuelos]);
  let truncated = false;
  const band = (ids: readonly string[]): PersonViewRow[] => {
    const rows = ids.flatMap((id) => byId.get(id) ?? []).sort(compareByName);
    if (rows.length > EXTENDED_FAMILY_BAND_MAX) truncated = true;
    return rows.slice(0, EXTENDED_FAMILY_BAND_MAX);
  };
  const tios = band(bands.tios);
  const primos = band(bands.primos);
  const tiosAbuelos = band(bands.tiosAbuelos);
  const avatars = await presignPersonAvatars(deps, [...tios, ...primos, ...tiosAbuelos], viewer, AvatarSize.Small);
  const summaries = (rows: readonly PersonViewRow[]): PersonSummary[] => rows.map((row) => toPersonSummary(row, viewer, avatars));
  return { focusId, tios: summaries(tios), primos: summaries(primos), tiosAbuelos: summaries(tiosAbuelos), truncated };
}

/* -------------------------------------------------------------------------- */
/* "Árbol completo"                                                            */
/* -------------------------------------------------------------------------- */

/** One included outline node before mapping. */
interface OutlineEntry {
  id: string;
  parentId: string | null;
}

/**
 * Breadth-first outline from `startId`, `depth` generations down, at most
 * `maxNodes` nodes; a person reached twice (cousins who married) is shown
 * under the first parent only. Pure: exported for the tests.
 */
export function outlineEntries(graph: FamilyGraph, startId: string, depth: number, maxNodes: number): OutlineEntry[] {
  const entries: OutlineEntry[] = [{ id: startId, parentId: null }];
  const seen = new Set<string>([startId]);
  let frontier = [startId];
  for (let level = 1; level <= depth && frontier.length > 0; level += 1) {
    const next: string[] = [];
    for (const parentId of frontier) {
      for (const child of outlineChildren(graph, parentId).sort()) {
        if (seen.has(child)) continue;
        if (entries.length >= maxNodes) return entries;
        seen.add(child);
        entries.push({ id: child, parentId });
        next.push(child);
      }
    }
    frontier = next;
  }
  return entries;
}

/** The viewer's own person: connected to the root? `null` without a root or a person. */
function viewerConnectedTo(graph: FamilyGraph, rootId: string | null, selfId: string | null): boolean | null {
  if (rootId === null || selfId === null) return null;
  return componentOf(graph, rootId).has(selfId);
}

/**
 * "Árbol completo": the outline from `personId` (default: the root) down
 * `depth` generations, parents before children (siblings by visible birth
 * year, then name).
 *
 * @param deps - Client (no storage: names only).
 * @param query - Start and depth (already validated).
 * @param viewer - The caller, **with** their qualifying circle (living birth years).
 * @param selfId - The caller's own person, if any (`viewerConnected`).
 * @throws AppError `NOT_FOUND` when `personId` is not a person.
 */
export async function loadTreeOverview(
  deps: { db: DbOrTx },
  query: { personId?: string; depth: number },
  viewer: Viewer,
  selfId: string | null
): Promise<TreeOverview> {
  const rootId = await readRootPersonId(deps.db);
  const graph = await loadFamilyGraph(deps.db);
  const viewerConnected = viewerConnectedTo(graph, rootId, selfId);
  const startId = query.personId ?? rootId;
  if (startId === null) return { rootId: null, nodes: [], viewerConnected };
  await assertPerson(deps.db, graph, startId);

  const entries = outlineEntries(graph, startId, query.depth, TREE_OVERVIEW_MAX_NODES);
  const included = new Set(entries.map((entry) => entry.id));
  const partnerIds = (id: string): string[] => [...neighbours(graph.partnersOf, id)].sort().slice(0, OVERVIEW_PARTNERS_MAX);
  const byId = await rowsById(deps.db, [...included, ...entries.flatMap((entry) => partnerIds(entry.id))]);

  const visibleBirthYear = (row: PersonViewRow): number | null => (row.deceased || canSeePrivateLife(row, viewer) ? row.birthYear : null);
  const toNode = (entry: OutlineEntry, row: PersonViewRow): TreeOverviewNode => {
    const children = outlineChildren(graph, entry.id);
    return {
      id: row.id,
      parentId: entry.parentId,
      name: row.fullName,
      nickname: row.nickname,
      birthYear: visibleBirthYear(row),
      deathYear: row.deceased ? row.deathYear : null,
      deceased: row.deceased,
      partners: partnerIds(entry.id).flatMap((id) => {
        const partner = byId.get(id);
        return partner === undefined ? [] : [{ id: partner.id, name: partner.fullName }];
      }),
      childrenCount: children.length,
      hasMore: children.some((child) => !included.has(child))
    };
  };
  const nodes = entries.flatMap((entry) => {
    const row = byId.get(entry.id);
    return row === undefined ? [] : [{ entry, row }];
  });

  // Parents before children: the BFS order by level, siblings sorted for display.
  const childrenOfEntry = new Map<string | null, Array<{ entry: OutlineEntry; row: PersonViewRow }>>();
  for (const node of nodes) {
    const list = childrenOfEntry.get(node.entry.parentId);
    if (list === undefined) childrenOfEntry.set(node.entry.parentId, [node]);
    else list.push(node);
  }
  const ordered: TreeOverviewNode[] = [];
  let level: Array<string | null> = [null];
  while (level.length > 0) {
    const next: string[] = [];
    for (const parentId of level) {
      const siblings = (childrenOfEntry.get(parentId) ?? []).sort((a, b) => {
        const ya = visibleBirthYear(a.row);
        const yb = visibleBirthYear(b.row);
        if (ya !== null && yb !== null && ya !== yb) return ya - yb;
        if ((ya === null) !== (yb === null)) return ya === null ? 1 : -1;
        return compareByName(a.row, b.row);
      });
      for (const sibling of siblings) {
        ordered.push(toNode(sibling.entry, sibling.row));
        next.push(sibling.entry.id);
      }
    }
    level = next;
  }
  return { rootId, nodes: ordered, viewerConnected };
}

/**
 * The outline path from the root to `personId` ("Ir a mí"); empty without a
 * root or when the person is not in the root's outline.
 */
export async function loadOverviewPath(db: DbOrTx, personId: string): Promise<TreeOverviewPath> {
  const rootId = await readRootPersonId(db);
  if (rootId === null) return { ids: [] };
  const graph = await loadFamilyGraph(db);
  return { ids: outlinePath(graph, rootId, personId, PATH_MAX) };
}

/* -------------------------------------------------------------------------- */
/* "Ramas sin conectar"                                                        */
/* -------------------------------------------------------------------------- */

/** A component with its precomputed ordering. */
interface BranchComponent {
  id: string;
  members: string[];
}

/**
 * The components the root cannot reach (or, without a root, every component
 * but the largest), largest first, then by id. Pure: exported for the tests.
 *
 * @param includeSingles - Also list people with no relationships.
 */
export function disconnectedComponents(
  graph: FamilyGraph,
  rootId: string | null,
  includeSingles: boolean
): { main: ReadonlySet<string>; branches: BranchComponent[] } {
  const all = components(graph).map((members) => ({ members, id: [...members].sort()[0] ?? "" }));
  all.sort((a, b) => b.members.size - a.members.size || a.id.localeCompare(b.id));
  const mainIndex = rootId === null ? 0 : all.findIndex((component) => component.members.has(rootId));
  const main = all[mainIndex]?.members ?? new Set<string>();
  const branches = all
    .filter((_component, index) => index !== mainIndex)
    .filter((component) => includeSingles || component.members.size > 1)
    .map((component) => ({ id: component.id, members: [...component.members] }));
  return { main, branches };
}

/** The matcher's view of a person (normalized names of their partners and children). */
function matchProfile(graph: FamilyGraph, row: PersonViewRow, rows: ReadonlyMap<string, PersonViewRow>): MatchProfile {
  const names = (ids: readonly string[]): string[] =>
    ids.flatMap((id) => {
      const name = normalizedName(rows.get(id)?.fullName ?? null);
      return name === null ? [] : [name];
    });
  return {
    id: row.id,
    tokens: nameTokens(row.fullName),
    nickname: normalizedName(row.nickname),
    birthYear: row.birthYear,
    deathYear: row.deathYear,
    partnerNames: names(neighbours(graph.partnersOf, row.id)),
    childNames: names(neighbours(graph.childrenOf, row.id))
  };
}

/** Oldest generation first (no parents inside the branch), then the most connected, then by name. */
function representatives(graph: FamilyGraph, members: readonly string[], rows: ReadonlyMap<string, PersonViewRow>): PersonViewRow[] {
  const inside = new Set(members);
  const degree = (id: string): number =>
    neighbours(graph.parentsOf, id).length + neighbours(graph.childrenOf, id).length + neighbours(graph.partnersOf, id).length;
  const hasParent = (id: string): boolean => neighbours(graph.parentsOf, id).some((parent) => inside.has(parent));
  return members
    .flatMap((id) => rows.get(id) ?? [])
    .sort(
      (a, b) =>
        Number(hasParent(a.id)) - Number(hasParent(b.id)) || degree(b.id) - degree(a.id) || compareByName(a, b)
    )
    .slice(0, BRANCH_PEOPLE_MAX);
}

/**
 * Admin "Ramas sin conectar": every component the root cannot reach, offset-paged.
 *
 * @param deps - Client, storage and logger.
 * @param page - Offset and page size.
 * @param includeSingles - Also list people with no relationships.
 * @param viewer - The admin.
 */
export async function loadDisconnectedBranches(
  deps: OneTreeDeps,
  page: { offset: number; limit: number },
  includeSingles: boolean,
  viewer: Viewer
): Promise<DisconnectedBranchReport & { total: number }> {
  const rootId = await readRootPersonId(deps.db);
  const graph = await loadFamilyGraph(deps.db, { withPeople: true });
  const { main, branches } = disconnectedComponents(graph, rootId, includeSingles);
  const slice = branches.slice(page.offset, page.offset + page.limit);
  // Every person: the matcher compares each branch with the whole main component (family scale).
  const rows = await rowsById(deps.db, graph.ids);
  const mainProfiles = [...main].flatMap((id) => {
    const row = rows.get(id);
    return row === undefined ? [] : [matchProfile(graph, row, rows)];
  });

  const planned = slice.map((branch) => {
    const matches: Array<{ person: PersonViewRow; candidate: PersonViewRow; reasons: BranchMatch["reasons"]; score: number }> = [];
    for (const id of branch.members) {
      const row = rows.get(id);
      if (row === undefined) continue;
      const profile = matchProfile(graph, row, rows);
      for (const other of mainProfiles) {
        const scored = scoreMatch(profile, other);
        const candidate = rows.get(other.id);
        if (scored !== null && candidate !== undefined) matches.push({ person: row, candidate, ...scored });
      }
    }
    matches.sort((a, b) => b.score - a.score || compareByName(a.person, b.person) || compareByName(a.candidate, b.candidate));
    return {
      branch,
      people: representatives(graph, branch.members, rows),
      linkedAccounts: branch.members.filter((id) => (rows.get(id)?.userId ?? null) !== null).length,
      matches: matches.slice(0, BRANCH_MATCHES_MAX)
    };
  });

  const shown = planned.flatMap((entry) => [...entry.people, ...entry.matches.flatMap((match) => [match.person, match.candidate])]);
  const avatars = await presignPersonAvatars(deps, shown, viewer, AvatarSize.Small);
  // ADR 0001 §8: no account ids in the report (linked accounts are a count).
  const summary = (row: PersonViewRow): PersonSummary => ({ ...toPersonSummary(row, viewer, avatars), userId: null });
  const items: DisconnectedBranch[] = planned.map((entry) => ({
    id: entry.branch.id,
    people: entry.people.map(summary),
    size: entry.branch.members.length,
    linkedAccounts: entry.linkedAccounts,
    suggestedMatches: entry.matches.map((match) => ({
      person: summary(match.person),
      candidate: summary(match.candidate),
      reasons: match.reasons,
      score: match.score
    }))
  }));
  return { rootPersonId: rootId, items, nextCursor: null, total: branches.length };
}
