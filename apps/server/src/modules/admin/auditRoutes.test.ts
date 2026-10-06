import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

let app: App;
let admin: Member;
let member: Member;

beforeEach(async () => {
  app = await createTestApp();
  admin = await createMember({ role: "admin", displayName: "Admin Uno" });
  member = await createMember({ displayName: "Prima Ana" });
});

afterEach(async () => {
  await app.close();
});

async function seedAudits(): Promise<void> {
  const base = Date.parse("2026-09-01T00:00:00Z");
  const rows: Array<typeof auditLogs.$inferInsert> = [];
  for (let index = 0; index < 6; index += 1) {
    rows.push({
      actorUserId: index % 2 === 0 ? admin.user.id : null,
      action: index < 3 ? "user.disabled" : "cuencada.published",
      entityType: index < 3 ? "user" : "cuencada",
      entityId: index < 3 ? member.user.id : `c-${index}`,
      metadata: { fields: ["status"], index },
      ip: "203.0.113.7",
      createdAt: new Date(base + index * 60_000)
    });
  }
  // Two rows with the same timestamp exercise the id tie-breaker.
  rows.push({ actorUserId: null, action: "media.moderated", entityType: "media", entityId: null, createdAt: new Date(base + 5 * 60_000) });
  await getTestDb().insert(auditLogs).values(rows);
}

async function list(query: string): Promise<AuditPage> {
  const response = await app.inject({ method: "GET", url: `/api/admin/audit-logs${query}`, ...admin.auth });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<AuditPage>();
}

describe("GET /api/admin/audit-logs", () => {
  it("returns entries newest first with the actor's name and metadata as stored", async () => {
    await seedAudits();
    const page = await list("");
    expect(page.items).toHaveLength(7);
    const times = page.items.map((item) => Date.parse(item.createdAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    const first = page.items.find((item) => item.metadata.index === 4);
    expect(first).toMatchObject({
      actorUserId: admin.user.id,
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
    await seedAudits();
    expect((await list(`?actorUserId=${admin.user.id}`)).items.map((item) => item.metadata.index)).toEqual([4, 2, 0]);
    expect((await list("?action=user.disabled")).items).toHaveLength(3);
    expect((await list(`?entityType=user&entityId=${member.user.id}`)).items).toHaveLength(3);
    expect((await list("?entityType=cuencada&entityId=c-5")).items.map((item) => item.entityId)).toEqual(["c-5"]);
    const range = await list(`?from=${encodeURIComponent("2026-09-01T00:01:00Z")}&to=${encodeURIComponent("2026-08-31T18:03:00-06:00")}`);
    expect(range.items.map((item) => item.metadata.index)).toEqual([3, 2, 1]);
  });

  it("pages with a keyset cursor across identical timestamps without gaps or duplicates", async () => {
    await seedAudits();
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: AuditPage = await list(cursor === null ? "?limit=2" : `?limit=2&cursor=${cursor}`);
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(pages).toBe(4);
  });

  it("answers 400 for invalid filters, 401 without a token and 403 for members", async () => {
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
    for (const method of ["DELETE", "POST", "PATCH", "PUT"] as const) {
      const response = await app.inject({ method, url: "/api/admin/audit-logs", ...admin.auth });
      expect(response.statusCode, method).toBe(404);
    }
  });
});
