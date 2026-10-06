/**
 * Directory queries. PII rules enforced here (and again by `toDirectoryEntry`
 * and the response schema):
 *
 * - Only **active** accounts with a profile are listed.
 * - `q` matches display name, full name, the linked person's nickname and
 *   family branch always; city only when `show_city` is on; **never** email
 *   or phone. Otherwise search would be an oracle for hidden contact data.
 * - `city` filters only members with `show_city` on.
 */
import { type DirectoryEntry, toDirectoryEntry } from "@cuencada/types";
import { type AnyColumn, and, eq, or, type SQL, sql } from "drizzle-orm";
import { people, profiles, users } from "../../db/schema/index.js";
import type { DbOrTx } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { type AvatarUrlDeps, avatarUrlFor } from "../profile/avatar.js";
import type { DirectoryCursor } from "./cursor.js";

/** Normalized sort name: the keyset's first column. */
const sortNameSql = sql<string>`lower(${profiles.fullName})`;

/** Escape `%`, `_` and `\` so user text is matched literally inside `ILIKE` (escape char `\`). */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** `column ILIKE '%text%'`, with the text escaped. */
function containsInsensitive(column: AnyColumn, text: string): SQL {
  return sql`${column} ilike ${`%${escapeLikePattern(text)}%`} escape '\\'`;
}

const directorySelection = {
  userId: users.id,
  personId: people.id,
  displayName: users.displayName,
  email: users.email,
  fullName: profiles.fullName,
  familyBranch: profiles.familyBranch,
  city: profiles.city,
  phone: profiles.phone,
  bio: profiles.bio,
  avatarKey: profiles.avatarKey,
  showEmail: profiles.showEmail,
  showPhone: profiles.showPhone,
  showCity: profiles.showCity,
  sortName: sortNameSql
};

/** A listed member's row, before visibility is applied. */
export interface DirectoryRow {
  userId: string;
  personId: string | null;
  displayName: string;
  email: string;
  fullName: string;
  familyBranch: string | null;
  city: string | null;
  phone: string | null;
  bio: string | null;
  avatarKey: string | null;
  showEmail: boolean;
  showPhone: boolean;
  showCity: boolean;
  sortName: string;
}

/**
 * Who appears in the directory at all (list, search and detail).
 * WP-2.1 (migration 0002 adds `profiles.listed_in_directory`): the one-line
 * switch is `and(eq(users.status, "active"), eq(profiles.listedInDirectory, true))`.
 */
const listedSql: SQL | undefined = and(eq(users.status, "active"));

/** Filters for {@link listDirectory}. Blank strings mean "no filter". */
export interface DirectoryFilters {
  q?: string;
  familyBranch?: string;
  city?: string;
}

function searchCondition(q: string): SQL | undefined {
  return or(
    containsInsensitive(users.displayName, q),
    containsInsensitive(profiles.fullName, q),
    containsInsensitive(people.nickname, q),
    containsInsensitive(profiles.familyBranch, q),
    and(eq(profiles.showCity, true), containsInsensitive(profiles.city, q))
  );
}

/**
 * Resolve a cursor to its `(sortName, id)` position.
 *
 * @throws AppError `VALIDATION` when an id-only cursor names no profile.
 */
async function cursorPosition(db: DbOrTx, cursor: DirectoryCursor): Promise<{ sortName: string; id: string }> {
  if (cursor.kind === "name") return { sortName: cursor.sortName, id: cursor.id };
  const [row] = await db
    .select({ sortName: sortNameSql })
    .from(profiles)
    .where(eq(profiles.userId, cursor.id))
    .limit(1);
  if (row === undefined) {
    throw new AppError("VALIDATION", "Cursor inválido.", {
      details: [{ path: "cursor", message: "Cursor inválido." }]
    });
  }
  return { sortName: row.sortName, id: cursor.id };
}

/**
 * One page of listed members ordered by `(lower(full_name), user id)`.
 * Reads `limit + 1` rows; the caller derives `nextCursor` from the extra row.
 *
 * @param db - Client or transaction.
 * @param filters - Trimmed `q`, `familyBranch`, `city`.
 * @param cursor - Position after which to start, or `null`.
 * @param limit - Page size.
 */
export async function listDirectory(
  db: DbOrTx,
  filters: DirectoryFilters,
  cursor: DirectoryCursor | null,
  limit: number
): Promise<DirectoryRow[]> {
  const conditions: Array<SQL | undefined> = [listedSql];
  if (filters.q !== undefined && filters.q !== "") conditions.push(searchCondition(filters.q));
  if (filters.familyBranch !== undefined && filters.familyBranch !== "") {
    conditions.push(sql`lower(${profiles.familyBranch}) = lower(${filters.familyBranch})`);
  }
  if (filters.city !== undefined && filters.city !== "") {
    conditions.push(and(eq(profiles.showCity, true), sql`lower(${profiles.city}) = lower(${filters.city})`));
  }
  if (cursor !== null) {
    const position = await cursorPosition(db, cursor);
    conditions.push(sql`(${sortNameSql}, ${users.id}) > (${position.sortName}, ${position.id}::uuid)`);
  }
  return db
    .select(directorySelection)
    .from(users)
    .innerJoin(profiles, eq(profiles.userId, users.id))
    .leftJoin(people, eq(people.userId, users.id))
    .where(and(...conditions))
    .orderBy(sortNameSql, users.id)
    .limit(limit + 1);
}

/**
 * One listed member, or `null` when unknown, disabled or without a profile.
 *
 * @param db - Client or transaction.
 * @param userId - Target user id.
 */
export async function findDirectoryMember(db: DbOrTx, userId: string): Promise<DirectoryRow | null> {
  const [row] = await db
    .select(directorySelection)
    .from(users)
    .innerJoin(profiles, eq(profiles.userId, users.id))
    .leftJoin(people, eq(people.userId, users.id))
    .where(and(listedSql, eq(users.id, userId)))
    .limit(1);
  return row ?? null;
}

/**
 * Apply the owner's visibility through `toDirectoryEntry` (hidden contact
 * fields are omitted, not `null`) and presign the avatar.
 *
 * @param app - Storage and logger for the avatar URL.
 * @param row - A listed member's row.
 */
export async function toEntry(app: AvatarUrlDeps, row: DirectoryRow): Promise<DirectoryEntry> {
  return toDirectoryEntry({
    userId: row.userId,
    personId: row.personId,
    displayName: row.displayName,
    fullName: row.fullName,
    familyBranch: row.familyBranch,
    avatarUrl: await avatarUrlFor(app, row.avatarKey),
    bio: row.bio,
    email: row.email,
    phone: row.phone,
    city: row.city,
    visibility: {
      showEmail: row.showEmail,
      showPhone: row.showPhone,
      showCity: row.showCity
    }
  });
}
