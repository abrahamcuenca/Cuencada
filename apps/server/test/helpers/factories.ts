import { randomUUID } from "node:crypto";
import type { UserRole, UserStatus } from "@cuencada/types";
import argon2 from "argon2";
import type { App } from "../../src/app.js";
import { profiles, sessions, users } from "../../src/db/schema/index.js";
import { accessTokenSettings, signAccessToken } from "../../src/lib/tokens.js";
import { TEST_JWT_SECRET } from "./app.js";
import { getTestDb } from "./db.js";

/** Default password for factory users; long enough for the change-password rule. */
export const DEFAULT_TEST_PASSWORD = "correct-horse-battery-staple";

/**
 * Cheap argon2id parameters for tests only. `argon2.verify` reads the
 * parameters from the hash, so the app verifies these hashes unchanged.
 */
const TEST_HASH_OPTIONS = { type: argon2.argon2id, memoryCost: 4096, timeCost: 2, parallelism: 1 } as const;

type UserRow = typeof users.$inferSelect;
type ProfileRow = typeof profiles.$inferSelect;

/** Options for {@link createUser}; every field has a sensible default. */
export interface CreateUserOptions {
  email?: string;
  displayName?: string;
  role?: UserRole;
  status?: UserStatus;
  password?: string;
  mustChangePassword?: boolean;
  /** Sets `email_verified_at` to now; defaults to `false` (the DB default). */
  emailVerified?: boolean;
  profile?: Partial<Omit<typeof profiles.$inferInsert, "id" | "userId">>;
}

/** A persisted user plus the plaintext password needed to log in as them. */
export interface TestUser extends UserRow {
  password: string;
  profile: ProfileRow;
}

/**
 * Insert a user (argon2id hash) and its profile into the worker database.
 *
 * @param options - Field overrides; defaults to an active member with a unique email.
 * @returns The inserted rows plus the plaintext password.
 */
export async function createUser(options: CreateUserOptions = {}): Promise<TestUser> {
  const db = getTestDb();
  const password = options.password ?? DEFAULT_TEST_PASSWORD;
  const email = (options.email ?? `user-${randomUUID()}@example.test`).toLowerCase();
  const displayName = options.displayName ?? "Usuario de Prueba";

  const [user] = await db
    .insert(users)
    .values({
      email,
      displayName,
      passwordHash: await argon2.hash(password, TEST_HASH_OPTIONS),
      role: options.role ?? "member",
      status: options.status ?? "active",
      mustChangePassword: options.mustChangePassword ?? false,
      emailVerifiedAt: options.emailVerified === true ? new Date() : null
    })
    .returning();
  if (!user) throw new Error("createUser: insert returned no user row");

  const [profile] = await db
    .insert(profiles)
    .values({ fullName: displayName, ...options.profile, userId: user.id })
    .returning();
  if (!profile) throw new Error("createUser: insert returned no profile row");

  return { ...user, password, profile };
}

type SessionRow = typeof sessions.$inferSelect;

/** Options for {@link createSession}. */
export interface CreateSessionOptions {
  /** Base time for expiries; defaults to now. */
  now?: Date;
  idleExpiresAt?: Date;
  absoluteExpiresAt?: Date;
  lastUsedAt?: Date;
  revoked?: boolean;
}

/**
 * Insert a session row for `userId` directly (bypassing login), e.g. to test
 * expired or revoked sessions.
 *
 * @param userId - Owner.
 * @param options - Expiry and revocation overrides; defaults to a live 30/90-day session.
 */
export async function createSession(userId: string, options: CreateSessionOptions = {}): Promise<SessionRow> {
  const now = options.now ?? new Date();
  const day = 24 * 60 * 60 * 1000;
  const [session] = await getTestDb()
    .insert(sessions)
    .values({
      userId,
      lastUsedAt: options.lastUsedAt ?? now,
      idleExpiresAt: options.idleExpiresAt ?? new Date(now.getTime() + 30 * day),
      absoluteExpiresAt: options.absoluteExpiresAt ?? new Date(now.getTime() + 90 * day),
      ...(options.revoked === true ? { revokedAt: now, revokedReason: "logout" as const } : {})
    })
    .returning();
  if (!session) throw new Error("createSession: insert returned no row");
  return session;
}

/** Options for {@link bearerFor}. */
export interface BearerOptions {
  /** Claimed role; defaults to the user's real role. */
  role?: UserRole;
  mustChangePassword?: boolean;
  /** Issue time; defaults to now. */
  now?: Date;
  /** Override the signing secret (e.g. to forge a bad signature). */
  secret?: string;
  ttlSeconds?: number;
}

/**
 * Sign an access token by hand for `user` and `session` and return inject
 * headers. Lets tests forge claims (role, must-change, expiry) that the real
 * login route would never issue.
 *
 * @param user - The user (`id`, `role`, `mustChangePassword`).
 * @param session - The session row whose id becomes `sid`.
 * @param options - Claim and signing overrides.
 */
export async function bearerFor(
  user: Pick<UserRow, "id" | "role" | "mustChangePassword">,
  session: Pick<SessionRow, "id">,
  options: BearerOptions = {}
): Promise<AuthInjectOptions> {
  const signed = await signAccessToken(
    accessTokenSettings({
      JWT_SECRET: options.secret ?? TEST_JWT_SECRET,
      ACCESS_TOKEN_TTL_SECONDS: options.ttlSeconds ?? 900
    }),
    {
      userId: user.id,
      sessionId: session.id,
      role: options.role ?? user.role,
      mustChangePassword: options.mustChangePassword ?? user.mustChangePassword
    },
    options.now ?? new Date()
  );
  return { headers: { authorization: `Bearer ${signed.token}` } };
}

/** Request options to spread into `app.inject()` for an authenticated call. */
export interface AuthInjectOptions {
  headers: { authorization: string };
}

/**
 * Log in through the real `POST /api/auth/login` route and return headers
 * for authenticated `inject()` calls. The response is the contract `AuthTokenResponse`;
 * use `loginFull` (`test/helpers/auth.ts`) when a test also needs the refresh cookie.
 *
 * @param app - App built with `createTestApp`.
 * @param user - User from `createUser` (needs the plaintext password).
 */
export async function loginAs(
  app: App,
  user: Pick<TestUser, "email" | "password">
): Promise<AuthInjectOptions> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: user.email, password: user.password }
  });
  if (response.statusCode !== 200) {
    throw new Error(`loginAs: login failed with ${response.statusCode}: ${response.body}`);
  }
  const body: unknown = response.json();
  if (
    typeof body !== "object" ||
    body === null ||
    !("accessToken" in body) ||
    typeof body.accessToken !== "string"
  ) {
    throw new Error("loginAs: login response did not include an accessToken");
  }
  return { headers: { authorization: `Bearer ${body.accessToken}` } };
}
