/**
 * Family-tree data access and the privacy-aware mappers.
 *
 * Privacy rules (people are PII; see AGENTS.md):
 * - Admins and the person linked to the viewer's own account see every field.
 * - Living people: never a death year. Living people **linked to an account**
 *   also hide their birth year from other members, because profiles have no
 *   opt-in flag for it yet (fail closed; see WP-T6-BE "Requests").
 * - Living people without an account (children, relatives added by admins)
 *   show the birth year only. There are no birth dates, notes or contact
 *   fields in this module at all.
 * - Deceased people show both years.
 */
import type { Person, PersonSummary, Relationship, UserRole } from "@cuencada/types";
import { eq } from "drizzle-orm";
import { people, personRelationships } from "../../db/schema/index.js";
import type { DbOrTx } from "../../lib/audit.js";

/** Columns every read selects (never `created_by_user_id` or timestamps). */
export const personColumns = {
  id: people.id,
  userId: people.userId,
  fullName: people.fullName,
  nickname: people.nickname,
  familyBranch: people.familyBranch,
  birthYear: people.birthYear,
  deathYear: people.deathYear,
  deceased: people.deceased
};

/** A `people` row as selected by {@link personColumns}. */
export type PersonRow = Pick<
  typeof people.$inferSelect,
  "id" | "userId" | "fullName" | "nickname" | "familyBranch" | "birthYear" | "deathYear" | "deceased"
>;

/** Columns of a relationship read. */
export const relationshipColumns = {
  id: personRelationships.id,
  kind: personRelationships.kind,
  fromPersonId: personRelationships.fromPersonId,
  toPersonId: personRelationships.toPersonId
};

/** Who is looking: drives the privacy rules. */
export interface Viewer {
  id: string;
  role: UserRole;
}

/**
 * True when `viewer` may see every stored field of `row`: admins, and the
 * member whose account is linked to the person.
 */
export function canSeeAllFields(row: Pick<PersonRow, "userId">, viewer: Viewer): boolean {
  return viewer.role === "admin" || (row.userId !== null && row.userId === viewer.id);
}

/**
 * Map a row to the contract `Person`, applying the privacy rules in the
 * module comment. Avatars are `null` until the profile module exposes a
 * presigner (T5).
 *
 * @param row - The person.
 * @param viewer - The caller.
 */
export function toPerson(row: PersonRow, viewer: Viewer): Person {
  const living = !row.deceased;
  const hideBirthYear = living && row.userId !== null && !canSeeAllFields(row, viewer);
  return {
    id: row.id,
    userId: row.userId,
    fullName: row.fullName,
    nickname: row.nickname,
    familyBranch: row.familyBranch,
    birthYear: hideBirthYear ? null : row.birthYear,
    deathYear: living ? null : row.deathYear,
    deceased: row.deceased,
    avatarUrl: null
  };
}

/**
 * Map a row to the lightweight `PersonSummary` (no years, no branch).
 *
 * @param row - The person.
 */
export function toPersonSummary(row: PersonRow): PersonSummary {
  return {
    id: row.id,
    userId: row.userId,
    fullName: row.fullName,
    nickname: row.nickname,
    deceased: row.deceased,
    avatarUrl: null
  };
}

/**
 * Map a relationship row to the contract shape.
 *
 * @param row - The relationship.
 */
export function toRelationship(row: Relationship): Relationship {
  return { id: row.id, kind: row.kind, fromPersonId: row.fromPersonId, toPersonId: row.toPersonId };
}

/**
 * Load one person by id.
 *
 * @param db - Client or transaction.
 * @param id - Person id.
 */
export async function findPerson(db: DbOrTx, id: string): Promise<PersonRow | undefined> {
  const [row] = await db.select(personColumns).from(people).where(eq(people.id, id)).limit(1);
  return row;
}

/**
 * Load the person linked to `userId` (at most one: `people.user_id` is unique).
 *
 * @param db - Client or transaction.
 * @param userId - Account id.
 */
export async function findPersonByUserId(db: DbOrTx, userId: string): Promise<PersonRow | undefined> {
  const [row] = await db.select(personColumns).from(people).where(eq(people.userId, userId)).limit(1);
  return row;
}

/**
 * Escape `%`, `_` and `\` so user text is matched literally by `ILIKE`
 * (Postgres' default escape character is the backslash).
 *
 * @param value - Raw search text.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/** Sort people by name (Spanish collation), then id, for stable output. */
export function compareByName(a: Pick<PersonRow, "fullName" | "id">, b: Pick<PersonRow, "fullName" | "id">): number {
  return a.fullName.localeCompare(b.fullName, "es") || a.id.localeCompare(b.id);
}
