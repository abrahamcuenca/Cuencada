import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import { DAY_MS, TestClock } from "../../../test/helpers/auth.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { createSession, createUser } from "../../../test/helpers/factories.js";
import { magicLinks, refreshTokens, sessions } from "../../db/schema/index.js";
import { purgeSpentAuthRows } from "./cleanup.js";

function hash(): string {
  return randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
}

describe("purgeSpentAuthRows", () => {
  it("purges spent rows, keeps live sessions' used tokens for reuse detection, and is idempotent", async () => {
    const db = getTestDb();
    const base = new Date();
    // Pretend the purge runs 40 days after these rows were created.
    const clock = new TestClock(new Date(base.getTime() + 40 * DAY_MS));
    const now = clock.now();
    const user = await createUser();

    const live = await createSession(user.id, {
      now,
      idleExpiresAt: new Date(now.getTime() + 30 * DAY_MS),
      absoluteExpiresAt: new Date(now.getTime() + 60 * DAY_MS)
    });
    const deadOld = await createSession(user.id, { now: base });
    await db.update(sessions).set({ revokedAt: base, revokedReason: "logout" }).where(eq(sessions.id, deadOld.id));
    const deadRecent = await createSession(user.id, {
      now,
      idleExpiresAt: new Date(now.getTime() + 30 * DAY_MS),
      absoluteExpiresAt: new Date(now.getTime() + 60 * DAY_MS)
    });
    await db
      .update(sessions)
      .set({ revokedAt: new Date(now.getTime() - 10 * DAY_MS), revokedReason: "logout" })
      .where(eq(sessions.id, deadRecent.id));
    // Tokens are created "now" in DB time, i.e. 40 days before the purge clock.
    for (const sessionId of [live.id, deadOld.id, deadRecent.id]) {
      await db.insert(refreshTokens).values({ sessionId, tokenHash: hash(), expiresAt: base, usedAt: base });
    }
    const [spentLink] = await db
      .insert(magicLinks)
      .values({ email: user.email, userId: user.id, tokenHash: hash(), expiresAt: base, usedAt: base })
      .returning();
    const [freshLink] = await db
      .insert(magicLinks)
      .values({ email: user.email, userId: user.id, tokenHash: hash(), expiresAt: new Date(now.getTime() + DAY_MS) })
      .returning();

    const first = await purgeSpentAuthRows(db, now);
    const second = await purgeSpentAuthRows(db, now);

    expect(first).toEqual({ magicLinks: 1, sessions: 1, refreshTokens: 1 });
    expect(second).toEqual({ magicLinks: 0, sessions: 0, refreshTokens: 0 });
    const remainingSessions = (await db.select().from(sessions)).map((row) => row.id).sort();
    expect(remainingSessions).toEqual([live.id, deadRecent.id].sort());
    const remainingTokens = (await db.select().from(refreshTokens)).map((row) => row.sessionId);
    expect(remainingTokens).toEqual([live.id]);
    const remainingLinks = (await db.select().from(magicLinks)).map((row) => row.id);
    expect(remainingLinks).toEqual([freshLink?.id]);
    expect(remainingLinks).not.toContain(spentLink?.id);
  });

  it("is registered by the auth module and stops with the app", async () => {
    const app = await createTestApp();
    // Closing must clear the interval (the test would otherwise leak a timer).
    await expect(app.close()).resolves.toBeUndefined();
  });
});
