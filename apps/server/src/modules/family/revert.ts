/**
 * "Deshacer" (`POST /api/admin/revisions/:revisionId/revert`, WP-4.1).
 *
 * Runs in one transaction under the family-tree lock, with the revision row
 * locked. Each action is undone only when the tree still looks the way the
 * revision left it; otherwise 409 `CONFLICT` (stale), so an undo never
 * silently overwrites a later change. The restored row is re-checked with
 * `personDatesIssue()` and the account link rules; re-added edges go through
 * the same cycle and 2-parent checks as any edge.
 *
 * A `person.revert` revision records the undo (snapshots with `personId`),
 * and the undone revision(s) point to it through `reverted_by_revision_id`.
 * Undoing a `person.create` also removes the edges created with it (and marks
 * their `relationship.create` rows reverted); undoing a `person.delete`
 * restores the edges deleted with it. Restored people and edges are recorded
 * as the admin's (`created_by_member = false`): the admin chose to restore them.
 */
import {
  AuditEntityType,
  type PersonRevisionPersonSnapshot,
  PersonRevisionAction,
  type PersonRevisionRelationshipSnapshot,
  type PersonRevisionSnapshot
} from "@cuencada/types";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { people, personRelationships, personRevisions } from "../../db/schema/index.js";
import { recordAudit, type Transaction } from "../../lib/audit.js";
import { AppError, isAppError } from "../../lib/errors.js";
import { lockFamilyTree } from "./relationships.js";
import { personPhotoObjectKeys } from "./personPhoto.js";
import { type PersonRow, personColumns, relationshipColumns, toRelationship } from "./repository.js";
import { insertRevision, isRevertibleAction, personSnapshot, relationshipSnapshot } from "./revisions.js";
import {
  FamilyAuditAction,
  type PersonWriteValues,
  type WriteActor,
  assertLinkable,
  assertPersonDates,
  createRelationshipTx,
  lockPersonRow,
  mapPersonWriteError,
  revokePendingInvites
} from "./writes.js";

const NOT_FOUND = "No encontramos ese cambio.";
const ALREADY = "Este cambio ya se deshizo.";
const NOT_REVERTIBLE = "Este cambio no se puede deshacer.";
const STALE = "La persona cambió después de este cambio. Deshaz primero los cambios más recientes.";
const HAS_OTHER_EDGES = "La persona tiene otras relaciones. Quítalas antes de deshacer su alta.";
const LINKED = "La persona está vinculada a una cuenta. Desvincúlala antes de deshacer su alta.";

const stale = (message = STALE): AppError => new AppError("CONFLICT", message);

/** The editable fields of a person snapshot. */
function snapshotValues(snapshot: PersonRevisionPersonSnapshot): PersonWriteValues {
  return {
    fullName: snapshot.fullName,
    nickname: snapshot.nickname,
    familyBranch: snapshot.familyBranch,
    birthYear: snapshot.birthYear,
    deathYear: snapshot.deathYear,
    birthDate: snapshot.birthDate,
    deathDate: snapshot.deathDate,
    birthplace: snapshot.birthplace,
    bio: snapshot.bio,
    deceased: snapshot.deceased,
    userId: snapshot.userId
  };
}

/** True when the stored row still has exactly the snapshot's values. */
function matchesSnapshot(row: PersonRow, snapshot: PersonRevisionPersonSnapshot): boolean {
  const current = personSnapshot(row);
  return JSON.stringify(snapshotValues(current)) === JSON.stringify(snapshotValues(snapshot));
}

function asPerson(snapshot: PersonRevisionSnapshot | null): PersonRevisionPersonSnapshot {
  if (snapshot?.type !== "person") throw new Error("person revision without a person snapshot");
  return snapshot;
}

function asRelationship(snapshot: PersonRevisionSnapshot | null): PersonRevisionRelationshipSnapshot {
  if (snapshot?.type !== "relationship") throw new Error("relationship revision without a relationship snapshot");
  return snapshot;
}

/** `id` when that person still exists (for the nullable `person_id` FK), else `null`. */
async function existingPersonId(tx: Transaction, id: string): Promise<string | null> {
  const [row] = await tx.select({ id: people.id }).from(people).where(eq(people.id, id)).limit(1);
  return row?.id ?? null;
}

/** Turn "missing person" (404) from a re-added edge into a stale conflict. */
async function restoreEdge(tx: Transaction, snapshot: PersonRevisionRelationshipSnapshot, actor: WriteActor): Promise<void> {
  const [existing] = await tx.select({ id: personRelationships.id }).from(personRelationships).where(eq(personRelationships.id, snapshot.id));
  if (existing !== undefined) throw stale();
  try {
    await createRelationshipTx(
      tx,
      { kind: snapshot.kind, fromPersonId: snapshot.fromPersonId, toPersonId: snapshot.toPersonId },
      actor,
      { id: snapshot.id, personId: snapshot.personId, recordRevision: false }
    );
  } catch (error) {
    if (isAppError(error) && error.code === "NOT_FOUND") throw stale("Una de las personas de esa relación ya no existe.");
    throw error;
  }
}

/** A revision as locked for the revert. */
interface LockedRevision {
  id: string;
  action: PersonRevisionAction;
  actorUserId: string | null;
  before: PersonRevisionSnapshot | null;
  after: PersonRevisionSnapshot | null;
  revertedByRevisionId: string | null;
}

/**
 * Sibling revisions written in the same transaction as `revision` (same
 * `created_at`, which is the transaction start time, and same actor) with the
 * given action, about `personId`, not yet reverted.
 */
async function siblingRevisions(
  tx: Transaction,
  revision: LockedRevision,
  action: PersonRevisionAction,
  personId: string
): Promise<Array<{ id: string; snapshot: PersonRevisionSnapshot | null }>> {
  const rows = await tx
    .select({ id: personRevisions.id, before: personRevisions.before, after: personRevisions.after })
    .from(personRevisions)
    .where(
      and(
        eq(personRevisions.action, action),
        // Compared in SQL: a JS Date would drop the microseconds.
        sql`${personRevisions.createdAt} = (select r.created_at from ${personRevisions} r where r.id = ${revision.id}::uuid)`,
        revision.actorUserId === null ? sql`${personRevisions.actorUserId} is null` : eq(personRevisions.actorUserId, revision.actorUserId),
        sql`${personRevisions.revertedByRevisionId} is null`,
        sql`coalesce(${personRevisions.after}, ${personRevisions.before}) ->> 'personId' = ${personId}`
      )
    )
    .for("update");
  return rows.map((row) => ({ id: row.id, snapshot: row.after ?? row.before }));
}

/** What an undo did, recorded on the `person.revert` row. */
interface RevertRecord {
  personId: string;
  relationshipId?: string | null;
  before: PersonRevisionSnapshot | null;
  after: PersonRevisionSnapshot | null;
  /** Revisions undone together with the target (edges created/deleted with a person). */
  alsoReverted: string[];
}

async function undoPersonUpdate(tx: Transaction, revision: LockedRevision, actor: WriteActor): Promise<RevertRecord> {
  const before = asPerson(revision.before);
  const after = asPerson(revision.after);
  const current = await lockPersonRow(tx, after.id);
  if (current === undefined || !matchesSnapshot(current, after)) throw stale();
  const values = snapshotValues(before);
  assertPersonDates(values);
  if (values.userId !== null && values.userId !== current.userId) await assertLinkable(tx, values.userId, current.id);
  let row: PersonRow | undefined;
  try {
    [row] = await tx
      .update(people)
      .set({ ...values, updatedByUserId: actor.id })
      .where(eq(people.id, current.id))
      .returning(personColumns);
  } catch (error) {
    mapPersonWriteError(error);
  }
  if (row === undefined) throw stale();
  return { personId: row.id, before: personSnapshot(current), after: personSnapshot(row), alsoReverted: [] };
}

async function undoPersonCreate(tx: Transaction, revision: LockedRevision): Promise<RevertRecord & { deleteId: string }> {
  const after = asPerson(revision.after);
  const current = await lockPersonRow(tx, after.id);
  if (current === undefined || !matchesSnapshot(current, after)) throw stale();
  if (current.userId !== null) throw stale(LINKED);
  const createdWith = await siblingRevisions(tx, revision, PersonRevisionAction.RelationshipCreate, current.id);
  const allowed = new Set(createdWith.map((row) => row.snapshot?.id).filter((id): id is string => id !== undefined));
  const edges = await tx
    .select({ id: personRelationships.id })
    .from(personRelationships)
    .where(or(eq(personRelationships.fromPersonId, current.id), eq(personRelationships.toPersonId, current.id)));
  if (edges.some((edge) => !allowed.has(edge.id))) throw stale(HAS_OTHER_EDGES);
  return {
    personId: current.id,
    before: personSnapshot(current),
    after: null,
    alsoReverted: createdWith.map((row) => row.id),
    deleteId: current.id
  };
}

async function undoPersonDelete(tx: Transaction, revision: LockedRevision, actor: WriteActor): Promise<RevertRecord> {
  const before = asPerson(revision.before);
  if ((await existingPersonId(tx, before.id)) !== null) throw stale();
  const values = snapshotValues(before);
  assertPersonDates(values);
  if (values.userId !== null) await assertLinkable(tx, values.userId, undefined);
  let row: PersonRow | undefined;
  try {
    [row] = await tx
      .insert(people)
      .values({ id: before.id, ...values, createdByUserId: actor.id, updatedByUserId: actor.id })
      .returning(personColumns);
  } catch (error) {
    mapPersonWriteError(error);
  }
  if (row === undefined) throw new Error("person restore returned no row");
  const deletedWith = await siblingRevisions(tx, revision, PersonRevisionAction.RelationshipDelete, before.id);
  for (const sibling of deletedWith) await restoreEdge(tx, asRelationship(sibling.snapshot), actor);
  return { personId: row.id, before: null, after: personSnapshot(row), alsoReverted: deletedWith.map((row) => row.id) };
}

async function undoRelationshipCreate(tx: Transaction, revision: LockedRevision): Promise<RevertRecord> {
  const after = asRelationship(revision.after);
  const [deleted] = await tx
    .delete(personRelationships)
    .where(
      and(
        eq(personRelationships.id, after.id),
        eq(personRelationships.kind, after.kind),
        eq(personRelationships.fromPersonId, after.fromPersonId),
        eq(personRelationships.toPersonId, after.toPersonId)
      )
    )
    .returning(relationshipColumns);
  if (deleted === undefined) throw stale("Esa relación ya no existe.");
  return {
    personId: after.personId,
    relationshipId: after.id,
    before: relationshipSnapshot(toRelationship(deleted), after.personId),
    after: null,
    alsoReverted: []
  };
}

async function undoRelationshipDelete(tx: Transaction, revision: LockedRevision, actor: WriteActor): Promise<RevertRecord> {
  const before = asRelationship(revision.before);
  await restoreEdge(tx, before, actor);
  return { personId: before.personId, relationshipId: before.id, before: null, after: before, alsoReverted: [] };
}

/**
 * Undo one revision (see the module comment).
 *
 * @param tx - Open transaction.
 * @param revisionId - The revision to undo.
 * @param actor - The admin.
 * @returns The id of the new `person.revert` revision, and the tree-photo
 *   object keys of a person the undo deleted (the caller deletes them after
 *   the commit, like the admin person delete).
 * @throws AppError `NOT_FOUND` (unknown revision), `CONFLICT` (already reverted, not revertible, or stale), `VALIDATION`.
 */
export async function revertRevisionTx(tx: Transaction, revisionId: string, actor: WriteActor): Promise<RevertResult> {
  await lockFamilyTree(tx);
  const [revision] = await tx
    .select({
      id: personRevisions.id,
      action: personRevisions.action,
      actorUserId: personRevisions.actorUserId,
      before: personRevisions.before,
      after: personRevisions.after,
      revertedByRevisionId: personRevisions.revertedByRevisionId
    })
    .from(personRevisions)
    .where(eq(personRevisions.id, revisionId))
    .limit(1)
    .for("update");
  if (revision === undefined) throw new AppError("NOT_FOUND", NOT_FOUND);
  if (revision.revertedByRevisionId !== null) throw new AppError("CONFLICT", ALREADY);
  if (!isRevertibleAction(revision.action)) throw new AppError("CONFLICT", NOT_REVERTIBLE);

  let record: RevertRecord;
  let deleteId: string | null = null;
  switch (revision.action) {
    case PersonRevisionAction.PersonUpdate:
      record = await undoPersonUpdate(tx, revision, actor);
      break;
    case PersonRevisionAction.PersonCreate: {
      const undo = await undoPersonCreate(tx, revision);
      record = undo;
      deleteId = undo.deleteId;
      break;
    }
    case PersonRevisionAction.PersonDelete:
      record = await undoPersonDelete(tx, revision, actor);
      break;
    case PersonRevisionAction.RelationshipCreate:
      record = await undoRelationshipCreate(tx, revision);
      break;
    case PersonRevisionAction.RelationshipDelete:
      record = await undoRelationshipDelete(tx, revision, actor);
      break;
    default:
      throw new AppError("CONFLICT", NOT_REVERTIBLE);
  }

  // Written before a person delete, so `person_id` can still reference the row (the FK then nulls it).
  const revertId = await insertRevision(tx, {
    action: PersonRevisionAction.PersonRevert,
    personId: await existingPersonId(tx, record.personId),
    relationshipId: record.relationshipId ?? null,
    actorUserId: actor.id,
    before: record.before,
    after: record.after
  });
  const undone = [revision.id, ...record.alsoReverted];
  await tx.update(personRevisions).set({ revertedByRevisionId: revertId }).where(inArray(personRevisions.id, undone));
  let photoKeys: string[] = [];
  if (deleteId !== null) {
    // Same cleanup as any person delete (PR #46 TL): pending invites revoked
    // in this transaction (row already locked: tree → person → invite), photo
    // objects collected for deletion after the commit.
    photoKeys = await personPhotoObjectKeys(tx, deleteId);
    await revokePendingInvites(tx, deleteId, actor);
    await tx.delete(people).where(eq(people.id, deleteId));
  }
  await recordAudit(tx, {
    actorUserId: actor.id,
    action: FamilyAuditAction.RevisionReverted,
    entityType: AuditEntityType.Person,
    entityId: record.personId,
    metadata: { revisionId: revision.id, revertRevisionId: revertId, action: revision.action, undone: undone.length },
    ip: actor.ip
  });
  return { revertId, photoKeys, deletedPersonId: deleteId };
}

/** What {@link revertRevisionTx} did. */
export interface RevertResult {
  /** The new `person.revert` revision. */
  revertId: string;
  /** Bucket objects of a person the undo deleted; delete them after the commit. */
  photoKeys: string[];
  /** The person the undo deleted (undo of a `person.create`), if any. */
  deletedPersonId: string | null;
}
