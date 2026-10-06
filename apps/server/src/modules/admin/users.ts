/**
 * Admin users repository [SEC]: the console's user list and the guarded
 * role/status changes. Every write runs inside the caller's transaction after
 * {@link lockAdminUserChanges}, so concurrent admin mutations serialize and
 * the "at least one active admin" rule cannot be raced.
 */
import type { AdminUserListItem, UserRole, UserStatus } from "@cuencada/types";
import { and, desc, eq, ilike, or, type SQL, sql } from "drizzle-orm";
import { people, sessions, users } from "../../db/schema/index.js";
import type { DbOrTx, Transaction } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { escapeLike } from "../family/repository.js";
import { decodeCursor, encodeCursor } from "../media/cursor.js";

/** Advisory lock key that serializes every admin user mutation. */
const ADMIN_USERS_LOCK = "cuencada:admin-users";

/** Spanish messages for the guardrails. */
export const AdminUserMessages = {
  SelfChange: "No puedes cambiar tu propio rol ni desactivar tu propia cuenta.",
  LastAdmin: "Debe quedar al menos un administrador activo.",
  ActorNotAdmin: "Tu cuenta ya no tiene permisos de administración.",
  SelfVerify: "No puedes verificar tu propio correo; usa el enlace de verificación que te enviamos."
} as const;

/** A user row plus the admin-only aggregates. */
interface AdminUserRow {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  mustChangePassword: boolean;
  emailVerifiedAt: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  personId: string | null;
  activeSessionCount: number;
  cursorMicros: string;
}

/** Filters for {@link listAdminUsers}. */
export interface AdminUserListOptions {
  limit: number;
  cursor?: string | undefined;
  q?: string | undefined;
  role?: UserRole | undefined;
  status?: UserStatus | undefined;
  now: Date;
}

/** Live (not revoked, not idle/absolute-expired) sessions of the row's user. */
function activeSessionCountSql(now: Date): SQL<number> {
  const at = now.toISOString();
  return sql<number>`(select count(*) from ${sessions}
    where ${sessions.userId} = ${users.id}
      and ${sessions.revokedAt} is null
      and ${sessions.idleExpiresAt} > ${at}::timestamptz
      and ${sessions.absoluteExpiresAt} > ${at}::timestamptz)::int`;
}

const cursorMicrosSql = sql<string>`(extract(epoch from ${users.createdAt}) * 1000000)::bigint::text`;

/** Filter and size of a {@link queryAdminUsers} call. */
interface AdminUserQuery {
  where: SQL | undefined;
  limit: number;
}

/**
 * Run the admin user query (newest first) and return typed rows.
 *
 * @param db - Client or transaction.
 * @param now - Current time (active-session count).
 * @param query - Filter and page size.
 */
async function queryAdminUsers(db: DbOrTx, now: Date, query: AdminUserQuery): Promise<AdminUserRow[]> {
  return db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
      status: users.status,
      mustChangePassword: users.mustChangePassword,
      emailVerifiedAt: users.emailVerifiedAt,
      lastLoginAt: users.lastLoginAt,
      createdAt: users.createdAt,
      personId: people.id,
      activeSessionCount: activeSessionCountSql(now),
      cursorMicros: cursorMicrosSql
    })
    .from(users)
    .leftJoin(people, eq(people.userId, users.id))
    .where(query.where)
    .orderBy(desc(users.createdAt), desc(users.id))
    .limit(query.limit);
}

function toListItem(row: AdminUserRow): AdminUserListItem {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    status: row.status,
    mustChangePassword: row.mustChangePassword,
    emailVerified: row.emailVerifiedAt !== null,
    personId: row.personId,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    activeSessionCount: row.activeSessionCount,
    createdAt: row.createdAt.toISOString()
  };
}

/**
 * Newest-first, keyset-paged user list. `q` matches display name or email
 * literally (LIKE wildcards are escaped), case-insensitively.
 *
 * @param db - Client or transaction.
 * @param options - Filters, page size, cursor and the current time.
 * @throws AppError `VALIDATION` for a cursor this server did not produce.
 */
export async function listAdminUsers(
  db: DbOrTx,
  options: AdminUserListOptions
): Promise<{ items: AdminUserListItem[]; nextCursor: string | null }> {
  const conditions: Array<SQL | undefined> = [];
  if (options.q !== undefined && options.q !== "") {
    const term = `%${escapeLike(options.q)}%`;
    conditions.push(or(ilike(users.displayName, term), ilike(users.email, term)));
  }
  if (options.role !== undefined) conditions.push(eq(users.role, options.role));
  if (options.status !== undefined) conditions.push(eq(users.status, options.status));
  if (options.cursor !== undefined) {
    const cursor = decodeCursor(options.cursor);
    conditions.push(
      sql`(${users.createdAt}, ${users.id}) < (to_timestamp(0) + ${cursor.micros}::bigint * interval '1 microsecond', ${cursor.id}::uuid)`
    );
  }
  const rows = await queryAdminUsers(db, options.now, { where: and(...conditions), limit: options.limit + 1 });
  const page = rows.slice(0, options.limit);
  const last = page.at(-1);
  return {
    items: page.map(toListItem),
    nextCursor:
      rows.length > options.limit && last !== undefined ? encodeCursor({ micros: last.cursorMicros, id: last.id }) : null
  };
}

/**
 * One user as the console shows it.
 *
 * @param db - Client or transaction.
 * @param userId - The user.
 * @param now - Current time (active-session count).
 * @throws AppError `NOT_FOUND`.
 */
export async function getAdminUser(db: DbOrTx, userId: string, now: Date): Promise<AdminUserListItem> {
  const [row] = await queryAdminUsers(db, now, { where: eq(users.id, userId), limit: 1 });
  if (row === undefined) throw new AppError("NOT_FOUND");
  return toListItem(row);
}

/**
 * Serialize admin user mutations for the rest of the transaction
 * (`pg_advisory_xact_lock`). Statements after it see every earlier mutation
 * committed, because the previous holder released the lock on commit.
 *
 * @param tx - Open transaction.
 */
export async function lockAdminUserChanges(tx: Transaction): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ADMIN_USERS_LOCK}))`);
}

/** The target row, locked for update. */
export interface LockedUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  mustChangePassword: boolean;
  emailVerifiedAt: Date | null;
}

/**
 * Lock and load the target user, after re-checking that the actor is still an
 * active admin (they could have been demoted or disabled by a concurrent
 * request after the auth guard ran).
 *
 * @param tx - Open transaction holding {@link lockAdminUserChanges}.
 * @param actorId - The calling admin.
 * @param targetId - The user to change.
 * @throws AppError `FORBIDDEN` when the actor lost admin rights, `NOT_FOUND` for an unknown target.
 */
export async function lockTargetUser(tx: Transaction, actorId: string, targetId: string): Promise<LockedUser> {
  const [actor] = await tx
    .select({ role: users.role, status: users.status })
    .from(users)
    .where(eq(users.id, actorId))
    .limit(1);
  if (actor === undefined || actor.role !== "admin" || actor.status !== "active") {
    throw new AppError("FORBIDDEN", AdminUserMessages.ActorNotAdmin);
  }
  const [target] = await tx
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
      status: users.status,
      mustChangePassword: users.mustChangePassword,
      emailVerifiedAt: users.emailVerifiedAt
    })
    .from(users)
    .where(eq(users.id, targetId))
    .limit(1)
    .for("update");
  if (target === undefined) throw new AppError("NOT_FOUND");
  return target;
}

/**
 * Number of active admins other than `excludeUserId`.
 *
 * @param tx - Open transaction holding {@link lockAdminUserChanges}.
 * @param excludeUserId - The admin about to lose admin access.
 */
export async function countOtherActiveAdmins(tx: Transaction, excludeUserId: string): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(users)
    .where(and(eq(users.role, "admin"), eq(users.status, "active"), sql`${users.id} <> ${excludeUserId}::uuid`));
  return row?.count ?? 0;
}
