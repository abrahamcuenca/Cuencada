import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import { linkToken, loginFull } from "../../../test/helpers/auth.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { bearerFor, createSession, createUser } from "../../../test/helpers/factories.js";
import { FakeMailer } from "../../../test/helpers/fakes.js";
import { createMember, type Member } from "../../../test/helpers/media.js";
import type { App } from "../../app.js";
import { auditLogs, magicLinks, people, sessions, users } from "../../db/schema/index.js";
import { hashToken } from "../../lib/tokens.js";
import { mailQueue } from "../auth/mailQueue.js";
import { ADMIN_MUTATION_LIMIT } from "./userRoutes.js";
import { countOtherActiveAdmins, lockAdminUserChanges } from "./users.js";

interface UserItem {
  id: string;
  email: string;
  displayName: string;
  role: string;
  status: string;
  mustChangePassword: boolean;
  emailVerified: boolean;
  personId: string | null;
  lastLoginAt: string | null;
  activeSessionCount: number;
  createdAt: string;
}

interface UserPage {
  items: UserItem[];
  nextCursor: string | null;
}

let app: App;
let mailer: FakeMailer;
let admin: Member;
let member: Member;

beforeEach(async () => {
  mailer = new FakeMailer();
  app = await createTestApp({ mailer });
  admin = await createMember({ role: "admin", displayName: "Admin Uno", email: "admin1@example.test" });
  member = await createMember({ displayName: "Prima Ana", email: "ana@example.test" });
});

afterEach(async () => {
  await app.close();
});

function errorCode(response: { json: <T>() => T }): string {
  return response.json<{ error: { code: string } }>().error.code;
}

async function me(auth: Member["auth"]): Promise<number> {
  const response = await app.inject({ method: "GET", url: "/api/me", ...auth });
  return response.statusCode;
}

async function insertPendingToken(userId: string, email: string): Promise<string> {
  const [row] = await getTestDb()
    .insert(magicLinks)
    .values({
      userId,
      email,
      tokenHash: hashToken(`pending-${userId}-${Math.random()}`),
      purpose: "login",
      expiresAt: new Date(Date.now() + 15 * 60_000)
    })
    .returning({ id: magicLinks.id });
  if (row === undefined) throw new Error("insertPendingToken: no row");
  return row.id;
}

async function auditsFor(entityId: string): Promise<Array<typeof auditLogs.$inferSelect>> {
  return getTestDb().select().from(auditLogs).where(eq(auditLogs.entityId, entityId));
}

/** Audit rows must carry ids, field names and counts, never the user's email or name. */
function expectNoPii(rows: Array<typeof auditLogs.$inferSelect>, ...values: string[]): void {
  const serialized = JSON.stringify(rows.map((row) => row.metadata));
  for (const value of values) expect(serialized).not.toContain(value);
}

describe("GET /api/admin/users", () => {
  it("lists users newest first with verification, last login, person link and live session count", async () => {
    const db = getTestDb();
    await createSession(member.user.id);
    await createSession(member.user.id, { revoked: true });
    await createSession(member.user.id, { idleExpiresAt: new Date(Date.now() - 1000), absoluteExpiresAt: new Date(Date.now() - 1000), now: new Date(Date.now() - 2000) });
    const [person] = await db.insert(people).values({ fullName: "Ana Cuenca", userId: member.user.id }).returning();
    const lastLogin = new Date("2026-09-01T10:00:00Z");
    await db.update(users).set({ lastLoginAt: lastLogin }).where(eq(users.id, member.user.id));

    const response = await app.inject({ method: "GET", url: "/api/admin/users", ...admin.auth });

    expect(response.statusCode).toBe(200);
    const page = response.json<UserPage>();
    expect(page.items.map((item) => item.id)).toEqual([member.user.id, admin.user.id]);
    expect(page.items[0]).toMatchObject({
      email: "ana@example.test",
      displayName: "Prima Ana",
      role: "member",
      status: "active",
      emailVerified: true,
      personId: person?.id,
      lastLoginAt: lastLogin.toISOString(),
      activeSessionCount: 2
    });
    expect(page.nextCursor).toBeNull();
  });

  it("searches name and email literally and filters by role and status", async () => {
    await createUser({ displayName: "100% Cuenca", email: "pct@example.test" });
    await createUser({ displayName: "Tío_Beto", email: "beto@example.test", status: "disabled" });

    const list = async (query: string): Promise<string[]> => {
      const response = await app.inject({ method: "GET", url: `/api/admin/users${query}`, ...admin.auth });
      expect(response.statusCode).toBe(200);
      return response.json<UserPage>().items.map((item) => item.email);
    };

    expect(await list("?q=%25")).toEqual(["pct@example.test"]);
    expect(await list("?q=_")).toEqual(["beto@example.test"]);
    expect(await list("?q=ANA%40EXAMPLE")).toEqual(["ana@example.test"]);
    expect(await list("?q=uno")).toEqual(["admin1@example.test"]);
    expect(await list("?role=admin")).toEqual(["admin1@example.test"]);
    expect(await list("?status=disabled")).toEqual(["beto@example.test"]);
  });

  it("pages with an opaque keyset cursor without gaps or duplicates", async () => {
    for (let index = 0; index < 5; index += 1) await createUser();
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = cursor === null ? "?limit=2" : `?limit=2&cursor=${cursor}`;
      const response = await app.inject({ method: "GET", url: `/api/admin/users${query}`, ...admin.auth });
      expect(response.statusCode).toBe(200);
      const page = response.json<UserPage>();
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(pages).toBe(4);
  });

  it("answers 400 for bad queries, 401 without a token and 403 for members", async () => {
    for (const query of ["?limit=0", "?role=owner", "?status=x", "?cursor=bm9wZQ", `?q=${"a".repeat(101)}`]) {
      const response = await app.inject({ method: "GET", url: `/api/admin/users${query}`, ...admin.auth });
      expect(response.statusCode, query).toBe(400);
      expect(errorCode(response)).toBe("VALIDATION");
    }
    expect((await app.inject({ method: "GET", url: "/api/admin/users" })).statusCode).toBe(401);
    const forbidden = await app.inject({ method: "GET", url: "/api/admin/users", ...member.auth });
    expect(forbidden.statusCode).toBe(403);
  });

  it("uses the database role, not a forged admin claim", async () => {
    const forged = await bearerFor(member.user, await createSession(member.user.id), { role: "admin" });
    expect((await app.inject({ method: "GET", url: "/api/admin/users", ...forged })).statusCode).toBe(403);
  });
});

describe("PATCH /api/admin/users/:id", () => {
  it("disabling revokes every session, burns pending email tokens and audits without PII", async () => {
    const tokenId = await insertPendingToken(member.user.id, member.user.email);
    const second = await createSession(member.user.id);
    expect(await me(member.auth)).toBe(200);

    const response = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${member.user.id}`,
      payload: { status: "disabled" },
      ...admin.auth
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<UserItem>()).toMatchObject({ status: "disabled", activeSessionCount: 0 });
    expect(await me(member.auth)).toBe(401);

    const db = getTestDb();
    const memberSessions = await db.select().from(sessions).where(eq(sessions.userId, member.user.id));
    expect(memberSessions.map((row) => row.revokedReason)).toEqual(["user_disabled", "user_disabled"]);
    expect(memberSessions.map((row) => row.id)).toContain(second.id);
    const [token] = await db.select().from(magicLinks).where(eq(magicLinks.id, tokenId));
    expect(token?.usedAt).not.toBeNull();

    const audits = await auditsFor(member.user.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorUserId: admin.user.id,
      action: "user.disabled",
      entityType: "user",
      metadata: { fields: ["status"], revokedSessions: 2, burnedEmailLinks: 1 }
    });
    expectNoPii(audits, member.user.email, member.user.displayName);
  });

  it("re-enabling restores access through a new login", async () => {
    await app.inject({ method: "PATCH", url: `/api/admin/users/${member.user.id}`, payload: { status: "disabled" }, ...admin.auth });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: member.user.email, password: member.user.password }
    });
    expect(login.statusCode).toBe(401);

    const response = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${member.user.id}`,
      payload: { status: "active" },
      ...admin.auth
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<UserItem>().status).toBe("active");
    const fresh = await loginFull(app, member.user);
    expect(await me(fresh.auth)).toBe(200);

    const actions = (await auditsFor(member.user.id)).map((row) => row.action).filter((action) => action.startsWith("user."));
    expect(actions.sort()).toEqual(["user.disabled", "user.enabled"]);
  });

  it("promotes and demotes with immediate effect and records the role change", async () => {
    const promoted = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${member.user.id}`,
      payload: { role: "admin" },
      ...admin.auth
    });
    expect(promoted.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/admin/users", ...member.auth })).statusCode).toBe(200);

    const demoted = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${member.user.id}`,
      payload: { role: "member", mustChangePassword: true },
      ...admin.auth
    });
    expect(demoted.statusCode).toBe(200);
    expect(demoted.json<UserItem>()).toMatchObject({ role: "member", mustChangePassword: true });
    expect((await app.inject({ method: "GET", url: "/api/admin/users", ...member.auth })).statusCode).toBe(403);

    const audits = await auditsFor(member.user.id);
    expect(audits.map((row) => row.metadata)).toEqual(
      expect.arrayContaining([
        { fields: ["role"], role: { from: "member", to: "admin" }, adminAlertRecipients: 1 },
        { fields: ["role", "mustChangePassword"], role: { from: "admin", to: "member" }, adminAlertRecipients: 1, adminAlertExempt: true }
      ])
    );
  });

  it("writes no audit row for a no-op patch", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${member.user.id}`,
      payload: { status: "active", role: "member" },
      ...admin.auth
    });
    expect(response.statusCode).toBe(200);
    expect(await auditsFor(member.user.id)).toHaveLength(0);
  });

  it("refuses to let an admin disable or demote themselves", async () => {
    await createMember({ role: "admin" });
    for (const payload of [{ status: "disabled" }, { role: "member" }]) {
      const response = await app.inject({ method: "PATCH", url: `/api/admin/users/${admin.user.id}`, payload, ...admin.auth });
      expect(response.statusCode).toBe(403);
      expect(response.json<{ error: { message: string } }>().error.message).toBe(
        "No puedes cambiar tu propio rol ni desactivar tu propia cuenta."
      );
    }
    const [row] = await getTestDb().select().from(users).where(eq(users.id, admin.user.id));
    expect(row).toMatchObject({ role: "admin", status: "active" });
  });

  it("keeps at least one active admin when two admins demote each other at the same time", async () => {
    for (let round = 0; round < 5; round += 1) {
      const db = getTestDb();
      await db.update(users).set({ role: "member" }).where(eq(users.role, "admin"));
      const first = await createMember({ role: "admin" });
      const second = await createMember({ role: "admin" });
      const results = await Promise.all([
        app.inject({ method: "PATCH", url: `/api/admin/users/${second.user.id}`, payload: { role: "member" }, ...first.auth }),
        app.inject({ method: "PATCH", url: `/api/admin/users/${first.user.id}`, payload: { status: "disabled" }, ...second.auth })
      ]);
      const codes = results.map((result) => result.statusCode).sort();
      expect(codes[0]).toBe(200);
      expect([403, 409]).toContain(codes[1]);
      const admins = await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.role, "admin"), eq(users.status, "active")));
      expect(admins).toHaveLength(1);
    }
  });

  it("counts the other active admins under the advisory lock (the 409 guard's input)", async () => {
    const other = await createMember({ role: "admin" });
    await getTestDb().transaction(async (tx) => {
      await lockAdminUserChanges(tx);
      expect(await countOtherActiveAdmins(tx, admin.user.id)).toBe(1);
      await tx.update(users).set({ status: "disabled" }).where(eq(users.id, other.user.id));
      expect(await countOtherActiveAdmins(tx, admin.user.id)).toBe(0);
    });
  });

  it("answers 400 for an empty or invalid body, 404 for an unknown user, 401 and 403", async () => {
    for (const payload of [{}, { role: "owner" }, { mustChangePassword: false }]) {
      const response = await app.inject({ method: "PATCH", url: `/api/admin/users/${member.user.id}`, payload, ...admin.auth });
      expect(response.statusCode).toBe(400);
    }
    const badId = await app.inject({ method: "PATCH", url: "/api/admin/users/nope", payload: { status: "disabled" }, ...admin.auth });
    expect(badId.statusCode).toBe(400);
    const unknown = await app.inject({
      method: "PATCH",
      url: "/api/admin/users/6f1b2a3c-4d5e-4f60-8a7b-9c0d1e2f3a4b",
      payload: { status: "disabled" },
      ...admin.auth
    });
    expect(unknown.statusCode).toBe(404);
    const anonymous = await app.inject({ method: "PATCH", url: `/api/admin/users/${member.user.id}`, payload: { status: "disabled" } });
    expect(anonymous.statusCode).toBe(401);
    const asMember = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${admin.user.id}`,
      payload: { status: "disabled" },
      ...member.auth
    });
    expect(asMember.statusCode).toBe(403);
    expect(await auditsFor(admin.user.id)).toHaveLength(0);
  });

  it("rate-limits mutations per admin", async () => {
    const statuses: number[] = [];
    for (let index = 0; index <= ADMIN_MUTATION_LIMIT.max; index += 1) {
      const response = await app.inject({
        method: "POST",
        url: `/api/admin/users/${member.user.id}/verify-email`,
        ...admin.auth
      });
      statuses.push(response.statusCode);
    }
    expect(statuses.slice(0, ADMIN_MUTATION_LIMIT.max).every((status) => status === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe("POST /api/admin/users/:id/revoke-sessions", () => {
  it("revokes every live session so the old access token stops working", async () => {
    const response = await app.inject({ method: "POST", url: `/api/admin/users/${member.user.id}/revoke-sessions`, ...admin.auth });
    expect(response.statusCode).toBe(204);
    expect(await me(member.auth)).toBe(401);
    const live = await getTestDb()
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, member.user.id), isNull(sessions.revokedAt)));
    expect(live).toHaveLength(0);
    const audits = await auditsFor(member.user.id);
    expect(audits[0]).toMatchObject({ action: "user.sessions_revoked", metadata: { revokedSessions: 1 } });
  });

  it("answers 403 for members and for the caller's own account, 401 without a token", async () => {
    expect((await app.inject({ method: "POST", url: `/api/admin/users/${admin.user.id}/revoke-sessions`, ...member.auth })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/api/admin/users/${admin.user.id}/revoke-sessions`, ...admin.auth })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/api/admin/users/${member.user.id}/revoke-sessions` })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/admin/users/x/revoke-sessions", ...admin.auth })).statusCode).toBe(400);
  });
});

describe("POST /api/admin/users/:id/force-password-reset", () => {
  it("forces a password change, revokes sessions, burns old links and emails a working reset link", async () => {
    const oldToken = await insertPendingToken(member.user.id, member.user.email);

    const response = await app.inject({
      method: "POST",
      url: `/api/admin/users/${member.user.id}/force-password-reset`,
      ...admin.auth
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ user: UserItem; emailQueued: boolean }>()).toMatchObject({
      user: { id: member.user.id, mustChangePassword: true, activeSessionCount: 0 },
      emailQueued: true
    });
    expect(await me(member.auth)).toBe(401);
    const [burned] = await getTestDb().select().from(magicLinks).where(eq(magicLinks.id, oldToken));
    expect(burned?.usedAt).not.toBeNull();

    await mailQueue(app).onIdle();
    const mail = mailer.lastTo(member.user.email);
    expect(mail?.tags).toEqual({ category: "password-reset" });
    const confirm = await app.inject({
      method: "POST",
      url: "/api/auth/password-reset/confirm",
      payload: { token: linkToken(mail), newPassword: "una-contraseña-nueva-y-larga" }
    });
    expect(confirm.statusCode).toBe(204);

    const audits = (await auditsFor(member.user.id)).filter((row) => row.action === "user.password_reset_forced");
    expect(audits).toHaveLength(1);
    expect(audits[0]?.metadata).toEqual({ revokedSessions: 1, burnedEmailLinks: 1, emailQueued: true });
    expectNoPii(audits, member.user.email, member.user.displayName);
  });

  it("sends nothing to a disabled account but still forces the change", async () => {
    const disabled = await createUser({ status: "disabled" });
    const response = await app.inject({
      method: "POST",
      url: `/api/admin/users/${disabled.id}/force-password-reset`,
      ...admin.auth
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ user: UserItem; emailQueued: boolean }>()).toMatchObject({
      user: { mustChangePassword: true },
      emailQueued: false
    });
    await mailQueue(app).onIdle();
    expect(mailer.lastTo(disabled.email)).toBeUndefined();
  });

  it("answers 403 for members and for the caller's own account, 404 for unknown users, 401 without a token", async () => {
    expect((await app.inject({ method: "POST", url: `/api/admin/users/${member.user.id}/force-password-reset`, ...member.auth })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/api/admin/users/${admin.user.id}/force-password-reset`, ...admin.auth })).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/admin/users/6f1b2a3c-4d5e-4f60-8a7b-9c0d1e2f3a4b/force-password-reset",
          ...admin.auth
        })
      ).statusCode
    ).toBe(404);
    expect((await app.inject({ method: "POST", url: `/api/admin/users/${member.user.id}/force-password-reset` })).statusCode).toBe(401);
  });
});

describe("POST /api/admin/users/:id/verify-email", () => {
  it("marks the email verified once and audits only the first change", async () => {
    const unverified = await createUser({ emailVerified: false, displayName: "Abuelita Rosa" });
    const first = await app.inject({ method: "POST", url: `/api/admin/users/${unverified.id}/verify-email`, ...admin.auth });
    expect(first.statusCode).toBe(200);
    expect(first.json<UserItem>().emailVerified).toBe(true);
    const [row] = await getTestDb().select().from(users).where(eq(users.id, unverified.id));
    const verifiedAt = row?.emailVerifiedAt;
    expect(verifiedAt).toBeInstanceOf(Date);

    const second = await app.inject({ method: "POST", url: `/api/admin/users/${unverified.id}/verify-email`, ...admin.auth });
    expect(second.statusCode).toBe(200);
    const [again] = await getTestDb().select().from(users).where(eq(users.id, unverified.id));
    expect(again?.emailVerifiedAt).toEqual(verifiedAt);

    const audits = await auditsFor(unverified.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "user.email_verified_by_admin", metadata: { fields: ["emailVerified"] } });
    expectNoPii(audits, unverified.email, unverified.displayName);
  });

  it("refuses to let an admin verify their own address", async () => {
    await getTestDb().update(users).set({ emailVerifiedAt: null }).where(eq(users.id, admin.user.id));
    const response = await app.inject({ method: "POST", url: `/api/admin/users/${admin.user.id}/verify-email`, ...admin.auth });
    expect(response.statusCode).toBe(403);
    expect(response.json<{ error: { message: string } }>().error.message).toBe(
      "No puedes verificar tu propio correo; usa el enlace de verificación que te enviamos."
    );
    const [row] = await getTestDb().select().from(users).where(eq(users.id, admin.user.id));
    expect(row?.emailVerifiedAt).toBeNull();
    expect(await auditsFor(admin.user.id)).toHaveLength(0);
  });

  it("answers 400, 401, 403 and 404", async () => {
    expect((await app.inject({ method: "POST", url: "/api/admin/users/x/verify-email", ...admin.auth })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/api/admin/users/${member.user.id}/verify-email` })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: `/api/admin/users/${member.user.id}/verify-email`, ...member.auth })).statusCode).toBe(403);
    expect(
      (await app.inject({ method: "POST", url: "/api/admin/users/6f1b2a3c-4d5e-4f60-8a7b-9c0d1e2f3a4b/verify-email", ...admin.auth })).statusCode
    ).toBe(404);
  });
});

