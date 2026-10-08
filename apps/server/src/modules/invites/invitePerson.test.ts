/**
 * WP-4.2: invites linked to family-tree people [SEC]. Create-time checks,
 * the picker read models, and the accept-time re-check under lock, including
 * the races against an admin link, a delete and a death.
 */
import type { AdminInviteCandidate, AdminInviteCandidates, AdminInviteListItem, ApiError, Page } from "@cuencada/types";
import { and, eq, sql } from "drizzle-orm";
import type { LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import { linkToken, loginFull } from "../../../test/helpers/auth.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { createUser, type TestUser } from "../../../test/helpers/factories.js";
import { insertPerson } from "../../../test/helpers/family.js";
import { FakeMailer } from "../../../test/helpers/fakes.js";
import type { App } from "../../app.js";
import { auditLogs, invites, people, users } from "../../db/schema/index.js";
import { createOpaqueToken, hashToken } from "../../lib/tokens.js";

const PASSWORD = "contraseña-muy-segura";

let app: App | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

type Auth = { headers: { authorization: string } };

async function setup(): Promise<{ app: App; mailer: FakeMailer; admin: TestUser; auth: Auth }> {
  const mailer = new FakeMailer();
  app = await createTestApp({ mailer });
  const admin = await createUser({ role: "admin", displayName: "Admin Ejemplo", emailVerified: true });
  return { app, mailer, admin, auth: (await loginFull(app, admin)).auth };
}

function create(instance: App, auth: Auth, payload: Record<string, unknown>): Promise<LightMyRequestResponse> {
  return instance.inject({ method: "POST", url: "/api/admin/invites", payload, ...auth });
}

function accept(instance: App, token: string, email: string, displayName = "Ana Ejemplo"): Promise<LightMyRequestResponse> {
  return instance.inject({ method: "POST", url: "/api/invites/accept", payload: { token, email, displayName, password: PASSWORD } });
}

function detail(response: LightMyRequestResponse): { code: string; detail: string | undefined; path: string | undefined } {
  const { error } = response.json<ApiError>();
  return { code: error.code, detail: error.details?.[0]?.code, path: error.details?.[0]?.path };
}

/** Insert an emailed, pending invite for `personId` straight into the DB; returns the raw token. */
async function insertBoundInvite(personId: string, email: string): Promise<string> {
  const token = createOpaqueToken();
  await getTestDb()
    .insert(invites)
    .values({
      tokenHash: hashToken(token),
      email,
      personId,
      maxUses: 1,
      expiresAt: new Date(Date.now() + 86_400_000),
      lastSentAt: new Date()
    });
  return token;
}

async function acceptAudit(inviteEmail: string): Promise<Record<string, unknown>> {
  const [user] = await getTestDb().select({ id: users.id }).from(users).where(eq(users.email, inviteEmail));
  const [row] = await getTestDb()
    .select({ metadata: auditLogs.metadata })
    .from(auditLogs)
    .where(and(eq(auditLogs.action, "invite.accepted"), eq(auditLogs.actorUserId, user?.id ?? "")));
  return (row?.metadata ?? {}) as Record<string, unknown>; // jsonb object written by recordAudit
}

async function peopleOf(userId: string): Promise<string[]> {
  const rows = await getTestDb().select({ id: people.id }).from(people).where(eq(people.userId, userId));
  return rows.map((row) => row.id);
}

/** Wait until some backend of this database waits on a row lock (the accept is parked on our lock). */
async function waitForLockWaiter(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await getTestDb().execute<{ n: number }>(
      sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`
    );
    if ((rows[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("no backend ever waited on the lock");
}

/**
 * Hold the person's row lock, start an accept (it parks on the lock), run
 * `meanwhile` in the locking transaction, commit, and return the accept's answer.
 */
async function acceptDuring(
  instance: App,
  personId: string,
  token: string,
  email: string,
  meanwhile: (tx: Parameters<Parameters<ReturnType<typeof getTestDb>["transaction"]>[0]>[0]) => Promise<unknown>
): Promise<LightMyRequestResponse> {
  let pending: Promise<LightMyRequestResponse> | undefined;
  await getTestDb().transaction(async (tx) => {
    await tx.select({ id: people.id }).from(people).where(eq(people.id, personId)).for("update");
    pending = accept(instance, token, email);
    await waitForLockWaiter();
    await meanwhile(tx);
  });
  if (pending === undefined) throw new Error("accept never started");
  return pending;
}

describe("POST /api/admin/invites with personId", () => {
  it("creates an emailed invite for a living, unlinked person, suggests their name and lists who it is for", async () => {
    const { app: instance, mailer, auth } = await setup();
    const ana = await insertPerson({ fullName: "Ana Ejemplo", birthYear: 1990 });

    const response = await create(instance, auth, { email: "ana@example.test", personId: ana.id });

    expect(response.statusCode).toBe(201);
    const created = response.json<{ invite: AdminInviteListItem }>();
    expect(created.invite).toMatchObject({ personId: ana.id, person: { id: ana.id, fullName: "Ana Ejemplo" } });
    expect(mailer.lastTo("ana@example.test")?.text).toContain("Ana Ejemplo");
    const [row] = await getTestDb().select().from(invites).where(eq(invites.id, created.invite.id));
    expect(row?.displayName).toBe("Ana Ejemplo");
    const list = await instance.inject({ method: "GET", url: "/api/admin/invites", ...auth });
    expect(list.json<Page<AdminInviteListItem>>().items[0]?.person).toEqual({ id: ana.id, fullName: "Ana Ejemplo" });
  });

  it("lists person: null for invites without a person", async () => {
    const { app: instance, auth } = await setup();
    await create(instance, auth, { email: "sin.persona@example.test", sendEmail: false });

    const list = await instance.inject({ method: "GET", url: "/api/admin/invites", ...auth });

    expect(list.json<Page<AdminInviteListItem>>().items[0]).toMatchObject({ personId: null, person: null });
  });

  it("rejects a personId on an open link with 400 INVITE_PERSON_REQUIRES_BOUND, before any lookup", async () => {
    const { app: instance, auth } = await setup();
    const ana = await insertPerson({ fullName: "Ana Ejemplo" });

    const known = await create(instance, auth, { sendEmail: false, maxUses: 1, personId: ana.id });
    const unknown = await create(instance, auth, { sendEmail: false, personId: "00000000-0000-4000-8000-000000000000" });

    expect(known.statusCode).toBe(400);
    expect(detail(known)).toEqual({ code: "VALIDATION", detail: "INVITE_PERSON_REQUIRES_BOUND", path: "personId" });
    // Same answer for an unknown id: an open link never reveals whether the person exists.
    expect(unknown.body).toBe(known.body);
    expect(await getTestDb().select().from(invites)).toHaveLength(0);
  });

  it("rejects a deceased person with 400 INVITE_PERSON_DECEASED", async () => {
    const { app: instance, auth } = await setup();
    const abuelo = await insertPerson({ fullName: "Abuelo Ejemplo", deceased: true, deathYear: 2001 });

    const response = await create(instance, auth, { email: "abuelo@example.test", personId: abuelo.id });

    expect(response.statusCode).toBe(400);
    expect(detail(response)).toEqual({ code: "VALIDATION", detail: "INVITE_PERSON_DECEASED", path: "personId" });
  });

  it("rejects a person already linked to an account with 409 PERSON_LINKED_TO_OTHER", async () => {
    const { app: instance, auth } = await setup();
    const member = await createUser();
    const linked = await insertPerson({ fullName: "Primo Ejemplo", userId: member.id });

    const response = await create(instance, auth, { email: "primo@example.test", personId: linked.id });

    expect(response.statusCode).toBe(409);
    expect(detail(response)).toEqual({ code: "CONFLICT", detail: "PERSON_LINKED_TO_OTHER", path: "personId" });
    expect(response.body).not.toContain(member.id);
  });

  it("rejects a second invite while one is pending with 409 PERSON_HAS_PENDING_INVITE, and allows one after a revoke", async () => {
    const { app: instance, auth } = await setup();
    const ana = await insertPerson({ fullName: "Ana Ejemplo" });
    const first = await create(instance, auth, { email: "ana@example.test", personId: ana.id, sendEmail: false });

    const second = await create(instance, auth, { email: "ana.otra@example.test", personId: ana.id, sendEmail: false });
    expect(second.statusCode).toBe(409);
    expect(detail(second)).toEqual({ code: "CONFLICT", detail: "PERSON_HAS_PENDING_INVITE", path: "personId" });

    const firstId = first.json<{ invite: { id: string } }>().invite.id;
    await instance.inject({ method: "POST", url: `/api/admin/invites/${firstId}/revoke`, ...auth });
    const third = await create(instance, auth, { email: "ana.otra@example.test", personId: ana.id, sendEmail: false });
    expect(third.statusCode).toBe(201);
  });

  it("does not count an expired invite as pending", async () => {
    const { app: instance, auth } = await setup();
    const ana = await insertPerson({ fullName: "Ana Ejemplo" });
    await getTestDb()
      .insert(invites)
      .values({ tokenHash: hashToken(createOpaqueToken()), email: "vieja@example.test", personId: ana.id, expiresAt: new Date(Date.now() - 1000) });

    const response = await create(instance, auth, { email: "ana@example.test", personId: ana.id, sendEmail: false });

    expect(response.statusCode).toBe(201);
  });

  it("serializes concurrent creates for one person: exactly one succeeds", async () => {
    const { app: instance, auth } = await setup();
    const ana = await insertPerson({ fullName: "Ana Ejemplo" });

    const responses = await Promise.all(
      ["a1", "a2", "a3"].map((name) => create(instance, auth, { email: `${name}@example.test`, personId: ana.id, sendEmail: false }))
    );

    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409, 409]);
    expect(await getTestDb().select().from(invites).where(eq(invites.personId, ana.id))).toHaveLength(1);
  });

  it("keeps a 400 for an unknown person on a bound invite", async () => {
    const { app: instance, auth } = await setup();

    const response = await create(instance, auth, { email: "x@example.test", personId: "00000000-0000-4000-8000-000000000000" });

    expect(response.statusCode).toBe(400);
    expect(detail(response)).toMatchObject({ code: "VALIDATION", path: "personId", detail: undefined });
  });
});

describe("GET /api/admin/invites/people", () => {
  it("lists only living people without an account, with years and branch, flagging pending invites", async () => {
    const { app: instance, auth } = await setup();
    const member = await createUser();
    const norte = await insertPerson({ fullName: "Ana Ejemplo", familyBranch: "Rama Norte", birthYear: 1990 });
    const sur = await insertPerson({ fullName: "Ana Ejemplo", familyBranch: "Rama Sur", birthYear: 1962 });
    await insertPerson({ fullName: "Ana Ejemplo Difunta", deceased: true, deathYear: 2010 });
    await insertPerson({ fullName: "Ana Ejemplo Con Cuenta", userId: member.id });
    await insertBoundInvite(sur.id, "ana.sur@example.test");

    const response = await instance.inject({ method: "GET", url: "/api/admin/invites/people?q=ana", ...auth });

    expect(response.statusCode).toBe(200);
    const { items } = response.json<AdminInviteCandidates>();
    expect(items.map((item) => item.id).sort()).toEqual([norte.id, sur.id].sort());
    expect(items.find((item) => item.id === norte.id)).toEqual({
      id: norte.id,
      fullName: "Ana Ejemplo",
      nickname: null,
      familyBranch: "Rama Norte",
      birthYear: 1990,
      deathYear: null,
      deceased: false,
      linked: false,
      pendingInvite: false
    } satisfies AdminInviteCandidate);
    expect(items.find((item) => item.id === sur.id)?.pendingInvite).toBe(true);
    expect(response.body).not.toContain(member.id);
  });

  it("matches nickname and branch, escapes LIKE wildcards and requires q", async () => {
    const { app: instance, auth } = await setup();
    await insertPerson({ fullName: "Beto Ejemplo", nickname: "Chato" });
    await insertPerson({ fullName: "Carla Ejemplo", familyBranch: "Rama Oeste" });

    const byNick = await instance.inject({ method: "GET", url: "/api/admin/invites/people?q=chato", ...auth });
    const byBranch = await instance.inject({ method: "GET", url: "/api/admin/invites/people?q=oeste", ...auth });
    const wildcard = await instance.inject({ method: "GET", url: "/api/admin/invites/people?q=%25", ...auth });
    const missing = await instance.inject({ method: "GET", url: "/api/admin/invites/people", ...auth });

    expect(byNick.json<AdminInviteCandidates>().items.map((item) => item.fullName)).toEqual(["Beto Ejemplo"]);
    expect(byBranch.json<AdminInviteCandidates>().items.map((item) => item.fullName)).toEqual(["Carla Ejemplo"]);
    expect(wildcard.json<AdminInviteCandidates>().items).toEqual([]);
    expect(missing.statusCode).toBe(400);
  });

  it("returns any person's status by id and 404 for an unknown id", async () => {
    const { app: instance, auth } = await setup();
    const member = await createUser();
    const linked = await insertPerson({ fullName: "Primo Ejemplo", userId: member.id });

    const found = await instance.inject({ method: "GET", url: `/api/admin/invites/people/${linked.id}`, ...auth });
    const missing = await instance.inject({ method: "GET", url: "/api/admin/invites/people/00000000-0000-4000-8000-000000000000", ...auth });

    expect(found.json<AdminInviteCandidate>()).toMatchObject({ id: linked.id, linked: true, pendingInvite: false });
    expect(found.body).not.toContain(member.id);
    expect(missing.statusCode).toBe(404);
  });

  it("answers 401 anonymously and 403 to members", async () => {
    const { app: instance } = await setup();
    const member = await loginFull(instance, await createUser({ emailVerified: true }));
    const ana = await insertPerson({ fullName: "Ana Ejemplo" });

    for (const url of ["/api/admin/invites/people?q=ana", `/api/admin/invites/people/${ana.id}`]) {
      expect((await instance.inject({ method: "GET", url })).statusCode).toBe(401);
      expect((await instance.inject({ method: "GET", url, ...member.auth })).statusCode).toBe(403);
    }
  });
});

describe("POST /api/invites/accept with a person", () => {
  it("links the account to the invite's person without creating another, and audits ids only", async () => {
    const { app: instance, mailer, auth } = await setup();
    const ana = await insertPerson({ fullName: "Ana Ejemplo" });
    await create(instance, auth, { email: "ana@example.test", personId: ana.id });

    const response = await accept(instance, linkToken(mailer.lastTo("ana@example.test")), "ana@example.test", "Ana E.");

    expect(response.statusCode).toBe(201);
    const userId = response.json<{ user: { id: string; personId: string } }>().user.id;
    expect(await peopleOf(userId)).toEqual([ana.id]);
    expect(await getTestDb().select().from(people)).toHaveLength(1);
    const metadata = await acceptAudit("ana@example.test");
    expect(metadata).toMatchObject({ personId: ana.id, personLink: "linked" });
    expect(metadata).not.toHaveProperty("personFallbackReason");
    expect(JSON.stringify(metadata)).not.toContain("Ana");
  });

  it("falls back to a new person when the person was linked to another account before accepting", async () => {
    const { app: instance, auth } = await setup();
    const ana = await insertPerson({ fullName: "Ana Ejemplo" });
    const created = await create(instance, auth, { email: "ana@example.test", personId: ana.id, sendEmail: false });
    const other = await createUser();
    await getTestDb().update(people).set({ userId: other.id }).where(eq(people.id, ana.id));

    const response = await accept(instance, new URL(created.json<{ inviteUrl: string }>().inviteUrl).hash.slice(3), "ana@example.test");

    expect(response.statusCode).toBe(201);
    const userId = response.json<{ user: { id: string } }>().user.id;
    const mine = await peopleOf(userId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).not.toBe(ana.id);
    expect(await peopleOf(other.id)).toEqual([ana.id]);
    expect(await acceptAudit("ana@example.test")).toMatchObject({
      personId: mine[0],
      personLink: "fallback",
      requestedPersonId: ana.id,
      personFallbackReason: "linked"
    });
  });

  it("falls back to a new person when the person died before accepting", async () => {
    const { app: instance } = await setup();
    const ana = await insertPerson({ fullName: "Ana Ejemplo" });
    const token = await insertBoundInvite(ana.id, "ana@example.test");
    await getTestDb().update(people).set({ deceased: true }).where(eq(people.id, ana.id));

    const response = await accept(instance, token, "ana@example.test");

    expect(response.statusCode).toBe(201);
    const [ghost] = await getTestDb().select().from(people).where(eq(people.id, ana.id));
    expect(ghost?.userId).toBeNull();
    expect(await acceptAudit("ana@example.test")).toMatchObject({ personLink: "fallback", personFallbackReason: "deceased" });
  });

  it("treats an invite whose person was deleted beforehand as unlinked (the FK cleared person_id)", async () => {
    const { app: instance, auth } = await setup();
    const ana = await insertPerson({ fullName: "Ana Ejemplo" });
    const token = await insertBoundInvite(ana.id, "ana@example.test");
    await getTestDb().delete(people).where(eq(people.id, ana.id));
    const list = await instance.inject({ method: "GET", url: "/api/admin/invites", ...auth });
    expect(list.json<Page<AdminInviteListItem>>().items[0]).toMatchObject({ personId: null, person: null });

    const response = await accept(instance, token, "ana@example.test");

    expect(response.statusCode).toBe(201);
    expect(await acceptAudit("ana@example.test")).toMatchObject({ personLink: "created" });
  });

  it("never links a person named by an open link (legacy row): falls back with not_bound (Security L1)", async () => {
    const { app: instance } = await setup();
    const ana = await insertPerson({ fullName: "Ana Ejemplo" });
    const token = createOpaqueToken();
    await getTestDb()
      .insert(invites)
      .values({ tokenHash: hashToken(token), email: null, personId: ana.id, maxUses: 5, expiresAt: new Date(Date.now() + 86_400_000) });

    const response = await accept(instance, token, "quien.sea@example.test", "Quien Sea");

    expect(response.statusCode).toBe(201);
    const [row] = await getTestDb().select().from(people).where(eq(people.id, ana.id));
    expect(row?.userId).toBeNull();
    const userId = response.json<{ user: { id: string } }>().user.id;
    const mine = await peopleOf(userId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).not.toBe(ana.id);
    expect(await acceptAudit("quien.sea@example.test")).toMatchObject({
      personId: mine[0],
      personLink: "fallback",
      requestedPersonId: ana.id,
      personFallbackReason: "not_bound"
    });
  });

  describe("races under the person lock", () => {
    it("an admin link that commits while the accept waits wins; the accept falls back", async () => {
      const { app: instance } = await setup();
      const ana = await insertPerson({ fullName: "Ana Ejemplo" });
      const token = await insertBoundInvite(ana.id, "ana@example.test");
      const other = await createUser();

      const response = await acceptDuring(instance, ana.id, token, "ana@example.test", (tx) =>
        tx.update(people).set({ userId: other.id }).where(eq(people.id, ana.id))
      );

      expect(response.statusCode).toBe(201);
      expect(await peopleOf(other.id)).toEqual([ana.id]);
      const userId = response.json<{ user: { id: string } }>().user.id;
      expect(await peopleOf(userId)).toHaveLength(1);
      expect(await acceptAudit("ana@example.test")).toMatchObject({ personLink: "fallback", personFallbackReason: "linked" });
    });

    it("a delete that commits while the accept waits does not deadlock; the accept falls back", async () => {
      const { app: instance } = await setup();
      const ana = await insertPerson({ fullName: "Ana Ejemplo" });
      const token = await insertBoundInvite(ana.id, "ana@example.test");

      const response = await acceptDuring(instance, ana.id, token, "ana@example.test", (tx) =>
        tx.delete(people).where(eq(people.id, ana.id))
      );

      expect(response.statusCode).toBe(201);
      expect(await acceptAudit("ana@example.test")).toMatchObject({
        personLink: "fallback",
        requestedPersonId: ana.id,
        personFallbackReason: "deleted"
      });
    });

    it("a death recorded while the accept waits is honoured", async () => {
      const { app: instance } = await setup();
      const ana = await insertPerson({ fullName: "Ana Ejemplo" });
      const token = await insertBoundInvite(ana.id, "ana@example.test");

      const response = await acceptDuring(instance, ana.id, token, "ana@example.test", (tx) =>
        tx.update(people).set({ deceased: true }).where(eq(people.id, ana.id))
      );

      expect(response.statusCode).toBe(201);
      const [row] = await getTestDb().select().from(people).where(eq(people.id, ana.id));
      expect(row?.userId).toBeNull();
      expect(await acceptAudit("ana@example.test")).toMatchObject({ personFallbackReason: "deceased" });
    });

    it("an accept racing the admin link route leaves exactly one account on the person", async () => {
      const { app: instance, auth } = await setup();
      const ana = await insertPerson({ fullName: "Ana Ejemplo" });
      const token = await insertBoundInvite(ana.id, "ana@example.test");
      const other = await createUser();

      const [accepted, linked] = await Promise.all([
        accept(instance, token, "ana@example.test"),
        instance.inject({ method: "PATCH", url: `/api/admin/people/${ana.id}`, payload: { userId: other.id }, ...auth })
      ]);

      expect(accepted.statusCode).toBe(201);
      expect(linked.statusCode).toBe(200);
      const userId = accepted.json<{ user: { id: string } }>().user.id;
      const [row] = await getTestDb().select().from(people).where(eq(people.id, ana.id));
      // Whatever the order, the person holds one account and each account one person.
      expect([userId, other.id]).toContain(row?.userId);
      expect((await peopleOf(other.id)).length).toBeLessThanOrEqual(1);
      expect((await peopleOf(userId)).length).toBeLessThanOrEqual(1);
      const total = await getTestDb().execute<{ n: number }>(
        sql`select count(*)::int as n from ${people} where ${people.userId} is not null group by ${people.userId} having count(*) > 1`
      );
      expect(total).toHaveLength(0);
    });

    it("two accepts of one single-use invite link the person once", async () => {
      const { app: instance } = await setup();
      const ana = await insertPerson({ fullName: "Ana Ejemplo" });
      const token = await insertBoundInvite(ana.id, "ana@example.test");

      const responses = await Promise.all([accept(instance, token, "ana@example.test"), accept(instance, token, "ana@example.test")]);

      expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 400]);
      expect(await getTestDb().select().from(people)).toHaveLength(1);
    });
  });
});
