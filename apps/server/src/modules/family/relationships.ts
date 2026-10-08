/**
 * Relationship writes. Every insert runs in one transaction that first takes
 * a transaction-scoped advisory lock on the family tree, so the cycle check
 * and the parent-count check see every committed edge and no concurrent
 * insert can slip between check and insert (A→B and B→A at the same time:
 * exactly one wins). The lock is released at commit/rollback.
 */
import { type CreateRelationshipInput, type Relationship, RelationshipKind } from "@cuencada/types";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { people, personRelationships } from "../../db/schema/index.js";
import type { Transaction } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { PgErrorCode, pgErrorInfo } from "./db-errors.js";
import { relationshipColumns, toRelationship } from "./repository.js";

/** A person has at most two recorded parents. */
export const MAX_PARENTS = 2;

const CYCLE_MESSAGE = "Esta relación crearía un ciclo: la persona ya es ancestro de la otra.";
const DUPLICATE_MESSAGE = "Esa relación ya existe.";
const TOO_MANY_PARENTS_MESSAGE = "Esta persona ya tiene dos padres registrados.";
const SELF_MESSAGE = "Una persona no puede relacionarse consigo misma.";
const MISSING_PERSON_MESSAGE = "No encontramos a una de las personas.";

/**
 * Take the family-tree write lock for the rest of the transaction. The key is
 * a fixed hash, shared by every relationship write.
 *
 * @param tx - Open transaction.
 */
export async function lockFamilyTree(tx: Transaction): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('cuencada:family-tree', 0))`);
}

const existsRowSchema = z.object({ found: z.boolean() });

/**
 * True when `candidateId` is `personId` or one of its ancestors. Uses a
 * `UNION` (set semantics) recursive CTE: each person is visited once, so it
 * terminates on cyclic data and stays linear on pedigrees with shared
 * ancestors.
 *
 * @param tx - Open transaction (holding the tree lock).
 * @param candidateId - Person that would become a descendant.
 * @param personId - Person whose ancestry is searched.
 */
export async function isAncestorOrSelf(tx: Transaction, candidateId: string, personId: string): Promise<boolean> {
  const rows = await tx.execute(sql`
    with recursive ancestors(person_id) as (
      select ${personId}::uuid
      union
      select r.from_person_id
      from ancestors a
      join ${personRelationships} r on r.kind = ${RelationshipKind.ParentOf} and r.to_person_id = a.person_id
    )
    select exists(select 1 from ancestors where person_id = ${candidateId}::uuid) as found
  `);
  const parsed = existsRowSchema.safeParse(rows[0]);
  if (!parsed.success) throw new Error("ancestor check returned an unexpected row shape");
  return parsed.data.found;
}

/** Map a failed insert to a client error, or rethrow. */
function mapInsertError(error: unknown): never {
  const info = pgErrorInfo(error);
  if (info?.code === PgErrorCode.UniqueViolation) {
    throw new AppError("CONFLICT", DUPLICATE_MESSAGE, { cause: error });
  }
  if (info?.code === PgErrorCode.CheckViolation) {
    throw new AppError("VALIDATION", SELF_MESSAGE, {
      details: [{ path: "toPersonId", message: SELF_MESSAGE }],
      cause: error
    });
  }
  if (info?.code === PgErrorCode.ForeignKeyViolation) {
    throw new AppError("NOT_FOUND", MISSING_PERSON_MESSAGE, { cause: error });
  }
  throw error;
}

/** Options of {@link insertRelationship}. */
export interface InsertRelationshipOptions {
  /** A member made it (only together with a new person, `relateTo`). Default `false` (admin). */
  createdByMember?: boolean;
  /** Re-use this id (reverting a `relationship.delete`). */
  id?: string;
}

/**
 * Validate and insert a relationship inside `tx` (which must not have
 * written anything the lock should cover yet).
 *
 * - `parent_of`: rejects a cycle (the child is the parent or one of its
 *   ancestors) and a third parent, both with 409 `CONFLICT`.
 * - `partner_of`: stored with `fromPersonId < toPersonId` (contract).
 * - Duplicates (including a mirrored partner pair) → 409; a self link → 400;
 *   an unknown person → 404.
 *
 * @param tx - Open transaction.
 * @param input - Validated input.
 * @param actorUserId - Admin (or, with `options.createdByMember`, member) creating it.
 * @param options - Provenance (`created_by_member`, Security M1) and an explicit id (revert re-creates the old edge).
 */
export async function insertRelationship(
  tx: Transaction,
  input: CreateRelationshipInput,
  actorUserId: string,
  options: InsertRelationshipOptions = {}
): Promise<Relationship> {
  let fromPersonId = input.fromPersonId.toLowerCase();
  let toPersonId = input.toPersonId.toLowerCase();
  if (fromPersonId === toPersonId) {
    throw new AppError("VALIDATION", SELF_MESSAGE, { details: [{ path: "toPersonId", message: SELF_MESSAGE }] });
  }

  await lockFamilyTree(tx);

  const [found] = await tx
    .select({ total: count() })
    .from(people)
    .where(inArray(people.id, [fromPersonId, toPersonId]));
  if ((found?.total ?? 0) !== 2) throw new AppError("NOT_FOUND", MISSING_PERSON_MESSAGE);

  if (input.kind === RelationshipKind.ParentOf) {
    if (await isAncestorOrSelf(tx, toPersonId, fromPersonId)) {
      throw new AppError("CONFLICT", CYCLE_MESSAGE);
    }
    const [parents] = await tx
      .select({ total: count() })
      .from(personRelationships)
      .where(and(eq(personRelationships.kind, RelationshipKind.ParentOf), eq(personRelationships.toPersonId, toPersonId)));
    if ((parents?.total ?? 0) >= MAX_PARENTS) {
      throw new AppError("CONFLICT", TOO_MANY_PARENTS_MESSAGE);
    }
  } else if (fromPersonId > toPersonId) {
    [fromPersonId, toPersonId] = [toPersonId, fromPersonId];
  }

  try {
    const [row] = await tx
      .insert(personRelationships)
      .values({
        ...(options.id === undefined ? {} : { id: options.id }),
        kind: input.kind,
        fromPersonId,
        toPersonId,
        createdByUserId: actorUserId,
        createdByMember: options.createdByMember ?? false
      })
      .returning(relationshipColumns);
    if (row === undefined) throw new Error("relationship insert returned no row");
    return toRelationship(row);
  } catch (error) {
    mapInsertError(error);
  }
}
