/**
 * Family writes shared by the admin and member routes (WP-4.1). Each helper
 * runs inside the caller's transaction and, in that same transaction:
 *
 * - re-checks the **merged** row with `personDatesIssue()` (so a DB CHECK
 *   never surfaces as a 500),
 * - writes a `person_revisions` row (admin-only undo history, PII), and
 * - writes an `audit_logs` row with ids and field names only.
 *
 * Authorization (admin vs member circle) is the caller's job.
 */
import {
  AuditAction,
  AuditEntityType,
  type CreateRelationshipInput,
  FamilyIssueCode,
  InviteStatus,
  type PersonDateFields,
  PersonRevisionAction,
  type RelateTo,
  RelateKind,
  type Relationship,
  RelationshipKind,
  personDatesIssue
} from "@cuencada/types";
import { and, eq, or, sql } from "drizzle-orm";
import { invites, people, personRelationships, users } from "../../db/schema/index.js";
import { recordAudit, type Transaction } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { PgErrorCode, pgErrorInfo } from "./db-errors.js";
import { insertRelationship, lockFamilyTree } from "./relationships.js";
import { type PersonRow, personColumns, relationshipColumns, toRelationship } from "./repository.js";
import { insertRevision, personSnapshot, relationshipSnapshot } from "./revisions.js";

export const PERSON_NOT_FOUND = "No encontramos a esa persona.";
const USER_ALREADY_LINKED = "Esa cuenta ya está vinculada a otra persona del árbol.";
const USER_NOT_FOUND = "No existe esa cuenta de usuario.";
const YEARS_ORDER = "El año de fallecimiento no puede ser anterior al de nacimiento.";
const DEATH_IMPLIES_DECEASED = "Si hay año de fallecimiento, la persona debe marcarse como fallecida.";
const RELINK_MESSAGE = "Esta persona ya está vinculada a otra cuenta. Desvincúlala primero y luego vincula la nueva.";

/** Who writes, for revisions and audit. */
export interface WriteActor {
  id: string;
  /** `request.ip`. */
  ip: string;
}

/** Audit actions without a well-known `AuditAction` entry. */
export const FamilyAuditAction = {
  Linked: "person.user_linked",
  Unlinked: "person.user_unlinked",
  RevisionReverted: "person.revision_reverted",
  RevisionsPurged: "person.revisions_purged"
} as const;

/** Every editable column of a person (what a create inserts and a PATCH may set). */
export interface PersonWriteValues {
  fullName: string;
  nickname: string | null;
  familyBranch: string | null;
  birthYear: number | null;
  deathYear: number | null;
  birthDate: string | null;
  deathDate: string | null;
  birthplace: string | null;
  bio: string | null;
  deceased: boolean;
  userId: string | null;
}

/** A PATCH: any subset of {@link PersonWriteValues}. */
export type PersonPatch = Partial<PersonWriteValues>;

/**
 * Throw a Spanish 400 when the complete row breaks a date rule.
 *
 * @param row - The merged row (stored values overlaid with the patch).
 * @throws AppError `VALIDATION` with the offending field.
 */
export function assertPersonDates(row: PersonDateFields): void {
  const issue = personDatesIssue(row);
  if (issue !== null) {
    throw new AppError("VALIDATION", issue.message, { details: [{ path: issue.path, message: issue.message }] });
  }
}

/** Map a failed people insert/update to a client error, or rethrow. */
export function mapPersonWriteError(error: unknown): never {
  const info = pgErrorInfo(error);
  if (info?.code === PgErrorCode.UniqueViolation && info.constraint === "people_user_id_unique") {
    throw new AppError("CONFLICT", USER_ALREADY_LINKED, {
      details: [{ path: "userId", message: USER_ALREADY_LINKED }],
      cause: error
    });
  }
  if (info?.code === PgErrorCode.UniqueViolation && info.constraint === "people_pkey") {
    throw new AppError("CONFLICT", "Esa persona ya existe.", { cause: error });
  }
  if (info?.code === PgErrorCode.ForeignKeyViolation) {
    throw new AppError("VALIDATION", USER_NOT_FOUND, { details: [{ path: "userId", message: USER_NOT_FOUND }], cause: error });
  }
  if (info?.code === PgErrorCode.CheckViolation) {
    // Backstop only: assertPersonDates() runs first on the merged row.
    const message = info.constraint === "people_death_implies_deceased_check" ? DEATH_IMPLIES_DECEASED : YEARS_ORDER;
    const path = info.constraint === "people_death_implies_deceased_check" ? "deceased" : "deathYear";
    throw new AppError("VALIDATION", message, { details: [{ path, message }], cause: error });
  }
  throw error;
}

/**
 * Friendly pre-checks for linking `userId` (the unique index and FK remain
 * the backstop for races).
 *
 * @param tx - Open transaction.
 * @param userId - Account to link.
 * @param personId - Person being edited (excluded from the uniqueness check), if any.
 */
export async function assertLinkable(tx: Transaction, userId: string, personId: string | undefined): Promise<void> {
  const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
  if (user === undefined) {
    throw new AppError("VALIDATION", USER_NOT_FOUND, { details: [{ path: "userId", message: USER_NOT_FOUND }] });
  }
  const [linked] = await tx.select({ id: people.id }).from(people).where(eq(people.userId, userId)).limit(1);
  if (linked !== undefined && linked.id !== personId) {
    throw new AppError("CONFLICT", USER_ALREADY_LINKED, { details: [{ path: "userId", message: USER_ALREADY_LINKED }] });
  }
}

/** Record the link/unlink audit entries when `userId` changed. */
async function auditLinkChange(
  tx: Transaction,
  previous: string | null,
  after: PersonRow,
  actor: WriteActor
): Promise<void> {
  if (previous === after.userId) return;
  if (previous !== null) {
    await recordAudit(tx, {
      actorUserId: actor.id,
      action: FamilyAuditAction.Unlinked,
      entityType: AuditEntityType.Person,
      entityId: after.id,
      metadata: { userId: previous },
      ip: actor.ip
    });
  }
  if (after.userId !== null) {
    await recordAudit(tx, {
      actorUserId: actor.id,
      action: FamilyAuditAction.Linked,
      entityType: AuditEntityType.Person,
      entityId: after.id,
      metadata: { userId: after.userId },
      ip: actor.ip
    });
  }
}

/**
 * The edge for "the new person is `relateTo.kind` of `relateTo.personId`".
 *
 * @param newPersonId - The person just created.
 * @param relateTo - Anchor and kind.
 */
export function relateToEdge(newPersonId: string, relateTo: RelateTo): CreateRelationshipInput {
  switch (relateTo.kind) {
    case RelateKind.ParentOf:
      return { kind: RelationshipKind.ParentOf, fromPersonId: newPersonId, toPersonId: relateTo.personId };
    case RelateKind.ChildOf:
      return { kind: RelationshipKind.ParentOf, fromPersonId: relateTo.personId, toPersonId: newPersonId };
    case RelateKind.PartnerOf:
      return { kind: RelationshipKind.PartnerOf, fromPersonId: newPersonId, toPersonId: relateTo.personId };
  }
}

/** Input of {@link createPersonTx}. */
export interface CreatePersonTxInput {
  values: PersonWriteValues;
  relateTo: RelateTo | null;
  actor: WriteActor;
  /** A member made it: the edge is `created_by_member = true` (Security M1). */
  member: boolean;
}

/**
 * Create a person, and optionally the edge to `relateTo` (cycle and
 * 2-parent checks under the tree lock), with revisions and audit.
 *
 * @param tx - Open transaction (members: already locked and circle-checked).
 * @param input - Values, relation and actor.
 * @returns The stored row and the new edge (or `null`).
 */
export async function createPersonTx(tx: Transaction, input: CreatePersonTxInput): Promise<{ row: PersonRow; edge: Relationship | null }> {
  const { values, actor } = input;
  assertPersonDates(values);
  if (values.userId !== null) await assertLinkable(tx, values.userId, undefined);
  if (input.relateTo !== null) await lockFamilyTree(tx);
  let row: PersonRow | undefined;
  try {
    [row] = await tx
      .insert(people)
      .values({ ...values, createdByUserId: actor.id, updatedByUserId: actor.id })
      .returning(personColumns);
  } catch (error) {
    mapPersonWriteError(error);
  }
  if (row === undefined) throw new Error("person insert returned no row");
  await insertRevision(tx, {
    action: PersonRevisionAction.PersonCreate,
    personId: row.id,
    actorUserId: actor.id,
    before: null,
    after: personSnapshot(row)
  });
  await recordAudit(tx, {
    actorUserId: actor.id,
    action: AuditAction.PersonCreated,
    entityType: AuditEntityType.Person,
    entityId: row.id,
    metadata: { linkedUserId: row.userId, ...(input.member ? { member: true } : {}) },
    ip: actor.ip
  });
  await auditLinkChange(tx, null, row, actor);
  let edge: Relationship | null = null;
  if (input.relateTo !== null) {
    edge = await createRelationshipTx(tx, relateToEdge(row.id, input.relateTo), actor, {
      member: input.member,
      personId: row.id
    });
  }
  return { row, edge };
}

/**
 * Apply a PATCH to `before` (merged dates re-checked), with revision and audit.
 *
 * @param tx - Open transaction.
 * @param before - The stored row (read in this transaction).
 * @param patch - Only the keys that were sent.
 * @param actor - Who edits.
 * @param options - `self` marks a member's own-node edit in the audit.
 * @returns The stored row after the update.
 */
export async function updatePersonTx(
  tx: Transaction,
  before: PersonRow,
  patch: PersonPatch,
  actor: WriteActor,
  options: { self?: boolean } = {}
): Promise<PersonRow> {
  assertPersonDates({ ...before, ...patch });
  if (patch.userId !== undefined && patch.userId !== null && patch.userId !== before.userId) {
    // Never move a linked person to another account in one step: the previous
    // account would silently lose its person. Unlink (`userId: null`) first.
    if (before.userId !== null) {
      throw new AppError("CONFLICT", RELINK_MESSAGE, {
        details: [{ path: "userId", message: RELINK_MESSAGE, code: FamilyIssueCode.PersonLinkedToOther }]
      });
    }
    await assertLinkable(tx, patch.userId, before.id);
  }
  let row: PersonRow | undefined;
  try {
    [row] = await tx
      .update(people)
      .set({ ...patch, updatedByUserId: actor.id })
      .where(eq(people.id, before.id))
      .returning(personColumns);
  } catch (error) {
    mapPersonWriteError(error);
  }
  if (row === undefined) throw new AppError("NOT_FOUND", PERSON_NOT_FOUND);
  await insertRevision(tx, {
    action: PersonRevisionAction.PersonUpdate,
    personId: row.id,
    actorUserId: actor.id,
    before: personSnapshot(before),
    after: personSnapshot(row)
  });
  await recordAudit(tx, {
    actorUserId: actor.id,
    action: AuditAction.PersonUpdated,
    entityType: AuditEntityType.Person,
    entityId: row.id,
    metadata: { fields: Object.keys(patch), ...(options.self === true ? { self: true } : {}) },
    ip: actor.ip
  });
  await auditLinkChange(tx, before.userId, row, actor);
  return row;
}

/** Options of {@link deletePersonTx}. */
export interface DeletePersonOptions {
  /** Write revisions (default). `false` after a history purge (removal request). */
  recordRevisions?: boolean;
}

/**
 * Delete a person and its edges (FK cascade) in the caller's transaction,
 * recording a `relationship.delete` revision per edge and a `person.delete`
 * revision first (their `person_id` then becomes `null` through the FK; the
 * snapshots keep the id).
 *
 * @param tx - Open transaction (the tree lock is taken here).
 * @param person - The stored row.
 * @param actor - Who deletes.
 * @param options - See {@link DeletePersonOptions}.
 * @returns The deleted edges.
 */
export async function deletePersonTx(
  tx: Transaction,
  person: PersonRow,
  actor: WriteActor,
  options: DeletePersonOptions = {}
): Promise<Relationship[]> {
  await lockFamilyTree(tx);
  const edges = (
    await tx
      .select(relationshipColumns)
      .from(personRelationships)
      .where(or(eq(personRelationships.fromPersonId, person.id), eq(personRelationships.toPersonId, person.id)))
  ).map(toRelationship);
  if (options.recordRevisions !== false) {
    for (const edge of edges) {
      await insertRevision(tx, {
        action: PersonRevisionAction.RelationshipDelete,
        personId: person.id,
        relationshipId: edge.id,
        actorUserId: actor.id,
        before: relationshipSnapshot(edge, person.id),
        after: null
      });
    }
    await insertRevision(tx, {
      action: PersonRevisionAction.PersonDelete,
      personId: person.id,
      actorUserId: actor.id,
      before: personSnapshot(person),
      after: null
    });
  }
  // Pending invites for this person die with it (the FK would only null `person_id`,
  // leaving a live invite that no longer says who it is for).
  const revoked = await tx
    .update(invites)
    .set({ status: InviteStatus.Revoked, revokedAt: sql`now()` })
    .where(and(eq(invites.personId, person.id), eq(invites.status, InviteStatus.Pending)))
    .returning({ id: invites.id });
  for (const invite of revoked) {
    await recordAudit(tx, {
      actorUserId: actor.id,
      action: AuditAction.InviteRevoked,
      entityType: "invite",
      entityId: invite.id,
      metadata: { personId: person.id, reason: "person_deleted" },
      ip: actor.ip
    });
  }
  const [deleted] = await tx.delete(people).where(eq(people.id, person.id)).returning({ id: people.id });
  if (deleted === undefined) throw new AppError("NOT_FOUND", PERSON_NOT_FOUND);
  await recordAudit(tx, {
    actorUserId: actor.id,
    action: AuditAction.PersonDeleted,
    entityType: AuditEntityType.Person,
    entityId: person.id,
    metadata: { relationships: edges.length },
    ip: actor.ip
  });
  return edges;
}

/**
 * Create an edge (cycle, duplicate and 2-parent checks under the tree lock)
 * with its revision and audit.
 *
 * @param tx - Open transaction.
 * @param input - The edge.
 * @param actor - Who creates it.
 * @param options - `member` provenance; `personId` = the person the revision is about (default: `toPersonId`); `id` to re-use.
 */
export async function createRelationshipTx(
  tx: Transaction,
  input: CreateRelationshipInput,
  actor: WriteActor,
  options: { member?: boolean; personId?: string; id?: string; recordRevision?: boolean } = {}
): Promise<Relationship> {
  const created = await insertRelationship(tx, input, actor.id, {
    createdByMember: options.member ?? false,
    ...(options.id === undefined ? {} : { id: options.id })
  });
  const personId = options.personId ?? created.toPersonId;
  if (options.recordRevision !== false) {
    await insertRevision(tx, {
      action: PersonRevisionAction.RelationshipCreate,
      personId,
      relationshipId: created.id,
      actorUserId: actor.id,
      before: null,
      after: relationshipSnapshot(created, personId)
    });
  }
  await recordAudit(tx, {
    actorUserId: actor.id,
    action: AuditAction.RelationshipCreated,
    entityType: AuditEntityType.Relationship,
    entityId: created.id,
    metadata: {
      kind: created.kind,
      fromPersonId: created.fromPersonId,
      toPersonId: created.toPersonId,
      ...(options.member === true ? { member: true } : {})
    },
    ip: actor.ip
  });
  return created;
}

/**
 * Delete an edge by id with its revision and audit (admin-only route; members
 * never delete edges on their own).
 *
 * @param tx - Open transaction.
 * @param id - Relationship id.
 * @param actor - Who deletes it.
 * @returns The deleted edge, or `undefined` when it does not exist.
 */
export async function deleteRelationshipTx(tx: Transaction, id: string, actor: WriteActor): Promise<Relationship | undefined> {
  await lockFamilyTree(tx);
  const [row] = await tx.delete(personRelationships).where(eq(personRelationships.id, id)).returning(relationshipColumns);
  if (row === undefined) return undefined;
  const deleted = toRelationship(row);
  await insertRevision(tx, {
    action: PersonRevisionAction.RelationshipDelete,
    personId: deleted.toPersonId,
    relationshipId: deleted.id,
    actorUserId: actor.id,
    before: relationshipSnapshot(deleted, deleted.toPersonId),
    after: null
  });
  await recordAudit(tx, {
    actorUserId: actor.id,
    action: AuditAction.RelationshipDeleted,
    entityType: AuditEntityType.Relationship,
    entityId: deleted.id,
    metadata: { kind: deleted.kind, fromPersonId: deleted.fromPersonId, toPersonId: deleted.toPersonId },
    ip: actor.ip
  });
  return deleted;
}

/**
 * Read a person row (no joins) inside a transaction, locking it.
 *
 * @param tx - Open transaction.
 * @param id - Person id.
 */
export async function lockPersonRow(tx: Transaction, id: string): Promise<PersonRow | undefined> {
  const [row] = await tx.select(personColumns).from(people).where(eq(people.id, id)).limit(1).for("update");
  return row;
}
