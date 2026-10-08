/**
 * Family revisions (`person_revisions`, WP-4.1): the admin-only undo history.
 *
 * [SEC] Snapshots hold PII (names, dates, birthplace, bio) and are read only
 * by admin routes. They never contain emails, contacts, object keys or
 * tokens: the person snapshot is built from an explicit column list, and the
 * photo snapshot only says whether there is a photo. Every snapshot carries
 * `personId` (DB CHECK, Security L2) so a removal request can purge it.
 * Writers call {@link insertRevision} inside the transaction of the change.
 */
import {
  type PersonRevision,
  PersonRevisionAction,
  type PersonRevisionPersonSnapshot,
  type PersonRevisionRelationshipSnapshot,
  type PersonRevisionSnapshot,
  type Relationship
} from "@cuencada/types";
import { type SQL, and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { people, personRevisions, users } from "../../db/schema/index.js";
import type { DbOrTx, Transaction } from "../../lib/audit.js";
import type { PersonRow } from "./repository.js";

/** What a person snapshot is built from (a {@link PersonRow}). */
export type PersonSnapshotSource = PersonRow;

/**
 * Snapshot of a person's editable columns (no keys, no account data beyond
 * the linked id, which admins see anyway).
 *
 * @param row - The person as stored.
 */
export function personSnapshot(row: PersonSnapshotSource): PersonRevisionPersonSnapshot {
  return {
    type: "person",
    personId: row.id,
    id: row.id,
    userId: row.userId,
    fullName: row.fullName,
    nickname: row.nickname,
    familyBranch: row.familyBranch,
    birthYear: row.birthYear,
    deathYear: row.deathYear,
    birthDate: row.birthDate,
    deathDate: row.deathDate,
    birthplace: row.birthplace,
    bio: row.bio,
    deceased: row.deceased
  };
}

/**
 * Snapshot of a relationship, about `personId` (the new or edited person).
 *
 * @param edge - The relationship.
 * @param personId - The person the change was made from.
 */
export function relationshipSnapshot(edge: Relationship, personId: string): PersonRevisionRelationshipSnapshot {
  return {
    type: "relationship",
    personId,
    id: edge.id,
    kind: edge.kind,
    fromPersonId: edge.fromPersonId,
    toPersonId: edge.toPersonId
  };
}

/** One revision to write. */
export interface RevisionInput {
  action: PersonRevisionAction;
  /** The person row it is about; `null` once it is gone (delete). */
  personId: string | null;
  relationshipId?: string | null;
  actorUserId: string;
  before: PersonRevisionSnapshot | null;
  after: PersonRevisionSnapshot | null;
}

/**
 * Insert one revision inside the change's transaction.
 *
 * @param tx - The change's transaction.
 * @param input - The revision.
 * @returns The new revision id.
 */
export async function insertRevision(tx: Transaction, input: RevisionInput): Promise<string> {
  const [row] = await tx
    .insert(personRevisions)
    .values({
      action: input.action,
      personId: input.personId,
      relationshipId: input.relationshipId ?? null,
      actorUserId: input.actorUserId,
      before: input.before,
      after: input.after
    })
    .returning({ id: personRevisions.id });
  if (row === undefined) throw new Error("revision insert returned no row");
  return row.id;
}

/** Actions "Deshacer" can undo. */
const REVERTIBLE: ReadonlySet<PersonRevisionAction> = new Set([
  PersonRevisionAction.PersonCreate,
  PersonRevisionAction.PersonUpdate,
  PersonRevisionAction.PersonDelete,
  PersonRevisionAction.RelationshipCreate,
  PersonRevisionAction.RelationshipDelete
]);

/** True when `action` can be reverted at all (photo and revert rows cannot). */
export function isRevertibleAction(action: PersonRevisionAction): boolean {
  return REVERTIBLE.has(action);
}

/** Columns read for a revision list (with the actor's display name). */
export const revisionViewColumns = {
  id: personRevisions.id,
  personId: personRevisions.personId,
  relationshipId: personRevisions.relationshipId,
  action: personRevisions.action,
  actorUserId: personRevisions.actorUserId,
  actorDisplayName: users.displayName,
  before: personRevisions.before,
  after: personRevisions.after,
  revertedByRevisionId: personRevisions.revertedByRevisionId,
  createdAt: personRevisions.createdAt
};

/** A revision row read with {@link revisionViewColumns}. */
export interface RevisionViewRow {
  id: string;
  personId: string | null;
  relationshipId: string | null;
  action: PersonRevisionAction;
  actorUserId: string | null;
  actorDisplayName: string | null;
  before: PersonRevisionSnapshot | null;
  after: PersonRevisionSnapshot | null;
  revertedByRevisionId: string | null;
  createdAt: Date;
}

/**
 * Map a revision row to the contract.
 *
 * @param row - From {@link revisionViewColumns}.
 */
export function toPersonRevision(row: RevisionViewRow): PersonRevision {
  return {
    id: row.id,
    personId: row.personId,
    relationshipId: row.relationshipId,
    action: row.action,
    actor:
      row.actorUserId === null || row.actorDisplayName === null
        ? null
        : { userId: row.actorUserId, displayName: row.actorDisplayName },
    before: row.before,
    after: row.after,
    revertedByRevisionId: row.revertedByRevisionId,
    revertible: row.revertedByRevisionId === null && isRevertibleAction(row.action),
    createdAt: row.createdAt.toISOString()
  };
}

/**
 * Every revision **about** `personId`: its own rows, and any snapshot that
 * names it as `personId`, `fromPersonId` or `toPersonId` (relationship rows
 * made from the other side, rows written after the person was deleted).
 *
 * @param personId - Person id (may already be deleted).
 */
export function revisionsAboutPerson(personId: string): SQL {
  const matches = (column: typeof personRevisions.before | typeof personRevisions.after): SQL =>
    sql`(${column} ->> 'personId' = ${personId} or ${column} ->> 'fromPersonId' = ${personId} or ${column} ->> 'toPersonId' = ${personId})`;
  return or(eq(personRevisions.personId, personId), matches(personRevisions.before), matches(personRevisions.after)) ?? sql`false`;
}

/**
 * List revisions (newest first) matching `where`, one page plus one row.
 * The keyset is `(created_at, id)` of the cursor's revision, compared in SQL
 * (a JS `Date` would drop the microseconds). A cursor whose revision was
 * purged matches nothing: the page ends.
 *
 * @param db - Client.
 * @param where - Filter.
 * @param afterId - Last revision id of the previous page, or `undefined`.
 * @param limit - Page size (one more row is read to know if there is a next page).
 */
export async function selectRevisionPage(
  db: DbOrTx,
  where: SQL | undefined,
  afterId: string | undefined,
  limit: number
): Promise<RevisionViewRow[]> {
  const keyset =
    afterId === undefined
      ? undefined
      : sql`(${personRevisions.createdAt}, ${personRevisions.id}) < (select r.created_at, r.id from ${personRevisions} r where r.id = ${afterId}::uuid)`;
  return db
    .select(revisionViewColumns)
    .from(personRevisions)
    .leftJoin(users, eq(users.id, personRevisions.actorUserId))
    .where(and(where, keyset))
    .orderBy(desc(personRevisions.createdAt), desc(personRevisions.id))
    .limit(limit + 1);
}

/**
 * Display name for an activity row: the person's current name, else the
 * name in the person snapshot (deleted people), else `null`.
 *
 * @param db - Client.
 * @param rows - Revisions of the page.
 * @returns `revision id → name | null`.
 */
export async function activityNames(db: DbOrTx, rows: readonly RevisionViewRow[]): Promise<Map<string, string | null>> {
  const subjectOf = (row: RevisionViewRow): string | null => row.personId ?? row.after?.personId ?? row.before?.personId ?? null;
  const ids = [...new Set(rows.map(subjectOf).filter((id): id is string => id !== null))];
  const current =
    ids.length === 0
      ? []
      : await db.select({ id: people.id, fullName: people.fullName }).from(people).where(inArray(people.id, ids));
  const nameById = new Map(current.map((row) => [row.id, row.fullName]));
  const snapshotName = (row: RevisionViewRow): string | null => {
    for (const snapshot of [row.after, row.before]) {
      if (snapshot?.type === "person") return snapshot.fullName;
    }
    return null;
  };
  return new Map(
    rows.map((row) => {
      const subject = subjectOf(row);
      return [row.id, (subject === null ? undefined : nameById.get(subject)) ?? snapshotName(row)];
    })
  );
}

/** Revisions older than this are deleted by the retention job (ADR 0001 §6). */
export const REVISION_RETENTION_DAYS = 365;
/** Rows deleted per statement by the retention job. */
export const REVISION_CLEANUP_BATCH = 1000;
/** How often the retention job runs. */
export const REVISION_CLEANUP_INTERVAL_MS = 6 * 60 * 60_000;

const DAY_MS = 24 * 60 * 60_000;

/**
 * Delete revisions older than {@link REVISION_RETENTION_DAYS} as of `now`,
 * in batches. Idempotent; safe to run from several processes.
 *
 * @param db - Root client.
 * @param now - Current time (`app.clock`).
 * @returns How many rows were deleted.
 */
export async function purgeExpiredRevisions(db: DbOrTx, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - REVISION_RETENTION_DAYS * DAY_MS);
  let total = 0;
  for (;;) {
    const candidates = db
      .select({ id: personRevisions.id })
      .from(personRevisions)
      .where(lt(personRevisions.createdAt, cutoff))
      .limit(REVISION_CLEANUP_BATCH);
    const deleted = await db
      .delete(personRevisions)
      .where(and(inArray(personRevisions.id, candidates), lt(personRevisions.createdAt, cutoff)))
      .returning({ id: personRevisions.id });
    total += deleted.length;
    if (deleted.length < REVISION_CLEANUP_BATCH) return total;
  }
}

/**
 * Delete every revision about `personId` (Security L2 purge). Rows that
 * pointed at a purged row through `reverted_by_revision_id` are unlinked by
 * the FK (`SET NULL`).
 *
 * @param tx - Open transaction.
 * @param personId - Person id (may already be deleted).
 * @returns How many rows were deleted.
 */
export async function purgePersonRevisions(tx: Transaction, personId: string): Promise<number> {
  const deleted = await tx.delete(personRevisions).where(revisionsAboutPerson(personId)).returning({ id: personRevisions.id });
  return deleted.length;
}

/** Unreverted revisions in `ids` (for marking a group reverted). */
export function unrevertedIn(ids: readonly string[]): SQL | undefined {
  return and(inArray(personRevisions.id, [...ids]), sql`${personRevisions.revertedByRevisionId} is null`);
}
