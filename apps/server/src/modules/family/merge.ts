/**
 * "Fusionar personas" (WP-4.5) [SEC]: merge a duplicate tree person into the
 * person that stays, and undo it. Admin-only (the routes check the role).
 *
 * One transaction, lock order **tree → keep person → duplicate person →
 * invites** (the order every family write and invite accept uses):
 *
 * - **Account:** a linked duplicate moves its link to an unlinked keep; both
 *   linked → 409 `MERGE_BOTH_LINKED` (an account merge is out of scope).
 * - **Fields:** keep's values, filling its blanks from the duplicate
 *   (`defaultMergeChoices`), with per-field overrides; the result goes
 *   through `personDatesIssue()` (400 instead of a CHECK 500).
 * - **Relationships:** the duplicate's edges are re-pointed to keep **with
 *   the same id, creator and `created_by_member`** (Security M1 provenance),
 *   through `insertRelationship` (cycle and 2-parent checks under the tree
 *   lock). Exact duplicates of keep's edges and keep↔duplicate links are
 *   dropped. Any rule failure → 409 `MERGE_CONFLICT`, one detail per edge.
 * - **Photo:** keep's tree photo stays; else the duplicate's moves. When
 *   both had one, the duplicate's objects are returned for deletion after
 *   the commit (`personPhotoObjects.ts`). Pending `person_photo_uploads`
 *   move to keep.
 * - **Other references to `people.id`:** invites (pending ones move only
 *   when keep can still be invited: unlinked, living, no pending invite of
 *   its own; otherwise they are revoked; non-pending ones move as history)
 *   and `cuencada_attendance` (moved, or dropped where keep already has that
 *   edition). `person_revisions` rows keep pointing at the duplicate's id
 *   through their snapshots (the FK nulls `person_id`); a merge undo re-points
 *   them.
 * - **Delete** the duplicate with `deletePersonTx` (no per-edge revisions:
 *   the merge revision records everything).
 * - **History:** one `person.merge` revision (`before` = both snapshots and
 *   what moved; `after` = the result), plus an audit row with ids and counts.
 *
 * The preview runs the same code in a transaction that is always rolled
 * back (`dryRun`), so what it shows is what the merge would do.
 */
import {
  AuditAction,
  AuditEntityType,
  FamilyIssueCode,
  InviteStatus,
  MergeConflictReason,
  MergeEdgeOutcome,
  type PersonDateIssue,
  type PersonMergeChoices,
  type PersonMergeEdgeRecord,
  type PersonMergePhotoRecord,
  type PersonMergeValues,
  type PersonRevisionMergeSnapshot,
  type PersonRevisionPersonSnapshot,
  type PersonRevisionSnapshot,
  PersonRevisionAction,
  RelationshipKind,
  mergedPersonValues,
  personDatesIssue
} from "@cuencada/types";
import { and, count, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { cuencadaAttendance, invites, people, personPhotoUploads, personRelationships, personRevisions } from "../../db/schema/index.js";
import { recordAudit, type Transaction } from "../../lib/audit.js";
import { AppError, isAppError } from "../../lib/errors.js";
import { invitePendingSql } from "../invites/service.js";
import { personPhotoObjectKeys } from "./personPhotoObjects.js";
import { MAX_PARENTS, insertRelationship, isAncestorOrSelf, lockFamilyTree } from "./relationships.js";
import { type PersonRow, personColumns } from "./repository.js";
import { insertRevision, personSnapshot, revisionsAboutPerson } from "./revisions.js";
import {
  FamilyAuditAction,
  PERSON_NOT_FOUND,
  type WriteActor,
  assertLinkable,
  assertPersonDates,
  deletePersonTx,
  lockPersonRow,
  mapPersonWriteError
} from "./writes.js";

/** Spanish messages of the merge and its undo. */
export const MergeMessage = {
  SamePerson: "Elige a dos personas distintas.",
  BothLinked: "Las dos personas tienen cuenta. No se pueden fusionar cuentas: desvincula una de ellas primero.",
  Conflict: "No se pueden fusionar: algunas relaciones romperían las reglas del árbol. Quítalas o corrígelas primero.",
  Cycle: "Esta relación crearía un ciclo: alguien quedaría como su propio ancestro.",
  TooManyParents: "Con esta relación, alguien quedaría con más de dos padres.",
  Stale: "El árbol cambió después de la fusión. Deshaz primero los cambios más recientes.",
  NotRevertible: "Esta fusión ya no se puede deshacer: la persona quitada no se puede volver a crear igual.",
  EdgeNotRestorable: "Una de sus relaciones ya no se puede restaurar (el árbol cambió). Revisa sus relaciones."
} as const;

/** Columns of an edge as a merge reads it (with provenance). */
const edgeColumns = {
  id: personRelationships.id,
  kind: personRelationships.kind,
  fromPersonId: personRelationships.fromPersonId,
  toPersonId: personRelationships.toPersonId,
  createdByMember: personRelationships.createdByMember,
  createdByUserId: personRelationships.createdByUserId
};

/** An edge with provenance. */
type EdgeRow = Omit<PersonMergeEdgeRecord, "outcome">;

/** Edges touching `personId`. */
async function edgesOf(tx: Transaction, personId: string): Promise<EdgeRow[]> {
  return tx
    .select(edgeColumns)
    .from(personRelationships)
    .where(or(eq(personRelationships.fromPersonId, personId), eq(personRelationships.toPersonId, personId)));
}

/** Same relationship (a partner pair in either direction). */
function sameEdge(a: Pick<EdgeRow, "kind" | "fromPersonId" | "toPersonId">, b: Pick<EdgeRow, "kind" | "fromPersonId" | "toPersonId">): boolean {
  if (a.kind !== b.kind) return false;
  if (a.fromPersonId === b.fromPersonId && a.toPersonId === b.toPersonId) return true;
  return a.kind === RelationshipKind.PartnerOf && a.fromPersonId === b.toPersonId && a.toPersonId === b.fromPersonId;
}

/** The editable values of a person row, as merge values. */
export function mergeValuesOf(row: PersonRow): PersonMergeValues {
  return {
    fullName: row.fullName,
    nickname: row.nickname,
    familyBranch: row.familyBranch,
    birthYear: row.birthYear,
    birthDate: row.birthDate,
    deathYear: row.deathYear,
    deathDate: row.deathDate,
    deceased: row.deceased,
    birthplace: row.birthplace,
    bio: row.bio
  };
}

/** Internal person columns a merge needs besides {@link personColumns}. */
interface PersonInternals {
  photoKey: string | null;
  photoUpdatedAt: Date | null;
  createdByUserId: string | null;
}

async function internalsOf(tx: Transaction, id: string): Promise<PersonInternals> {
  const [row] = await tx
    .select({ photoKey: people.photoKey, photoUpdatedAt: people.photoUpdatedAt, createdByUserId: people.createdByUserId })
    .from(people)
    .where(eq(people.id, id))
    .limit(1);
  if (row === undefined) throw new Error("merge: locked person vanished");
  return row;
}

/** A relationship the merge cannot move, and why. */
export interface MergeConflictItem {
  edge: PersonMergeEdgeRecord;
  reason: MergeConflictReason;
}

/** Everything a merge (or its preview) decided. */
export interface MergePlan {
  keep: PersonRow;
  duplicate: PersonRow;
  /** The merged values (before the date check). */
  values: PersonMergeValues;
  datesIssue: PersonDateIssue | null;
  bothLinked: boolean;
  /** The duplicate's account moves to keep. */
  linkMoves: boolean;
  keepRelationshipIds: string[];
  edges: PersonMergeEdgeRecord[];
  conflicts: MergeConflictItem[];
  photo: PersonMergePhotoRecord;
  invites: { move: string[]; revoke: string[] };
  attendance: { move: string[]; droppedCuencadaIds: string[] };
}

/** Result of a committed merge. */
export interface MergeResult {
  keepId: string;
  duplicateId: string;
  revisionId: string;
  /** The duplicate's losing tree-photo objects: delete after the commit. */
  photoKeys: string[];
}

/** Options of {@link mergePeopleTx}. */
export interface MergeOptions {
  /** Plan only (the caller rolls the transaction back): never throws for both-linked, dates or conflicts. */
  dryRun: boolean;
  /** Current time (pending invites). */
  now: Date;
}

/**
 * Move the duplicate's edges to keep, collecting conflicts instead of
 * throwing. The duplicate's edges are deleted first, then each one is
 * re-inserted pointing at keep with its own id and provenance.
 */
async function moveEdges(
  tx: Transaction,
  keepId: string,
  duplicateId: string
): Promise<{ keepRelationshipIds: string[]; edges: PersonMergeEdgeRecord[]; conflicts: MergeConflictItem[] }> {
  const keepEdges = await edgesOf(tx, keepId);
  const duplicateEdges = await edgesOf(tx, duplicateId);
  const isLink = (edge: EdgeRow): boolean =>
    (edge.fromPersonId === keepId && edge.toPersonId === duplicateId) || (edge.fromPersonId === duplicateId && edge.toPersonId === keepId);
  const keptEdges = keepEdges.filter((edge) => !isLink(edge));
  if (duplicateEdges.length > 0) {
    await tx.delete(personRelationships).where(inArray(personRelationships.id, duplicateEdges.map((edge) => edge.id)));
  }
  const edges: PersonMergeEdgeRecord[] = [];
  const conflicts: MergeConflictItem[] = [];
  for (const edge of duplicateEdges) {
    if (isLink(edge)) {
      edges.push({ ...edge, outcome: MergeEdgeOutcome.Self });
      continue;
    }
    const moved = {
      kind: edge.kind,
      fromPersonId: edge.fromPersonId === duplicateId ? keepId : edge.fromPersonId,
      toPersonId: edge.toPersonId === duplicateId ? keepId : edge.toPersonId
    };
    if (keptEdges.some((existing) => sameEdge(existing, moved))) {
      edges.push({ ...edge, outcome: MergeEdgeOutcome.Duplicate });
      continue;
    }
    const record: PersonMergeEdgeRecord = { ...edge, outcome: MergeEdgeOutcome.Moved };
    edges.push(record);
    if (moved.kind === RelationshipKind.ParentOf) {
      if (await isAncestorOrSelf(tx, moved.toPersonId, moved.fromPersonId)) {
        conflicts.push({ edge: record, reason: MergeConflictReason.Cycle });
        continue;
      }
      const [parents] = await tx
        .select({ total: count() })
        .from(personRelationships)
        .where(and(eq(personRelationships.kind, RelationshipKind.ParentOf), eq(personRelationships.toPersonId, moved.toPersonId)));
      if ((parents?.total ?? 0) >= MAX_PARENTS) {
        conflicts.push({ edge: record, reason: MergeConflictReason.TooManyParents });
        continue;
      }
    }
    await insertRelationship(tx, moved, edge.createdByUserId, { createdByMember: edge.createdByMember, id: edge.id });
  }
  return { keepRelationshipIds: keptEdges.map((edge) => edge.id), edges, conflicts };
}

/** Pending and other invites naming the duplicate, and whether keep has a pending one. */
async function planInvites(
  tx: Transaction,
  keepId: string,
  duplicateId: string,
  resultCanBeInvited: boolean,
  now: Date
): Promise<{ move: string[]; revoke: string[] }> {
  const rows = await tx
    .select({ id: invites.id, pending: sql<boolean>`${invitePendingSql(now)}` })
    .from(invites)
    .where(eq(invites.personId, duplicateId))
    .orderBy(invites.createdAt, invites.id)
    .for("update");
  const [keepPending] = await tx
    .select({ id: invites.id })
    .from(invites)
    .where(and(eq(invites.personId, keepId), invitePendingSql(now)))
    .limit(1);
  let pendingSlot = resultCanBeInvited && keepPending === undefined;
  const move: string[] = [];
  const revoke: string[] = [];
  for (const row of rows) {
    if (!row.pending) {
      move.push(row.id);
    } else if (pendingSlot) {
      // WP-4.2: at most one pending invite per person.
      move.push(row.id);
      pendingSlot = false;
    } else {
      revoke.push(row.id);
    }
  }
  return { move, revoke };
}

/** Attendance rows of the duplicate: move, or drop where keep already attended. */
async function planAttendance(
  tx: Transaction,
  keepId: string,
  duplicateId: string
): Promise<{ move: string[]; droppedCuencadaIds: string[] }> {
  const rows = await tx
    .select({ id: cuencadaAttendance.id, cuencadaId: cuencadaAttendance.cuencadaId, personId: cuencadaAttendance.personId })
    .from(cuencadaAttendance)
    .where(inArray(cuencadaAttendance.personId, [keepId, duplicateId]));
  const keepEditions = new Set(rows.filter((row) => row.personId === keepId).map((row) => row.cuencadaId));
  const move: string[] = [];
  const droppedCuencadaIds: string[] = [];
  for (const row of rows) {
    if (row.personId !== duplicateId) continue;
    if (keepEditions.has(row.cuencadaId)) droppedCuencadaIds.push(row.cuencadaId);
    else move.push(row.id);
  }
  return { move, droppedCuencadaIds };
}

/** 409 `MERGE_CONFLICT` with one detail per relationship (ids and kinds only). */
function conflictError(conflicts: readonly MergeConflictItem[]): AppError {
  return new AppError("CONFLICT", MergeMessage.Conflict, {
    details: conflicts.slice(0, 100).map((conflict) => ({
      path: `relationships.${conflict.edge.id}`,
      message: `${conflict.edge.kind === RelationshipKind.ParentOf ? "Padres e hijos" : "Pareja"}: ${
        conflict.reason === MergeConflictReason.Cycle ? MergeMessage.Cycle : MergeMessage.TooManyParents
      }`,
      code: FamilyIssueCode.MergeConflict
    }))
  });
}

/**
 * Plan (`dryRun`) or perform a merge of `duplicateId` into `keepId` (see the
 * module comment).
 *
 * @param tx - Open transaction; a dry run must be rolled back by the caller.
 * @param keepId - The person that stays.
 * @param duplicateId - The person merged into it and removed.
 * @param choices - Per-field overrides.
 * @param actor - The admin.
 * @param options - Dry run and clock.
 * @returns The plan and, unless `dryRun`, the committed result.
 * @throws AppError 400 (same person, dates), 404 (unknown person), 409 (`MERGE_BOTH_LINKED`, `MERGE_CONFLICT`).
 */
export async function mergePeopleTx(
  tx: Transaction,
  keepId: string,
  duplicateId: string,
  choices: PersonMergeChoices,
  actor: WriteActor,
  options: MergeOptions
): Promise<{ plan: MergePlan; result: MergeResult | null }> {
  if (keepId === duplicateId) {
    throw new AppError("VALIDATION", MergeMessage.SamePerson, { details: [{ path: "duplicateId", message: MergeMessage.SamePerson }] });
  }
  await lockFamilyTree(tx);
  const keep = await lockPersonRow(tx, keepId);
  const duplicate = keep === undefined ? undefined : await lockPersonRow(tx, duplicateId);
  if (keep === undefined || duplicate === undefined) throw new AppError("NOT_FOUND", PERSON_NOT_FOUND);
  const keepInternals = await internalsOf(tx, keepId);
  const duplicateInternals = await internalsOf(tx, duplicateId);

  const bothLinked = keep.userId !== null && duplicate.userId !== null;
  if (bothLinked && !options.dryRun) {
    throw new AppError("CONFLICT", MergeMessage.BothLinked, {
      details: [{ path: "duplicateId", message: MergeMessage.BothLinked, code: FamilyIssueCode.MergeBothLinked }]
    });
  }
  const values = mergedPersonValues(mergeValuesOf(keep), mergeValuesOf(duplicate), choices);
  const datesIssue = personDatesIssue(values);
  if (!options.dryRun) assertPersonDates(values);

  const moved = await moveEdges(tx, keepId, duplicateId);
  if (moved.conflicts.length > 0 && !options.dryRun) throw conflictError(moved.conflicts);

  const userId = keep.userId ?? duplicate.userId;
  const photo: PersonMergePhotoRecord = {
    keep: keepInternals.photoKey !== null,
    duplicate: duplicateInternals.photoKey !== null,
    moved: keepInternals.photoKey === null && duplicateInternals.photoKey !== null,
    duplicateUpdatedAt: duplicateInternals.photoUpdatedAt?.toISOString() ?? null
  };
  const plan: MergePlan = {
    keep,
    duplicate,
    values,
    datesIssue,
    bothLinked,
    linkMoves: keep.userId === null && duplicate.userId !== null,
    keepRelationshipIds: moved.keepRelationshipIds,
    edges: moved.edges,
    conflicts: moved.conflicts,
    photo,
    invites: await planInvites(tx, keepId, duplicateId, userId === null && !values.deceased, options.now),
    attendance: await planAttendance(tx, keepId, duplicateId)
  };
  if (options.dryRun) return { plan, result: null };
  return { plan, result: await applyMerge(tx, plan, duplicateInternals, actor) };
}

/** The committed part of a merge (after the plan passed every check). */
async function applyMerge(
  tx: Transaction,
  plan: MergePlan,
  duplicateInternals: PersonInternals,
  actor: WriteActor
): Promise<MergeResult> {
  const { keep, duplicate } = plan;
  // Pending uploads follow the person; then only the duplicate's current photo can lose.
  await tx.update(personPhotoUploads).set({ personId: keep.id }).where(eq(personPhotoUploads.personId, duplicate.id));
  const photoKeys = plan.photo.keep && plan.photo.duplicate ? await personPhotoObjectKeys(tx, duplicate.id, duplicateInternals.photoKey) : [];

  if (plan.linkMoves) {
    await tx.update(people).set({ userId: null, updatedByUserId: actor.id }).where(eq(people.id, duplicate.id));
    await recordAudit(tx, {
      actorUserId: actor.id,
      action: FamilyAuditAction.Unlinked,
      entityType: AuditEntityType.Person,
      entityId: duplicate.id,
      metadata: { userId: duplicate.userId, reason: "person_merged" },
      ip: actor.ip
    });
  }
  let after: PersonRow | undefined;
  try {
    [after] = await tx
      .update(people)
      .set({
        ...plan.values,
        userId: keep.userId ?? duplicate.userId,
        updatedByUserId: actor.id,
        ...(plan.photo.moved ? { photoKey: duplicateInternals.photoKey, photoUpdatedAt: duplicateInternals.photoUpdatedAt } : {})
      })
      .where(eq(people.id, keep.id))
      .returning(personColumns);
  } catch (error) {
    mapPersonWriteError(error);
  }
  if (after === undefined) throw new AppError("NOT_FOUND", PERSON_NOT_FOUND);
  if (plan.linkMoves) {
    await recordAudit(tx, {
      actorUserId: actor.id,
      action: FamilyAuditAction.Linked,
      entityType: AuditEntityType.Person,
      entityId: keep.id,
      metadata: { userId: after.userId, reason: "person_merged" },
      ip: actor.ip
    });
  }

  // Lock order: tree → keep → duplicate → invites (the invite rows were locked in the plan).
  if (plan.invites.move.length > 0) {
    await tx.update(invites).set({ personId: keep.id }).where(inArray(invites.id, plan.invites.move));
  }
  if (plan.invites.revoke.length > 0) {
    await tx
      .update(invites)
      .set({ status: InviteStatus.Revoked, revokedAt: sql`now()` })
      .where(inArray(invites.id, plan.invites.revoke));
    for (const id of plan.invites.revoke) {
      await recordAudit(tx, {
        actorUserId: actor.id,
        action: AuditAction.InviteRevoked,
        entityType: "invite",
        entityId: id,
        metadata: { personId: duplicate.id, keptPersonId: keep.id, reason: "person_merged" },
        ip: actor.ip
      });
    }
  }
  if (plan.attendance.move.length > 0) {
    await tx.update(cuencadaAttendance).set({ personId: keep.id }).where(inArray(cuencadaAttendance.id, plan.attendance.move));
  }

  // 4.1's delete: no edges or pending invites are left; no per-edge revisions (the merge records them).
  await deletePersonTx(tx, { ...duplicate, userId: null }, actor, { recordRevisions: false });

  const before: PersonRevisionMergeSnapshot = {
    type: "merge",
    personId: keep.id,
    id: keep.id,
    duplicatePersonId: duplicate.id,
    keep: personSnapshot(keep),
    duplicate: personSnapshot(duplicate),
    duplicateCreatedByUserId: duplicateInternals.createdByUserId,
    keepRelationshipIds: plan.keepRelationshipIds,
    relationships: plan.edges,
    photo: plan.photo,
    invites: { moved: plan.invites.move, revoked: plan.invites.revoke },
    attendance: { moved: plan.attendance.move, droppedCuencadaIds: plan.attendance.droppedCuencadaIds }
  };
  const revisionId = await insertRevision(tx, {
    action: PersonRevisionAction.PersonMerge,
    personId: keep.id,
    actorUserId: actor.id,
    before,
    after: personSnapshot(after)
  });
  const countOf = (outcome: MergeEdgeOutcome): number => plan.edges.filter((edge) => edge.outcome === outcome).length;
  await recordAudit(tx, {
    actorUserId: actor.id,
    action: FamilyAuditAction.Merged,
    entityType: AuditEntityType.Person,
    entityId: keep.id,
    metadata: {
      duplicatePersonId: duplicate.id,
      revisionId,
      relationshipsMoved: countOf(MergeEdgeOutcome.Moved),
      relationshipsDropped: countOf(MergeEdgeOutcome.Duplicate) + countOf(MergeEdgeOutcome.Self),
      linkMoved: plan.linkMoves,
      photo: plan.photo.moved ? "moved" : plan.photo.keep ? "kept" : "none",
      invitesMoved: plan.invites.move.length,
      invitesRevoked: plan.invites.revoke.length,
      attendanceMoved: plan.attendance.move.length,
      attendanceDropped: plan.attendance.droppedCuencadaIds.length
    },
    ip: actor.ip
  });
  return { keepId: keep.id, duplicateId: duplicate.id, revisionId, photoKeys };
}

/* -------------------------------------------------------------------------- */
/* Undo                                                                        */
/* -------------------------------------------------------------------------- */

/** What an undone merge restored (recorded on the `person.revert` row). */
export interface MergeUndoRecord {
  personId: string;
  restoredPersonId: string;
  before: PersonRevisionPersonSnapshot;
  after: PersonRevisionPersonSnapshot;
}

const stale = (message: string = MergeMessage.Stale): AppError => new AppError("CONFLICT", message);

function asMerge(snapshot: PersonRevisionSnapshot | null): PersonRevisionMergeSnapshot {
  if (snapshot?.type !== "merge") throw new Error("merge revision without a merge snapshot");
  return snapshot;
}

function asPersonSnapshot(snapshot: PersonRevisionSnapshot | null): PersonRevisionPersonSnapshot {
  if (snapshot?.type !== "person") throw new Error("merge revision without a result snapshot");
  return snapshot;
}

/** The writable columns of a person snapshot. */
function snapshotColumns(snapshot: PersonRevisionPersonSnapshot): PersonMergeValues & { userId: string | null } {
  return { ...mergeValuesOf({ ...snapshot }), userId: snapshot.userId };
}

/** True when `row` still has exactly the snapshot's values. */
function rowMatches(row: PersonRow, snapshot: PersonRevisionPersonSnapshot): boolean {
  return JSON.stringify(snapshotColumns(personSnapshot(row))) === JSON.stringify(snapshotColumns(snapshot));
}

/**
 * Undo a `person.merge` ("Deshacer"), when nothing changed since: the kept
 * person still has exactly the merged values and relationships, there is no
 * later revision about either person, and the duplicate's id is free. The
 * duplicate is re-created **with its old id**, its values, account link
 * (moved back from keep when the merge moved it), creator and photo (only if
 * it moved to keep; a photo deleted because keep had one is not restored),
 * its relationships with their original ids and provenance (re-checked for
 * cycles and parents), its attendance and the invites that moved. Revoked
 * invites stay revoked; moved pending uploads stay with keep.
 *
 * @param tx - Open transaction holding the tree lock and the locked revision.
 * @param revision - The `person.merge` revision.
 * @param actor - The admin.
 * @throws AppError 409 (stale; `MERGE_NOT_REVERTIBLE`).
 */
export async function undoMergeTx(
  tx: Transaction,
  revision: { id: string; before: PersonRevisionSnapshot | null; after: PersonRevisionSnapshot | null },
  actor: WriteActor
): Promise<MergeUndoRecord> {
  const merge = asMerge(revision.before);
  const result = asPersonSnapshot(revision.after);
  const keepId = merge.personId;
  const duplicateId = merge.duplicatePersonId;

  const keep = await lockPersonRow(tx, keepId);
  if (keep === undefined || !rowMatches(keep, result)) throw stale();
  const [taken] = await tx.select({ id: people.id }).from(people).where(eq(people.id, duplicateId)).limit(1);
  if (taken !== undefined) {
    throw new AppError("CONFLICT", MergeMessage.NotRevertible, {
      details: [{ path: "revisionId", message: MergeMessage.NotRevertible, code: FamilyIssueCode.MergeNotRevertible }]
    });
  }
  const [later] = await tx
    .select({ id: personRevisions.id })
    .from(personRevisions)
    .where(
      and(
        sql`${personRevisions.createdAt} > (select r.created_at from ${personRevisions} r where r.id = ${revision.id}::uuid)`,
        or(revisionsAboutPerson(keepId), revisionsAboutPerson(duplicateId))
      )
    )
    .limit(1);
  if (later !== undefined) throw stale();

  const movedEdges = merge.relationships.filter((edge) => edge.outcome === MergeEdgeOutcome.Moved);
  const expected = new Set([...merge.keepRelationshipIds, ...movedEdges.map((edge) => edge.id)]);
  const current = await edgesOf(tx, keepId);
  if (current.length !== expected.size || current.some((edge) => !expected.has(edge.id))) throw stale();

  const internals = await internalsOf(tx, keepId);
  if (merge.photo.moved) {
    if (internals.photoUpdatedAt?.toISOString() !== merge.photo.duplicateUpdatedAt) throw stale();
  } else if ((internals.photoKey !== null) !== merge.photo.keep) {
    throw stale();
  }

  // Keep: its own values back (and no account, when the merge moved the link to it).
  const keepValues = snapshotColumns(merge.keep);
  const duplicateValues = snapshotColumns(merge.duplicate);
  assertPersonDates(keepValues);
  assertPersonDates(duplicateValues);
  let restoredKeep: PersonRow | undefined;
  try {
    [restoredKeep] = await tx
      .update(people)
      .set({
        ...keepValues,
        updatedByUserId: actor.id,
        ...(merge.photo.moved ? { photoKey: null, photoUpdatedAt: null } : {})
      })
      .where(eq(people.id, keepId))
      .returning(personColumns);
  } catch (error) {
    mapPersonWriteError(error);
  }
  if (restoredKeep === undefined) throw stale();
  if (keep.userId !== restoredKeep.userId && keep.userId !== null) {
    await recordAudit(tx, {
      actorUserId: actor.id,
      action: FamilyAuditAction.Unlinked,
      entityType: AuditEntityType.Person,
      entityId: keepId,
      metadata: { userId: keep.userId, reason: "person_merge_reverted" },
      ip: actor.ip
    });
  }

  // The duplicate, with its old id, creator, link and (moved) photo.
  if (duplicateValues.userId !== null) await assertLinkable(tx, duplicateValues.userId, undefined);
  try {
    await tx.insert(people).values({
      id: duplicateId,
      ...duplicateValues,
      createdByUserId: merge.duplicateCreatedByUserId,
      updatedByUserId: actor.id,
      ...(merge.photo.moved ? { photoKey: internals.photoKey, photoUpdatedAt: internals.photoUpdatedAt } : {})
    });
  } catch (error) {
    mapPersonWriteError(error);
  }
  if (duplicateValues.userId !== null) {
    await recordAudit(tx, {
      actorUserId: actor.id,
      action: FamilyAuditAction.Linked,
      entityType: AuditEntityType.Person,
      entityId: duplicateId,
      metadata: { userId: duplicateValues.userId, reason: "person_merge_reverted" },
      ip: actor.ip
    });
  }

  // Relationships: the moved ones leave keep, then every original edge comes back (same id and provenance).
  if (movedEdges.length > 0) {
    await tx.delete(personRelationships).where(inArray(personRelationships.id, movedEdges.map((edge) => edge.id)));
  }
  for (const edge of merge.relationships) {
    try {
      await insertRelationship(
        tx,
        { kind: edge.kind, fromPersonId: edge.fromPersonId, toPersonId: edge.toPersonId },
        edge.createdByUserId,
        { createdByMember: edge.createdByMember, id: edge.id }
      );
    } catch (error) {
      if (isAppError(error) && (error.code === "CONFLICT" || error.code === "NOT_FOUND")) throw stale(MergeMessage.EdgeNotRestorable);
      throw error;
    }
  }

  // Attendance and invites that moved go back; dropped attendance is re-created.
  if (merge.attendance.moved.length > 0) {
    await tx
      .update(cuencadaAttendance)
      .set({ personId: duplicateId })
      .where(and(inArray(cuencadaAttendance.id, merge.attendance.moved), eq(cuencadaAttendance.personId, keepId)));
  }
  if (merge.attendance.droppedCuencadaIds.length > 0) {
    await tx
      .insert(cuencadaAttendance)
      .values(merge.attendance.droppedCuencadaIds.map((cuencadaId) => ({ cuencadaId, personId: duplicateId, createdByUserId: actor.id })))
      .onConflictDoNothing();
  }
  if (merge.invites.moved.length > 0) {
    await tx
      .update(invites)
      .set({ personId: duplicateId })
      .where(and(inArray(invites.id, merge.invites.moved), eq(invites.personId, keepId)));
  }
  // The duplicate's own history points at it again (the delete had nulled `person_id`).
  await tx
    .update(personRevisions)
    .set({ personId: duplicateId })
    .where(
      and(
        isNull(personRevisions.personId),
        sql`coalesce(${personRevisions.after}, ${personRevisions.before}) ->> 'personId' = ${duplicateId}`
      )
    );

  return { personId: keepId, restoredPersonId: duplicateId, before: personSnapshot(keep), after: personSnapshot(restoredKeep) };
}
