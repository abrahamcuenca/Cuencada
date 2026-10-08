/**
 * Invites linked to family-tree people (WP-4.2) [SEC].
 *
 * - Create: an invite may name a `personId` only when it is email-bound, and
 *   the person is living, has no account and no other pending invite. The
 *   checks run under a row lock on the person, so two concurrent creates for
 *   one person cannot both pass.
 * - Accept: the person row is locked **before** the invite row (the same
 *   order as a person delete, whose FK action updates `invites.person_id`),
 *   then re-checked: still there, still unlinked, still living. Otherwise the
 *   account gets a new person and the fallback is recorded (ids only) in the
 *   `invite.accepted` audit row. `people.user_id` is unique and the link is a
 *   conditional update, so a person can never hold two accounts.
 */
import {
  type AdminInviteCandidate,
  FamilyIssueCode,
  InviteIssueCode
} from "@cuencada/types";
import { and, asc, eq, ilike, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import { invites, people } from "../../db/schema/index.js";
import type { DbOrTx, Transaction } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { invitePendingSql } from "./service.js";

/** Spanish messages of the create-time refusals (shown by the admin form). */
export const InvitePersonMessage = {
  NotFound: "No encontramos a esa persona en el árbol.",
  Deceased: "Esa persona falleció; no se le puede invitar.",
  RequiresBound: "Para vincular a una persona del árbol, usa una invitación por correo.",
  Linked: "Esa persona ya tiene una cuenta.",
  PendingInvite: "Esa persona ya tiene una invitación pendiente. Reenvíala o revócala antes de crear otra."
} as const;

/** How an accepted invite ended up linking the new account. */
export const PersonLinkOutcome = {
  /** Linked to the invite's person. */
  Linked: "linked",
  /** The invite named no person: a new one was created. */
  Created: "created",
  /** The invite named a person that could no longer be linked: a new one was created. */
  Fallback: "fallback"
} as const;
export type PersonLinkOutcome = (typeof PersonLinkOutcome)[keyof typeof PersonLinkOutcome];

/** Why an accept fell back to a new person. */
export const PersonLinkFallbackReason = {
  /** Deleted (or the invite's `person_id` was cleared) since the invite was created. */
  Deleted: "deleted",
  /** Linked to another account meanwhile. */
  Linked: "linked",
  /** Marked deceased meanwhile. */
  Deceased: "deceased",
  /**
   * The invite is not email-bound (a legacy row, or any path that skipped the
   * create check): an open link never claims a named person (Security L1, PR #44).
   */
  NotBound: "not_bound"
} as const;
export type PersonLinkFallbackReason = (typeof PersonLinkFallbackReason)[keyof typeof PersonLinkFallbackReason];

/** Result of {@link linkAcceptedPerson}; ids only, safe for the audit log. */
export interface PersonLinkResult {
  outcome: PersonLinkOutcome;
  /** The person now linked to the account. */
  personId: string;
  /** The person the invite named, when it named one. */
  requestedPersonId: string | null;
  reason: PersonLinkFallbackReason | null;
}

/** The person fields the invite checks need. */
type LockedPerson = Pick<typeof people.$inferSelect, "id" | "fullName" | "userId" | "deceased">;

/**
 * Lock a person row (`FOR UPDATE`) for the rest of the transaction.
 *
 * @param tx - The open transaction.
 * @param personId - The person.
 * @returns The row, or `undefined` when it does not exist (or was deleted meanwhile).
 */
export async function lockPerson(tx: Transaction, personId: string): Promise<LockedPerson | undefined> {
  const [row] = await tx
    .select({ id: people.id, fullName: people.fullName, userId: people.userId, deceased: people.deceased })
    .from(people)
    .where(eq(people.id, personId))
    .limit(1)
    .for("update");
  return row;
}

/**
 * Whether the person has a pending invite (stored pending, uses left, not expired).
 *
 * @param db - Client or transaction.
 * @param personId - The person.
 * @param now - Current time.
 */
async function hasPendingInvite(db: DbOrTx, personId: string, now: Date): Promise<boolean> {
  const [row] = await db
    .select({ id: invites.id })
    .from(invites)
    .where(and(eq(invites.personId, personId), invitePendingSql(now)))
    .limit(1);
  return row !== undefined;
}

/**
 * The `personId` must go on an email-bound invite. Checked before any lookup,
 * so an open link never reveals anything about the person.
 *
 * @param email - The invite's bound address, or `null` for an open link.
 * @throws AppError 400 `VALIDATION` with `INVITE_PERSON_REQUIRES_BOUND`.
 */
export function assertPersonInviteIsBound(email: string | null): void {
  if (email !== null) return;
  throw new AppError("VALIDATION", undefined, {
    details: [{ path: "personId", message: InvitePersonMessage.RequiresBound, code: InviteIssueCode.PersonRequiresBound }]
  });
}

/**
 * Lock the person and check an invite can be created for them: exists,
 * living, no account, no pending invite. Call inside the create transaction,
 * before inserting the invite, so the pending check holds until commit.
 *
 * @param tx - The create transaction.
 * @param personId - The requested person.
 * @param now - Current time (pending = unexpired).
 * @returns The person's full name (the invite's suggested display name).
 * @throws AppError 400 `VALIDATION` (unknown person; `INVITE_PERSON_DECEASED`),
 *   409 `CONFLICT` (`PERSON_LINKED_TO_OTHER`, `PERSON_HAS_PENDING_INVITE`).
 */
export async function assertInvitablePerson(tx: Transaction, personId: string, now: Date): Promise<string> {
  const person = await lockPerson(tx, personId);
  if (person === undefined) {
    throw new AppError("VALIDATION", undefined, { details: [{ path: "personId", message: InvitePersonMessage.NotFound }] });
  }
  if (person.deceased) {
    throw new AppError("VALIDATION", undefined, {
      details: [{ path: "personId", message: InvitePersonMessage.Deceased, code: InviteIssueCode.PersonDeceased }]
    });
  }
  if (person.userId !== null) {
    throw new AppError("CONFLICT", InvitePersonMessage.Linked, {
      details: [{ path: "personId", message: InvitePersonMessage.Linked, code: FamilyIssueCode.PersonLinkedToOther }]
    });
  }
  if (await hasPendingInvite(tx, personId, now)) {
    throw new AppError("CONFLICT", InvitePersonMessage.PendingInvite, {
      details: [
        { path: "personId", message: InvitePersonMessage.PendingInvite, code: InviteIssueCode.PersonHasPendingInvite }
      ]
    });
  }
  return person.fullName;
}

/**
 * On accept: link the new account to the invite's person when it is still
 * there, unlinked and living; otherwise create a person for the account.
 *
 * The caller must have locked the person ({@link lockPerson}) **before** the
 * invite row and pass the result as `locked`; `requestedPersonId` is what the
 * invite named when it was first read, `invitePersonId` what the locked
 * invite row says now (`null` once a person delete cleared it).
 *
 * @param tx - The accept transaction.
 * @param input - The ids, the locked person and the new account.
 * @returns What happened, ids only.
 */
export async function linkAcceptedPerson(
  tx: Transaction,
  input: {
    requestedPersonId: string | null;
    invitePersonId: string | null;
    /** The invite's bound address; `null` for an open link. */
    inviteEmail: string | null;
    locked: LockedPerson | undefined;
    userId: string;
    fullName: string;
  }
): Promise<PersonLinkResult> {
  const { requestedPersonId, invitePersonId, inviteEmail, locked, userId, fullName } = input;
  let reason: PersonLinkFallbackReason | null = null;
  if (requestedPersonId !== null) {
    if (inviteEmail === null) reason = PersonLinkFallbackReason.NotBound;
    else if (locked === undefined || invitePersonId !== requestedPersonId) reason = PersonLinkFallbackReason.Deleted;
    else if (locked.userId !== null) reason = PersonLinkFallbackReason.Linked;
    else if (locked.deceased) reason = PersonLinkFallbackReason.Deceased;
    else {
      // Belt and braces: the row is locked, but the update re-states every condition.
      const linked = await tx
        .update(people)
        .set({ userId })
        .where(and(eq(people.id, requestedPersonId), isNull(people.userId), eq(people.deceased, false)))
        .returning({ id: people.id });
      if (linked.length > 0) {
        return { outcome: PersonLinkOutcome.Linked, personId: requestedPersonId, requestedPersonId, reason: null };
      }
      reason = PersonLinkFallbackReason.Linked;
    }
  }
  const [created] = await tx.insert(people).values({ userId, fullName, createdByUserId: userId }).returning({ id: people.id });
  if (created === undefined) throw new Error("accept invite: person insert returned no row");
  return {
    outcome: requestedPersonId === null ? PersonLinkOutcome.Created : PersonLinkOutcome.Fallback,
    personId: created.id,
    requestedPersonId,
    reason
  };
}

/** Escape `%`, `_` and `\` for an `ILIKE` pattern. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** Person columns of an {@link AdminInviteCandidate} (`pendingInvite` comes from {@link withPendingFlags}). */
const candidateColumns = {
  id: people.id,
  fullName: people.fullName,
  nickname: people.nickname,
  familyBranch: people.familyBranch,
  birthYear: people.birthYear,
  deathYear: people.deathYear,
  deceased: people.deceased,
  linked: sql<boolean>`${people.userId} is not null`
};

type CandidateRow = Omit<AdminInviteCandidate, "pendingInvite">;

/**
 * Add `pendingInvite` to each row with one query over the page's ids. (A
 * correlated subquery in the select list would render unqualified column
 * names in Drizzle's single-table selection.)
 */
async function withPendingFlags(db: DbOrTx, rows: CandidateRow[], now: Date): Promise<AdminInviteCandidate[]> {
  if (rows.length === 0) return [];
  const pending = await db
    .selectDistinct({ personId: invites.personId })
    .from(invites)
    .where(and(inArray(invites.personId, rows.map((row) => row.id)), invitePendingSql(now)));
  const ids = new Set(pending.map((row) => row.personId));
  return rows.map((row) => ({ ...row, pendingInvite: ids.has(row.id) }));
}

/**
 * Picker search: living people without an account whose name, nickname or
 * branch matches `q`, ordered by name. People with a pending invite are
 * included and flagged.
 *
 * @param db - Client.
 * @param q - Trimmed, non-empty search text.
 * @param limit - Row cap.
 * @param now - Current time (pending = unexpired).
 */
export async function searchInviteCandidates(db: DbOrTx, q: string, limit: number, now: Date): Promise<AdminInviteCandidate[]> {
  const term = `%${escapeLike(q)}%`;
  const match: SQL | undefined = or(ilike(people.fullName, term), ilike(people.nickname, term), ilike(people.familyBranch, term));
  const rows = await db
    .select(candidateColumns)
    .from(people)
    .where(and(match, isNull(people.userId), eq(people.deceased, false)))
    .orderBy(asc(sql`lower(${people.fullName})`), asc(people.id))
    .limit(limit);
  return withPendingFlags(db, rows, now);
}

/**
 * One person's invite status (any person: the "Invitar" button decides from it).
 *
 * @param db - Client.
 * @param personId - The person.
 * @param now - Current time.
 */
export async function findInviteCandidate(db: DbOrTx, personId: string, now: Date): Promise<AdminInviteCandidate | undefined> {
  const rows = await db.select(candidateColumns).from(people).where(eq(people.id, personId)).limit(1);
  const [row] = await withPendingFlags(db, rows, now);
  return row;
}
