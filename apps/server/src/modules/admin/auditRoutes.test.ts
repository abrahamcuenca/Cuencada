/**
 * Audit log viewer tests. Isolation: one app per file (cheap per-test hooks),
 * and every test seeds its rows into its own time window and only queries
 * inside it, so rows left by any other test can never change the results.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { createMember, type Member } from "../../../test/helpers/media.js";
import type { App } from "../../app.js";
import { auditLogs } from "../../db/schema/index.js";

interface AuditItem {
  id: string;
  actorUserId: string | null;
  actorName: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
}

interface AuditPage {
  items: AuditItem[];
  nextCursor: string | null;
}

interface Fixture {
  admin: Member;
  member: Member;
  /** `from`/`to` query covering exactly this test's rows. */
  window: string;
  base: number;
}

const MINUTE_MS = 60_000;
let app: App;
let windowIndex = 0;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

/** Seed 7 audit rows (one timestamp tie) inside a window no other test uses. */
async function seed(): Promise<Fixture> {
  windowIndex += 1;
  const base = Date.UTC(2001, 0, windowIndex);
  const admin = await createMember({ role: "admin", displayName: "Admin Uno" });
  const member = await createMember({ displayName: "Prima Ana" });
  const rows: Array<typeof auditLogs.$inferInsert> = [];
  for (let index = 0; index < 6; index += 1) {
    rows.push({
      actorUserId: index % 2 === 0 ? admin.user.id : null,
      action: index < 3 ? "user.disabled" : "cuencada.published",
      entityType: index < 3 ? "user" : "cuencada",
      entityId: index < 3 ? member.user.id : `c-${index}`,
      metadata: { fields: ["status"], index },
      ip: "203.0.113.7",
      createdAt: new Date(base + index * MINUTE_MS)
    });
  }
  // Same timestamp as index 5: exercises the id tie-breaker.
  rows.push({ actorUserId: null, action: "media.moderated", entityType: "media", entityId: null, createdAt: new Date(base + 5 * MINUTE_MS) });
  await getTestDb().insert(auditLogs).values(rows);
  const from = new Date(base).toISOString();
  const to = new Date(base + 10 * MINUTE_MS).toISOString();
  return { admin, member, base, window: `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` };
}

async function list(fixture: Fixture, query = ""): Promise<AuditPage> {
  const response = await app.inject({
    method: "GET",
    url: `/api/admin/audit-logs?${fixture.window}${query}`,
    ...fixture.admin.auth
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<AuditPage>();
}

describe("GET /api/admin/audit-logs", () => {
  it("returns entries newest first with the actor's name and metadata as stored", async () => {
    const fixture = await seed();
    const page = await list(fixture);
    expect(page.items).toHaveLength(7);
    const times = page.items.map((item) => Date.parse(item.createdAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(page.items.find((item) => item.metadata.index === 4)).toMatchObject({
      actorUserId: fixture.admin.user.id,
      actorName: "Admin Uno",
      action: "cuencada.published",
      entityType: "cuencada",
      entityId: "c-4",
      metadata: { fields: ["status"], index: 4 },
      ip: "203.0.113.7"
    });
    expect(page.items.find((item) => item.metadata.index === 1)?.actorName).toBeNull();
  });

  it("filters by actor, action, entity and time range", async () => {
    const fixture = await seed();
    const indexes = (page: AuditPage): unknown[] => page.items.map((item) => item.metadata.index);
    expect(indexes(await list(fixture, `&actorUserId=${fixture.admin.user.id}`))).toEqual([4, 2, 0]);
    expect((await list(fixture, "&action=user.disabled")).items).toHaveLength(3);
    expect((await list(fixture, `&entityType=user&entityId=${fixture.member.user.id}`)).items).toHaveLength(3);
    expect((await list(fixture, "&entityType=cuencada&entityId=c-5")).items.map((item) => item.entityId)).toEqual(["c-5"]);

    const from = new Date(fixture.base + MINUTE_MS).toISOString();
    // Same instant as base + 3 min, written with a -06:00 offset.
    const to = new Date(fixture.base + 3 * MINUTE_MS - 6 * 60 * MINUTE_MS).toISOString().replace("Z", "-06:00");
    const narrow = await app.inject({
      method: "GET",
      url: `/api/admin/audit-logs?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      ...fixture.admin.auth
    });
    expect(narrow.statusCode).toBe(200);
    // `from` is inclusive, `to` exclusive: the row at exactly `to` (index 3) is out.
    expect(indexes(narrow.json<AuditPage>())).toEqual([2, 1]);
  });

  it("treats `to` as an exclusive bound with microsecond precision (hasta + 1 day semantics)", async () => {
    const fixture = await seed();
    const dayAfter = fixture.base + 2 * MINUTE_MS;
    // A row 1 µs before the bound (not representable in a JS Date) and one exactly on it.
    await getTestDb().execute(
      sql`insert into ${auditLogs} (action, entity_type, metadata, created_at) values
        ('media.moderated', 'media', '{"index": "last-microsecond"}'::jsonb, ${new Date(dayAfter).toISOString()}::timestamptz - interval '1 microsecond'),
        ('media.moderated', 'media', '{"index": "on-bound"}'::jsonb, ${new Date(dayAfter).toISOString()}::timestamptz)`
    );
    const from = new Date(fixture.base).toISOString();
    const response = await app.inject({
      method: "GET",
      url: `/api/admin/audit-logs?from=${encodeURIComponent(from)}&to=${encodeURIComponent(new Date(dayAfter).toISOString())}&entityType=media`,
      ...fixture.admin.auth
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<AuditPage>().items.map((item) => item.metadata.index)).toEqual(["last-microsecond"]);
  });

  it("pages with a keyset cursor across identical timestamps without gaps or duplicates", async () => {
    const fixture = await seed();
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: AuditPage = await list(fixture, cursor === null ? "&limit=2" : `&limit=2&cursor=${cursor}`);
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(pages).toBe(4);
  });

  it("answers 400 for invalid filters, 401 without a token and 403 for members", async () => {
    const admin = await createMember({ role: "admin" });
    const member = await createMember();
    for (const query of [
      "?from=2026-09-02T00:00:00Z&to=2026-09-01T00:00:00Z",
      "?actorUserId=nope",
      "?entityType=planet",
      "?action=Bad",
      "?cursor=bm9wZQ",
      "?limit=101"
    ]) {
      const response = await app.inject({ method: "GET", url: `/api/admin/audit-logs${query}`, ...admin.auth });
      expect(response.statusCode, query).toBe(400);
    }
    expect((await app.inject({ method: "GET", url: "/api/admin/audit-logs" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/admin/audit-logs", ...member.auth })).statusCode).toBe(403);
  });

  it("has no write or delete endpoint", async () => {
    const admin = await createMember({ role: "admin" });
    for (const method of ["DELETE", "POST", "PATCH", "PUT"] as const) {
      const response = await app.inject({ method, url: "/api/admin/audit-logs", ...admin.auth });
      expect(response.statusCode, method).toBe(404);
    }
  });
});
