/**
 * Person-centred tree view (`GET /api/family/tree`).
 *
 * One recursive CTE walks `parent_of` edges up (ancestors) and down
 * (descendants) from the focus, bounded by `depth` and guarded against
 * cycles by a `path` array, so it terminates even on corrupt, cyclic data
 * inserted behind the service's back. The same statement adds the focus'
 * partners and siblings. People and the edges between them are then loaded
 * with one query each (no N+1): three queries per view in total.
 */
import {
  FAMILY_TREE_MAX_DEPTH,
  type FamilyTreeView,
  type PersonSummary,
  type Relationship,
  RelationshipKind
} from "@cuencada/types";
import { and, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { people, personRelationships } from "../../db/schema/index.js";
import type { DbOrTx } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import {
  compareByName,
  type PersonRow,
  personColumns,
  relationshipColumns,
  toPerson,
  toPersonSummary,
  toRelationship,
  type Viewer
} from "./repository.js";

const TreeRole = {
  Up: "up",
  Down: "down",
  Partner: "partner",
  Sibling: "sibling"
} as const;

const treeRowSchema = z.object({
  person_id: z.uuid(),
  role: z.enum(TreeRole),
  level: z.number().int().min(1)
});
type TreeRow = z.infer<typeof treeRowSchema>;

/**
 * Run the walk. Returns one row per (person, role) at its nearest level.
 *
 * @param db - Client.
 * @param focusId - Centre of the view.
 * @param depth - Generations up and down (already clamped).
 */
async function walkTree(db: DbOrTx, focusId: string, depth: number): Promise<TreeRow[]> {
  const rows = await db.execute(sql`
    with recursive walk(person_id, direction, level, path) as (
      select f.id, d.direction, 0, array[f.id]
      from ${people} f
      cross join (values ('up'::text), ('down'::text)) as d(direction)
      where f.id = ${focusId}::uuid
      union all
      select
        case when w.direction = 'up' then r.from_person_id else r.to_person_id end,
        w.direction,
        w.level + 1,
        w.path || case when w.direction = 'up' then r.from_person_id else r.to_person_id end
      from walk w
      join ${personRelationships} r
        on r.kind = ${RelationshipKind.ParentOf}
       and ((w.direction = 'up' and r.to_person_id = w.person_id)
         or (w.direction = 'down' and r.from_person_id = w.person_id))
      where w.level < ${depth}::int
        and not (case when w.direction = 'up' then r.from_person_id else r.to_person_id end) = any(w.path)
    ),
    lineage as (
      select person_id, direction, min(level) as level
      from walk
      where level > 0
      group by person_id, direction
    ),
    partners as (
      select case when r.from_person_id = ${focusId}::uuid then r.to_person_id else r.from_person_id end as person_id
      from ${personRelationships} r
      where r.kind = ${RelationshipKind.PartnerOf}
        and (r.from_person_id = ${focusId}::uuid or r.to_person_id = ${focusId}::uuid)
    ),
    siblings as (
      select distinct r.to_person_id as person_id
      from ${personRelationships} r
      join lineage p on p.direction = 'up' and p.level = 1 and r.from_person_id = p.person_id
      where r.kind = ${RelationshipKind.ParentOf} and r.to_person_id <> ${focusId}::uuid
    )
    select person_id::text as person_id, direction as role, level::int as level from lineage
    union all
    select person_id::text, 'partner', 1 from partners
    union all
    select person_id::text, 'sibling', 1 from siblings
  `);
  const parsed = z.array(treeRowSchema).safeParse(Array.from(rows));
  // Server-side data: a shape mismatch is a bug (500), never a client 400.
  if (!parsed.success) throw new Error("family tree walk returned an unexpected row shape");
  return parsed.data;
}

/** Summaries for `ids` (deduplicated, missing ids skipped), sorted by name. */
function summariesFor(ids: Iterable<string>, byId: ReadonlyMap<string, PersonRow>): PersonSummary[] {
  const rows: PersonRow[] = [];
  for (const id of new Set(ids)) {
    const row = byId.get(id);
    if (row !== undefined) rows.push(row);
  }
  return rows.sort(compareByName).map(toPersonSummary);
}

/**
 * Build the person-centred view around `focusId`.
 *
 * - `parents`/`children`: one generation up/down.
 * - `partners`, `siblings` (full and half: share at least one parent).
 * - `extended.people`: further generations (`level >= 2`) when `depth > 1`.
 * - `extended.relationships`: every edge between the returned people
 *   (including the focus and the first ring), so the client can lay them out
 *   and admins can find relationship ids to delete.
 *
 * @param db - Client.
 * @param focusId - Centre of the view.
 * @param requestedDepth - Requested depth; clamped to 1..{@link FAMILY_TREE_MAX_DEPTH}.
 * @param viewer - The caller (privacy of the focus' years).
 * @throws AppError `NOT_FOUND` when the focus does not exist.
 */
export async function loadTreeView(
  db: DbOrTx,
  focusId: string,
  requestedDepth: number,
  viewer: Viewer
): Promise<FamilyTreeView> {
  const depth = Math.min(Math.max(Math.trunc(requestedDepth), 1), FAMILY_TREE_MAX_DEPTH);
  const walk = await walkTree(db, focusId, depth);

  const ids = new Set<string>([focusId, ...walk.map((row) => row.person_id)]);
  const idList = [...ids];
  const rows = await db.select(personColumns).from(people).where(inArray(people.id, idList));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const focus = byId.get(focusId);
  if (focus === undefined) throw new AppError("NOT_FOUND", "No encontramos a esa persona.");

  const edges: Relationship[] = (
    await db
      .select(relationshipColumns)
      .from(personRelationships)
      .where(and(inArray(personRelationships.fromPersonId, idList), inArray(personRelationships.toPersonId, idList)))
  )
    .map(toRelationship)
    .sort((a, b) => a.id.localeCompare(b.id));

  const idsWhere = (predicate: (row: TreeRow) => boolean): string[] =>
    walk.filter(predicate).map((row) => row.person_id);

  return {
    focus: toPerson(focus, viewer),
    parents: summariesFor(idsWhere((row) => row.role === TreeRole.Up && row.level === 1), byId),
    partners: summariesFor(idsWhere((row) => row.role === TreeRole.Partner), byId),
    children: summariesFor(idsWhere((row) => row.role === TreeRole.Down && row.level === 1), byId),
    siblings: summariesFor(idsWhere((row) => row.role === TreeRole.Sibling), byId),
    depth,
    extended: {
      people: summariesFor(
        idsWhere((row) => (row.role === TreeRole.Up || row.role === TreeRole.Down) && row.level >= 2),
        byId
      ),
      relationships: edges
    }
  };
}
