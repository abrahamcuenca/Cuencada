/**
 * Family-tree data access and the privacy-aware mappers.
 *
 * Privacy rules (people are PII; see AGENTS.md and ADR 0001 §6):
 * - Admins and the person linked to the viewer's own account see every field.
 * - Living people: never a death year/date, and **no birth year, birth date
 *   or birthplace for other members** outside the viewer's **qualifying
 *   own-family circle** (`circle.ts`, WP-4.1), whether or not they are linked
 *   to an account (Security L1, PR #30: a year hidden only for linked people
 *   would reveal which `userId: null` nodes are unlisted accounts; it also
 *   protects minors).
 * - Deceased people show their years, dates and birthplace.
 * - The bio is shown to every reader (every family read is verified-only).
 * - **Unlisted accounts** (`profiles.listed_in_directory = false`): other
 *   members get `userId: null` and `avatarUrl: null` for the linked person,
 *   so the tree cannot be used to find or picture someone who opted out of
 *   the directory. Names and relationships stay (the genealogy is intact).
 *   Only the member themself and admins see the link and the avatar.
 * - Avatars are presigned (via the profile module's `avatarUrlFor`) only
 *   for linked, listed, **active** accounts, or for the member/admins.
 */
import type { Person, PersonSummary, Relationship, UserRole, UserStatus } from "@cuencada/types";
import { eq, type SQL } from "drizzle-orm";
import { people, personRelationships, profiles, users } from "../../db/schema/index.js";
import type { DbOrTx } from "../../lib/audit.js";
import { type AvatarUrlDeps, avatarUrlFor } from "../profile/avatar.js";
import { AvatarSize } from "../profile/constants.js";

/** Columns every read selects (never `created_by_user_id` or timestamps). */
export const personColumns = {
  id: people.id,
  userId: people.userId,
  fullName: people.fullName,
  nickname: people.nickname,
  familyBranch: people.familyBranch,
  birthYear: people.birthYear,
  deathYear: people.deathYear,
  deceased: people.deceased,
  birthDate: people.birthDate,
  deathDate: people.deathDate,
  birthplace: people.birthplace,
  bio: people.bio
};

/** A `people` row as selected by {@link personColumns}. */
export type PersonRow = Pick<
  typeof people.$inferSelect,
  | "id"
  | "userId"
  | "fullName"
  | "nickname"
  | "familyBranch"
  | "birthYear"
  | "deathYear"
  | "deceased"
  | "birthDate"
  | "deathDate"
  | "birthplace"
  | "bio"
>;

/**
 * {@link personColumns} plus the linked account's directory visibility,
 * avatar key and status (left joins: unlinked people, or accounts without a
 * profile, read `null`). Use for every read that is mapped to a response.
 */
export const personViewColumns = {
  ...personColumns,
  listedInDirectory: profiles.listedInDirectory,
  avatarKey: profiles.avatarKey,
  userStatus: users.status,
  /** Internal only (tree photo, WP-4.3): never serialized. */
  photoKey: people.photoKey,
  /** Internal only (member delete rule): never serialized. */
  createdByUserId: people.createdByUserId,
  /** Internal only (member delete rule: edges made in the same transaction). */
  createdAt: people.createdAt
};

/** A person read with {@link personViewColumns}. */
export type PersonViewRow = PersonRow & {
  listedInDirectory: boolean | null;
  avatarKey: string | null;
  userStatus: UserStatus | null;
  photoKey: string | null;
  createdByUserId: string | null;
  createdAt: Date;
};

/** Ordering and paging for {@link selectPersonViews}. */
export interface PersonViewQueryOptions {
  orderBy?: SQL[];
  limit?: number;
}

/**
 * Read people with {@link personViewColumns} in **one** statement (people
 * left-joined to the linked profile and account).
 *
 * @param db - Client or transaction.
 * @param where - Filter on `people` (optional).
 * @param options - Order and limit.
 */
export async function selectPersonViews(
  db: DbOrTx,
  where: SQL | undefined,
  options: PersonViewQueryOptions = {}
): Promise<PersonViewRow[]> {
  let query = db
    .select(personViewColumns)
    .from(people)
    .leftJoin(profiles, eq(profiles.userId, people.userId))
    .leftJoin(users, eq(users.id, people.userId))
    .where(where)
    .$dynamic();
  if (options.orderBy !== undefined) query = query.orderBy(...options.orderBy);
  if (options.limit !== undefined) query = query.limit(options.limit);
  return query;
}

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
  /**
   * The viewer's qualifying own-family circle (person ids, `circle.ts`),
   * when the route loaded it. Missing = empty: living people's private
   * fields stay hidden (fail closed).
   */
  circle?: ReadonlySet<string> | undefined;
}

/**
 * True when `viewer` may see every stored field of `row`: admins, and the
 * member whose account is linked to the person.
 */
export function canSeeAllFields(row: Pick<PersonRow, "userId">, viewer: Viewer): boolean {
  return viewer.role === "admin" || (row.userId !== null && row.userId === viewer.id);
}

/**
 * True when `viewer` may see a **living** person's birth year, birth date and
 * birthplace: admins, the person themself, and the viewer's qualifying
 * own-family circle (ADR 0001 §6).
 */
export function canSeePrivateLife(row: Pick<PersonRow, "id" | "userId">, viewer: Viewer): boolean {
  return canSeeAllFields(row, viewer) || (viewer.circle?.has(row.id) ?? false);
}

/**
 * True when `viewer` may learn which account is linked to `row`: always for
 * the member themself and admins; for everyone else only while the account
 * is listed in the directory (a missing profile counts as listed: the
 * column's default).
 *
 * @param row - The person, with the linked profile's visibility.
 * @param viewer - The caller.
 */
export function canSeeLink(row: Pick<PersonViewRow, "userId" | "listedInDirectory">, viewer: Viewer): boolean {
  if (row.userId === null) return false;
  return canSeeAllFields(row, viewer) || row.listedInDirectory !== false;
}

/**
 * True when `row`'s avatar may be presigned for `viewer`: the link is
 * visible (see {@link canSeeLink}) and, for other members, the account is
 * active (a disabled account's photo is not shown).
 *
 * @param row - The person, with the linked profile and account.
 * @param viewer - The caller.
 */
export function canSeeAvatar(row: PersonViewRow, viewer: Viewer): boolean {
  if (row.avatarKey === null || !canSeeLink(row, viewer)) return false;
  return canSeeAllFields(row, viewer) || row.userStatus === "active";
}

/** `person id → avatar URL | null`, from {@link presignPersonAvatars}. */
export type PersonAvatarUrls = ReadonlyMap<string, string | null>;

/**
 * Presign the avatars `viewer` may see among `rows`, once per distinct key
 * (batched, in parallel). Rows the viewer may not see get no entry, so the
 * mapper falls back to `null`; a storage failure also degrades to `null`.
 *
 * @param deps - Storage and logger.
 * @param rows - People to map.
 * @param viewer - The caller.
 * @param size - 256 px for a `Person`, 64 px for summaries.
 */
export async function presignPersonAvatars(
  deps: AvatarUrlDeps,
  rows: readonly PersonViewRow[],
  viewer: Viewer,
  size: AvatarSize
): Promise<PersonAvatarUrls> {
  const keyByPerson = new Map<string, string>();
  for (const row of rows) {
    if (row.avatarKey !== null && canSeeAvatar(row, viewer)) keyByPerson.set(row.id, row.avatarKey);
  }
  const keys = [...new Set(keyByPerson.values())];
  const urls = await Promise.all(keys.map((key) => avatarUrlFor(deps, key, size)));
  const urlByKey = new Map(keys.map((key, index) => [key, urls[index] ?? null]));
  return new Map([...keyByPerson].map(([personId, key]) => [personId, urlByKey.get(key) ?? null]));
}

/**
 * Presign and map one person (`Person`, 256 px avatar).
 *
 * @param deps - Storage and logger.
 * @param row - The person.
 * @param viewer - The caller.
 */
export async function toPersonWithAvatar(deps: AvatarUrlDeps, row: PersonViewRow, viewer: Viewer): Promise<Person> {
  const avatars = await presignPersonAvatars(deps, [row], viewer, AvatarSize.Large);
  return toPerson(row, viewer, avatars);
}

/**
 * Map a row to the contract `Person`, applying the privacy rules in the
 * module comment.
 *
 * @param row - The person.
 * @param viewer - The caller.
 * @param avatars - Presigned URLs from {@link presignPersonAvatars} (missing → `null`).
 */
export function toPerson(row: PersonViewRow, viewer: Viewer, avatars: PersonAvatarUrls): Person {
  const living = !row.deceased;
  const hidePrivate = living && !canSeePrivateLife(row, viewer);
  return {
    id: row.id,
    userId: canSeeLink(row, viewer) ? row.userId : null,
    fullName: row.fullName,
    nickname: row.nickname,
    familyBranch: row.familyBranch,
    birthYear: hidePrivate ? null : row.birthYear,
    deathYear: living ? null : row.deathYear,
    deceased: row.deceased,
    avatarUrl: avatars.get(row.id) ?? null,
    birthDate: hidePrivate ? null : row.birthDate,
    deathDate: living ? null : row.deathDate,
    birthplace: hidePrivate ? null : row.birthplace,
    bio: row.bio
  };
}

/**
 * Map a row to the lightweight `PersonSummary` (no years, no branch), with
 * the same link/avatar rules as {@link toPerson}.
 *
 * @param row - The person.
 * @param viewer - The caller.
 * @param avatars - Presigned URLs from {@link presignPersonAvatars} (missing → `null`).
 */
export function toPersonSummary(row: PersonViewRow, viewer: Viewer, avatars: PersonAvatarUrls): PersonSummary {
  return {
    id: row.id,
    userId: canSeeLink(row, viewer) ? row.userId : null,
    fullName: row.fullName,
    nickname: row.nickname,
    deceased: row.deceased,
    avatarUrl: avatars.get(row.id) ?? null
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
export async function findPerson(db: DbOrTx, id: string): Promise<PersonViewRow | undefined> {
  const [row] = await selectPersonViews(db, eq(people.id, id), { limit: 1 });
  return row;
}

/**
 * Load the person linked to `userId` (at most one: `people.user_id` is unique).
 *
 * @param db - Client or transaction.
 * @param userId - Account id.
 */
export async function findPersonByUserId(db: DbOrTx, userId: string): Promise<PersonViewRow | undefined> {
  const [row] = await selectPersonViews(db, eq(people.userId, userId), { limit: 1 });
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
