/**
 * The whole family graph in memory (WP-6.4), for the "one tree" reads:
 * the extended bands, "Árbol completo" (outline and path), the viewer's
 * connection to the root and the "Ramas sin conectar" report.
 *
 * Family scale (hundreds to a few thousand people and edges): one query
 * loads every edge, so each read is a constant number of statements and
 * every walk is cycle-safe (visited sets), even on corrupt data.
 */
import { RelationshipKind } from "@cuencada/types";
import { people, personRelationships } from "../../db/schema/index.js";
import type { DbOrTx } from "../../lib/audit.js";

/** Adjacency of the family graph. */
export interface FamilyGraph {
  /** Every person id (people without edges included when loaded with `withPeople`). */
  ids: ReadonlySet<string>;
  parentsOf: ReadonlyMap<string, readonly string[]>;
  childrenOf: ReadonlyMap<string, readonly string[]>;
  partnersOf: ReadonlyMap<string, readonly string[]>;
}

const EMPTY: readonly string[] = [];

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else if (!list.includes(value)) list.push(value);
}

/** An edge as the graph needs it. */
export interface GraphEdge {
  kind: RelationshipKind;
  fromPersonId: string;
  toPersonId: string;
}

/**
 * Build a graph from edges (and extra isolated people).
 *
 * @param edges - Every relationship.
 * @param personIds - Every person id (so isolated people are components too).
 */
export function buildFamilyGraph(edges: readonly GraphEdge[], personIds: Iterable<string> = []): FamilyGraph {
  const ids = new Set<string>(personIds);
  const parentsOf = new Map<string, string[]>();
  const childrenOf = new Map<string, string[]>();
  const partnersOf = new Map<string, string[]>();
  for (const edge of edges) {
    ids.add(edge.fromPersonId);
    ids.add(edge.toPersonId);
    if (edge.kind === RelationshipKind.ParentOf) {
      push(childrenOf, edge.fromPersonId, edge.toPersonId);
      push(parentsOf, edge.toPersonId, edge.fromPersonId);
    } else {
      push(partnersOf, edge.fromPersonId, edge.toPersonId);
      push(partnersOf, edge.toPersonId, edge.fromPersonId);
    }
  }
  return { ids, parentsOf, childrenOf, partnersOf };
}

/**
 * Load every edge (and, with `withPeople`, every person id) in one or two statements.
 *
 * @param db - Client or transaction.
 * @param options - `withPeople`: include people without edges (the branches report).
 */
export async function loadFamilyGraph(db: DbOrTx, options: { withPeople?: boolean } = {}): Promise<FamilyGraph> {
  const edges = await db
    .select({ kind: personRelationships.kind, fromPersonId: personRelationships.fromPersonId, toPersonId: personRelationships.toPersonId })
    .from(personRelationships);
  const ids = options.withPeople === true ? (await db.select({ id: people.id }).from(people)).map((row) => row.id) : [];
  return buildFamilyGraph(edges, ids);
}

/** Neighbours of `id` in `map` (empty when none). */
export function neighbours(map: ReadonlyMap<string, readonly string[]>, id: string): readonly string[] {
  return map.get(id) ?? EMPTY;
}

/** Ids reachable from each of `ids` through `map` (one step), deduplicated, in first-seen order. */
export function step(map: ReadonlyMap<string, readonly string[]>, ids: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const id of ids) for (const next of neighbours(map, id)) out.add(next);
  return [...out];
}

/**
 * Children shown under `id` in the descendants outline: its own children
 * and its partners' children (a couple's children are often recorded on one
 * parent only), never itself or a partner.
 */
export function outlineChildren(graph: FamilyGraph, id: string): string[] {
  const partners = neighbours(graph.partnersOf, id);
  const out = new Set<string>([...neighbours(graph.childrenOf, id), ...step(graph.childrenOf, partners)]);
  out.delete(id);
  for (const partner of partners) out.delete(partner);
  return [...out];
}

/**
 * The connected component of `start` over every edge (both directions, both kinds).
 *
 * @returns The ids in it (`start` included when it exists in the graph or is given).
 */
export function componentOf(graph: FamilyGraph, start: string): Set<string> {
  const seen = new Set<string>([start]);
  const queue = [start];
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index];
    if (id === undefined) break;
    for (const map of [graph.parentsOf, graph.childrenOf, graph.partnersOf]) {
      for (const next of neighbours(map, id)) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/** Every connected component, each as a set of ids. */
export function components(graph: FamilyGraph): Set<string>[] {
  const assigned = new Set<string>();
  const out: Set<string>[] = [];
  for (const id of graph.ids) {
    if (assigned.has(id)) continue;
    const component = componentOf(graph, id);
    for (const member of component) assigned.add(member);
    out.push(component);
  }
  return out;
}

/**
 * The outline path from `rootId` down to `targetId` (breadth first over
 * {@link outlineChildren}, so the shortest one), or `[]` when the target is
 * not in the root's outline.
 *
 * @param maxLength - Longest path returned (the contract caps it).
 */
export function outlinePath(graph: FamilyGraph, rootId: string, targetId: string, maxLength: number): string[] {
  if (rootId === targetId) return [rootId];
  const previous = new Map<string, string>();
  const seen = new Set<string>([rootId]);
  let frontier = [rootId];
  for (let level = 1; level < maxLength && frontier.length > 0; level += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const child of outlineChildren(graph, id)) {
        if (seen.has(child)) continue;
        seen.add(child);
        previous.set(child, id);
        if (child === targetId) {
          const path = [child];
          let cursor = id;
          path.unshift(cursor);
          while (cursor !== rootId) {
            const parent = previous.get(cursor);
            if (parent === undefined) break;
            path.unshift(parent);
            cursor = parent;
          }
          return path;
        }
        next.push(child);
      }
    }
    frontier = next;
  }
  return [];
}
