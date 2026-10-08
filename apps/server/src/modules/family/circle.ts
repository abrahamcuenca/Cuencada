/**
 * The qualifying own-family circle of a member (ADR 0001 §6, Security M1).
 *
 * The circle decides what a member may edit, which existing people they may
 * attach a new relative to (`relateTo`), and whose living private data
 * (birth year/date, birthplace) they may read. It is computed on the server
 * from the member's **self** (the person linked to their account) over
 * **qualifying edges only**:
 *
 * - an admin edge (`created_by_member = false`, every pre-0004 edge) always
 *   qualifies;
 * - a member edge qualifies only while `created_by_user_id` is set **and**
 *   equals `people.created_by_user_id` of one of its endpoints (the member
 *   created the new person the edge was made for). Anything else, including
 *   an edge whose creating account was deleted, fails closed.
 *
 * Members are: self; self's partners and children; the ancestors of self and
 * of self's partners, up to {@link FAMILY_TREE_MAX_DEPTH} generations; plus
 * the people **this member created themself** and attached, by their own
 * member edge, to someone already in the circle (bounded by the same depth).
 * The last rule lets a member edit the relatives they just added (a sibling
 * added as a child of their parent, a grandchild); it cannot reach anybody
 * else's relatives, because a member edge always joins a person that member
 * created to someone already in their circle. It covers **unlinked** people
 * only and stops at linked ones (PR #46 L1): once an addition gets its own
 * account, the creator keeps it only through the normal rules (e.g. their
 * own child over a qualifying edge).
 */
import { FAMILY_TREE_MAX_DEPTH, RelationshipKind } from "@cuencada/types";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { people, personRelationships } from "../../db/schema/index.js";
import type { DbOrTx } from "../../lib/audit.js";

/** A member's circle. */
export interface FamilyCircle {
  /** The person linked to the member, or `null` (then the circle is empty). */
  selfId: string | null;
  /** Every person id in the qualifying circle, self included. */
  ids: ReadonlySet<string>;
  /**
   * Close relatives over qualifying edges (parents, partners, children of
   * self): who may change a person's tree photo (WP-4.3 rule).
   */
  close: ReadonlySet<string>;
}

/** The circle of someone who is not in the tree. */
export const EMPTY_CIRCLE: FamilyCircle = { selfId: null, ids: new Set(), close: new Set() };

const circleRowSchema = z.object({
  person_id: z.uuid(),
  is_self: z.boolean(),
  is_close: z.boolean()
});

/**
 * SQL fragment: the qualifying edges (see the module comment). Exported so
 * the tests can assert the same rule the walk uses.
 */
export const qualifyingEdgesSql = sql`
  select r.kind, r.from_person_id, r.to_person_id, r.created_by_member, r.created_by_user_id
  from ${personRelationships} r
  where not r.created_by_member
     or (r.created_by_user_id is not null and exists (
           select 1 from ${people} p
           where p.id in (r.from_person_id, r.to_person_id)
             and p.created_by_user_id = r.created_by_user_id))
`;

/**
 * Load the qualifying circle of the account `userId` in **one** statement.
 * Bounded by {@link FAMILY_TREE_MAX_DEPTH} and cycle-safe (`path` guard and
 * `UNION` set semantics), so it terminates on corrupt data.
 *
 * @param db - Client or transaction (inside a write, call it after taking the tree lock).
 * @param userId - The member's account id.
 */
export async function loadFamilyCircle(db: DbOrTx, userId: string): Promise<FamilyCircle> {
  const depth = FAMILY_TREE_MAX_DEPTH;
  const rows = await db.execute(sql`
    with recursive
    q as (${qualifyingEdgesSql}),
    self as (select id from ${people} where user_id = ${userId}::uuid),
    partners as (
      select case when q.from_person_id = s.id then q.to_person_id else q.from_person_id end as id
      from q join self s
        on q.kind = ${RelationshipKind.PartnerOf} and (q.from_person_id = s.id or q.to_person_id = s.id)
    ),
    children as (
      select q.to_person_id as id
      from q join self s on q.kind = ${RelationshipKind.ParentOf} and q.from_person_id = s.id
    ),
    ancestors(id, level, path) as (
      select b.id, 0, array[b.id]
      from (select id from self union select id from partners) b
      union all
      select q.from_person_id, a.level + 1, a.path || q.from_person_id
      from ancestors a
      join q on q.kind = ${RelationshipKind.ParentOf} and q.to_person_id = a.id
      where a.level < ${depth}::int and not q.from_person_id = any(a.path)
    ),
    parents as (
      select q.from_person_id as id
      from q join self s on q.kind = ${RelationshipKind.ParentOf} and q.to_person_id = s.id
    ),
    base as (select id from ancestors union select id from children),
    own(id, level) as (
      select id, 0 from base
      union
      select np.id, o.level + 1
      from own o
      join q on q.created_by_member and q.created_by_user_id = ${userId}::uuid
            and (q.from_person_id = o.id or q.to_person_id = o.id)
      join ${people} np
        on np.id = case when q.from_person_id = o.id then q.to_person_id else q.from_person_id end
       and np.created_by_user_id = ${userId}::uuid
       -- PR #46 Security L1: an addition that got its own account leaves
       -- the creator's own-additions circle, and the walk stops there.
       and np.user_id is null
      where o.level < ${depth}::int
    )
    select distinct
      o.id::text as person_id,
      exists(select 1 from self s where s.id = o.id) as is_self,
      (o.id in (select id from partners union select id from children union select id from parents)) as is_close
    from own o
  `);
  const parsed = z.array(circleRowSchema).safeParse(Array.from(rows));
  // Server-side data: a shape mismatch is a bug (500), never a client error.
  if (!parsed.success) throw new Error("family circle query returned an unexpected row shape");
  const ids = new Set<string>();
  const close = new Set<string>();
  let selfId: string | null = null;
  for (const row of parsed.data) {
    ids.add(row.person_id);
    if (row.is_close) close.add(row.person_id);
    if (row.is_self) selfId = row.person_id;
  }
  return { selfId, ids, close };
}
