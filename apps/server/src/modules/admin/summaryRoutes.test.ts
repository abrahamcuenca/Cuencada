/**
 * Dashboard summary tests. Isolation: one app per file, small fixtures, and
 * every counter is asserted as a **delta** against a summary taken at the
 * start of the same test, so rows left by any other test cannot break it.
 * The edition under test starts one hour after the fixed clock, so it is
 * always the earliest upcoming one.
 */
import type { AdminSummary } from "@cuencada/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import { TestClock } from "../../../test/helpers/auth.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { bearerFor, createSession, createUser } from "../../../test/helpers/factories.js";
import { insertMedia, type Member } from "../../../test/helpers/media.js";
import type { App } from "../../app.js";
import { cuencadaRsvps, cuencadas, invites, mediaReports } from "../../db/schema/index.js";
import type { DbOrTx } from "../../lib/audit.js";
import { loadAdminSummary } from "./summaryRoutes.js";

const NOW = new Date("2026-10-06T12:00:00Z");
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

let app: App;

beforeAll(async () => {
  app = await createTestApp({ clock: new TestClock(NOW) });
});

afterAll(async () => {
  await app.close();
});

/** A user whose session and token are issued at the fixed test time. */
async function createMember(options: Parameters<typeof createUser>[0] = {}): Promise<Member> {
  const user = await createUser({ emailVerified: true, ...options });
  return { user, auth: await bearerFor(user, await createSession(user.id, { now: NOW }), { now: NOW }) };
}

async function summary(admin: Member): Promise<AdminSummary> {
  const response = await app.inject({ method: "GET", url: "/api/admin/summary", ...admin.auth });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<AdminSummary>();
}

/** Insert an edition with explicit times and a year no other row uses. */
async function insertEdition(startsAt: Date, endsAt: Date, isPublished = true): Promise<typeof cuencadas.$inferSelect> {
  return insertEditionWith(getTestDb(), startsAt, endsAt, isPublished);
}

async function insertEditionWith(
  db: DbOrTx,
  startsAt: Date,
  endsAt: Date,
  isPublished = true
): Promise<typeof cuencadas.$inferSelect> {
  const year = 1900 + Math.floor(Math.random() * 300);
  const [row] = await db
    .insert(cuencadas)
    .values({
      year,
      slug: `t8-${year}-${Math.random().toString(36).slice(2, 8)}`,
      title: `Cuencada ${year}`,
      startsAt,
      endsAt,
      city: "Mérida",
      state: "Yucatán",
      description: "Reunión familiar",
      isPublished
    })
    .onConflictDoNothing()
    .returning();
  if (row === undefined) return insertEditionWith(db, startsAt, endsAt, isPublished);
  return row;
}

describe("GET /api/admin/summary", () => {
  it("counts users, invites and media needing attention (as deltas)", async () => {
    const admin = await createMember({ role: "admin" });
    const member = await createMember();
    const before = await summary(admin);
    const db = getTestDb();

    await createUser({ status: "disabled" });
    await createUser({ emailVerified: false });
    await createUser({ emailVerified: false, status: "disabled" });
    await createMember({ role: "admin" });

    const inviteBase = { role: "member" as const, expiresAt: new Date(NOW.getTime() + DAY_MS) };
    const tag = Math.random().toString(36).slice(2);
    await db.insert(invites).values([
      { ...inviteBase, tokenHash: `t8-${tag}-1`, email: "a@example.test" },
      { ...inviteBase, tokenHash: `t8-${tag}-2`, email: "b@example.test", expiresAt: new Date(NOW.getTime() - DAY_MS) },
      { ...inviteBase, tokenHash: `t8-${tag}-3`, email: "c@example.test", status: "revoked" }
    ]);

    const edition = await insertEdition(new Date(NOW.getTime() - 30 * DAY_MS), new Date(NOW.getTime() - 29 * DAY_MS));
    await insertMedia({ cuencadaId: edition.id, moderationStatus: "pending_review" });
    await insertMedia({ cuencadaId: edition.id, moderationStatus: "pending_review", uploadStatus: "pending_upload" });
    await insertMedia({ cuencadaId: edition.id, moderationStatus: "pending_review", deletedAt: NOW });
    const reported = await insertMedia({ cuencadaId: edition.id });
    const handled = await insertMedia({ cuencadaId: edition.id, moderatedAt: new Date(Date.now() + DAY_MS) });
    await db.insert(mediaReports).values([
      { mediaId: reported.id, reporterUserId: member.user.id, reason: "other" },
      { mediaId: reported.id, reporterUserId: admin.user.id, reason: "privacy" },
      { mediaId: handled.id, reporterUserId: member.user.id, reason: "other" }
    ]);

    const after = await summary(admin);
    expect({
      usersActive: after.usersActive - before.usersActive,
      usersDisabled: after.usersDisabled - before.usersDisabled,
      usersUnverified: after.usersUnverified - before.usersUnverified,
      activeAdmins: after.activeAdmins - before.activeAdmins,
      invitesPending: after.invitesPending - before.invitesPending,
      mediaPendingReview: after.mediaPendingReview - before.mediaPendingReview,
      mediaReported: after.mediaReported - before.mediaReported
    }).toEqual({
      usersActive: 2,
      usersDisabled: 2,
      usersUnverified: 1,
      activeAdmins: 1,
      invitesPending: 1,
      mediaPendingReview: 1,
      mediaReported: 1
    });
  });

  it("reports the earliest published edition that has not ended, with its RSVP counts", async () => {
    const admin = await createMember({ role: "admin" });
    const member = await createMember();
    const guest = await createMember();
    const next = await insertEdition(new Date(NOW.getTime() + HOUR_MS), new Date(NOW.getTime() + 2 * HOUR_MS));
    const past = await insertEdition(new Date(NOW.getTime() - 3 * DAY_MS), new Date(NOW.getTime() - 2 * DAY_MS));
    await insertEdition(new Date(NOW.getTime() + 30 * 60_000), new Date(NOW.getTime() + DAY_MS), false);
    await getTestDb().insert(cuencadaRsvps).values([
      { cuencadaId: next.id, userId: member.user.id, status: "yes", guestCount: 2 },
      { cuencadaId: next.id, userId: admin.user.id, status: "yes", guestCount: 1 },
      { cuencadaId: next.id, userId: guest.user.id, status: "maybe", guestCount: 4 },
      { cuencadaId: past.id, userId: member.user.id, status: "no" }
    ]);

    expect((await summary(admin)).upcomingEdition).toEqual({
      cuencadaId: next.id,
      year: next.year,
      title: next.title,
      startsAt: next.startsAt.toISOString(),
      rsvpYes: 2,
      rsvpMaybe: 1,
      rsvpNo: 0,
      rsvpGuests: 3
    });
  });

  it("returns a null edition when nothing published is upcoming", async () => {
    // Inside a rolled-back transaction, so the check never depends on (or leaks) shared rows.
    const rollback = new Error("rollback");
    await expect(
      getTestDb().transaction(async (tx) => {
        await tx.delete(cuencadas);
        await insertEditionWith(tx, new Date(NOW.getTime() - 3 * DAY_MS), new Date(NOW.getTime() - 2 * DAY_MS));
        expect((await loadAdminSummary(tx, NOW)).upcomingEdition).toBeNull();
        throw rollback;
      })
    ).rejects.toBe(rollback);
  });

  it("answers 401 without a token and 403 for members", async () => {
    const member = await createMember();
    expect((await app.inject({ method: "GET", url: "/api/admin/summary" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/admin/summary", ...member.auth })).statusCode).toBe(403);
  });
});
