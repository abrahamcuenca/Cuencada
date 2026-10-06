import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import { TestClock } from "../../../test/helpers/auth.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { bearerFor, createSession, createUser } from "../../../test/helpers/factories.js";
import { createCuencada, insertMedia, type Member } from "../../../test/helpers/media.js";
import type { App } from "../../app.js";
import { cuencadaRsvps, invites, mediaReports } from "../../db/schema/index.js";

const NOW = new Date("2026-10-06T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

let app: App;
let admin: Member;
let member: Member;

/** A user whose session and token are issued at the fixed test time. */
async function createMember(options: Parameters<typeof createUser>[0] = {}): Promise<Member> {
  const user = await createUser({ emailVerified: true, ...options });
  return { user, auth: await bearerFor(user, await createSession(user.id, { now: NOW }), { now: NOW }) };
}

beforeEach(async () => {
  app = await createTestApp({ clock: new TestClock(NOW) });
  admin = await createMember({ role: "admin" });
  member = await createMember();
});

afterEach(async () => {
  await app.close();
});

describe("GET /api/admin/summary", () => {
  it("counts users, invites, media needing attention and the next edition's RSVPs", async () => {
    const db = getTestDb();
    await createUser({ status: "disabled" });
    const unverified = await createUser({ emailVerified: false });
    await createUser({ emailVerified: false, status: "disabled" });

    const inviteBase = { tokenHash: "", role: "member" as const, expiresAt: new Date(NOW.getTime() + DAY_MS) };
    await db.insert(invites).values([
      { ...inviteBase, tokenHash: "h1", email: "a@example.test" },
      { ...inviteBase, tokenHash: "h2", email: "b@example.test", expiresAt: new Date(NOW.getTime() - DAY_MS) },
      { ...inviteBase, tokenHash: "h3", email: "c@example.test", status: "revoked" }
    ]);

    const past = await createCuencada({ year: 2025 });
    const upcoming = await createCuencada({ year: 2026 });
    await createCuencada({ year: 2027 });
    await createCuencada({ year: 2028, isPublished: false });

    await insertMedia({ cuencadaId: upcoming.id, moderationStatus: "pending_review" });
    await insertMedia({ cuencadaId: upcoming.id, moderationStatus: "pending_review", uploadStatus: "pending_upload" });
    await insertMedia({ cuencadaId: upcoming.id, moderationStatus: "pending_review", deletedAt: NOW });
    const reported = await insertMedia({ cuencadaId: upcoming.id });
    const handled = await insertMedia({ cuencadaId: upcoming.id, moderatedAt: new Date(Date.now() + DAY_MS) });
    await db.insert(mediaReports).values([
      { mediaId: reported.id, reporterUserId: member.user.id, reason: "other" },
      { mediaId: reported.id, reporterUserId: admin.user.id, reason: "privacy" },
      { mediaId: handled.id, reporterUserId: member.user.id, reason: "other" }
    ]);

    await db.insert(cuencadaRsvps).values([
      { cuencadaId: upcoming.id, userId: member.user.id, status: "yes", guestCount: 2 },
      { cuencadaId: upcoming.id, userId: admin.user.id, status: "yes", guestCount: 1 },
      { cuencadaId: upcoming.id, userId: unverified.id, status: "maybe", guestCount: 4 },
      { cuencadaId: past.id, userId: member.user.id, status: "no" }
    ]);

    const response = await app.inject({ method: "GET", url: "/api/admin/summary", ...admin.auth });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      usersActive: 3,
      usersDisabled: 2,
      usersUnverified: 1,
      activeAdmins: 1,
      invitesPending: 1,
      mediaPendingReview: 1,
      mediaReported: 1,
      upcomingEdition: {
        cuencadaId: upcoming.id,
        year: 2026,
        title: "Cuencada 2026",
        startsAt: upcoming.startsAt.toISOString(),
        rsvpYes: 2,
        rsvpMaybe: 1,
        rsvpNo: 0,
        rsvpGuests: 3
      }
    });
  });

  it("returns a null edition when nothing published is upcoming", async () => {
    await createCuencada({ year: 2025 });
    const response = await app.inject({ method: "GET", url: "/api/admin/summary", ...admin.auth });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ upcomingEdition: unknown; usersActive: number }>()).toMatchObject({
      upcomingEdition: null,
      usersActive: 2
    });
  });

  it("answers 401 without a token and 403 for members", async () => {
    expect((await app.inject({ method: "GET", url: "/api/admin/summary" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/admin/summary", ...member.auth })).statusCode).toBe(403);
  });
});
