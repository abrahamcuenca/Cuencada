import { randomUUID } from "node:crypto";
import type { UserRole } from "@cuencada/types";
import argon2 from "argon2";
import type { FastifyInstance } from "fastify";
import { profiles, users } from "../../src/db/schema.js";
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
  status?: string;
  password?: string;
  mustChangePassword?: boolean;
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
      mustChangePassword: options.mustChangePassword ?? false
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

/** Request options to spread into `app.inject()` for an authenticated call. */
export interface AuthInjectOptions {
  headers: { authorization: string };
}

/**
 * Log in through the real `POST /api/auth/login` route and return headers
 * for authenticated `inject()` calls. Later WPs switch this to cookies.
 *
 * @param app - App built with `createTestApp`.
 * @param user - User from `createUser` (needs the plaintext password).
 */
export async function loginAs(
  app: FastifyInstance,
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
