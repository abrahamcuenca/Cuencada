import { randomUUID } from "node:crypto";
import type { Announcement, ApiError, Page } from "@cuencada/types";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import { insertAnnouncement, insertCuencada, mutableClock } from "../../../test/helpers/cuencadas.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { type AuthInjectOptions, createUser, loginAs } from "../../../test/helpers/factories.js";
import type { App } from "../../app.js";
import { auditLogs } from "../../db/schema/index.js";

const NOW = "2026-09-01T18:00:00Z";

let app: App;
let admin: Awaited<ReturnType<typeof createUser>>;
let adminAuth: AuthInjectOptions;
let memberAuth: AuthInjectOptions;

beforeEach(async () => {
  app = await createTestApp({ clock: mutableClock(NOW) });
  admin = await createUser({ role: "admin", displayName: "Tía Admin" });
  adminAuth = await loginAs(app, admin);
  memberAuth = await loginAs(app, await createUser());
});

afterEach(async () => {
  await app.close();
});

async function auditCount(action: string): Promise<number> {
  return (await getTestDb().select().from(auditLogs).where(eq(auditLogs.action, action))).length;
}

describe("GET /api/announcements", () => {
  it("pages live portal-wide announcements (any visibility) pinned first, with a keyset cursor", async () => {
    const edition = await insertCuencada();
    for (let index = 0; index < 5; index += 1) {
      await insertAnnouncement({
        cuencadaId: null,
        title: `General ${index}`,
        visibility: index % 2 === 0 ? "public" : "members",
        publishAt: new Date(Date.UTC(2026, 0, index + 1))
      });
    }
    await insertAnnouncement({ cuencadaId: null, title: "Fijado", pinned: true, publishAt: new Date("2025-01-01T00:00:00Z") });
    await insertAnnouncement({ cuencadaId: edition.id, title: "De la edición" });
    await insertAnnouncement({ cuencadaId: null, title: "Programado", publishAt: new Date("2026-12-01T00:00:00Z") });
    await insertAnnouncement({
      cuencadaId: null,
      title: "Vencido",
      publishAt: new Date("2026-01-01T00:00:00Z"),
      expiresAt: new Date("2026-08-01T00:00:00Z")
    });

    const titles: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = cursor === null ? "?limit=2" : `?limit=2&cursor=${cursor}`;
      const response = await app.inject({ method: "GET", url: `/api/announcements${query}`, ...memberAuth });
      expect(response.statusCode).toBe(200);
      const page = response.json<Page<Announcement>>();
      titles.push(...page.items.map((item) => item.title));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);

    expect(titles).toEqual(["Fijado", "General 4", "General 3", "General 2", "General 1", "General 0"]);
    expect(pages).toBe(3);
  });

  it("answers 401 without a token and 400 for a bad cursor or limit", async () => {
    const anonymous = await app.inject({ method: "GET", url: "/api/announcements" });
    const badCursor = await app.inject({ method: "GET", url: "/api/announcements?cursor=bm9wZQ", ...memberAuth });
    const badLimit = await app.inject({ method: "GET", url: "/api/announcements?limit=1000", ...memberAuth });

    expect(anonymous.statusCode).toBe(401);
    expect(badCursor.statusCode).toBe(400);
    expect(badLimit.statusCode).toBe(400);
  });
});

describe("admin announcements", () => {
  it("creates portal-wide and edition announcements with author, window and audit", async () => {
    const edition = await insertCuencada();

    const portal = await app.inject({
      method: "POST",
      url: "/api/admin/announcements",
      payload: { cuencadaId: null, title: "Bienvenidos", body: "Hola familia", visibility: "public", pinned: true },
      ...adminAuth
    });
    const scheduled = await app.inject({
      method: "POST",
      url: "/api/admin/announcements",
      payload: {
        cuencadaId: edition.id,
        title: "Letra oficial",
        body: "Enlace",
        publishedAt: "2026-09-10T00:00:00-06:00",
        expiresAt: "2026-09-20T00:00:00-06:00"
      },
      ...adminAuth
    });

    expect(portal.statusCode).toBe(201);
    expect(portal.json<Announcement>()).toMatchObject({
      cuencadaId: null,
      pinned: true,
      visibility: "public",
      authorName: "Tía Admin",
      publishedAt: new Date(NOW).toISOString(),
      expiresAt: null
    });
    expect(scheduled.json<Announcement>()).toMatchObject({
      visibility: "members",
      publishedAt: "2026-09-10T06:00:00.000Z",
      expiresAt: "2026-09-20T06:00:00.000Z"
    });
    expect(await auditCount("announcement.created")).toBe(2);
  });

  it("rejects bad input with 400", async () => {
    const unknownEdition = await app.inject({
      method: "POST",
      url: "/api/admin/announcements",
      payload: { cuencadaId: randomUUID(), title: "X", body: "Y" },
      ...adminAuth
    });
    const expiresFirst = await app.inject({
      method: "POST",
      url: "/api/admin/announcements",
      payload: { cuencadaId: null, title: "X", body: "Y", publishedAt: "2026-09-10T00:00:00Z", expiresAt: "2026-09-09T00:00:00Z" },
      ...adminAuth
    });
    const expiresBeforeDefaultNow = await app.inject({
      method: "POST",
      url: "/api/admin/announcements",
      payload: { cuencadaId: null, title: "X", body: "Y", expiresAt: "2026-08-01T00:00:00Z" },
      ...adminAuth
    });
    const missingTitle = await app.inject({
      method: "POST",
      url: "/api/admin/announcements",
      payload: { cuencadaId: null, body: "Y" },
      ...adminAuth
    });

    expect(unknownEdition.statusCode).toBe(400);
    expect(unknownEdition.json<ApiError>().error.details?.[0]?.path).toBe("cuencadaId");
    expect(expiresFirst.statusCode).toBe(400);
    expect(expiresBeforeDefaultNow.statusCode).toBe(400);
    expect(missingTitle.statusCode).toBe(400);
  });

  it("lists by Cuencada or scope, including scheduled and expired ones", async () => {
    const edition = await insertCuencada();
    await insertAnnouncement({ cuencadaId: null, title: "General" });
    await insertAnnouncement({ cuencadaId: edition.id, title: "Edición" });
    await insertAnnouncement({ cuencadaId: edition.id, title: "Programado", publishAt: new Date("2027-01-01T00:00:00Z") });

    const list = async (query: string): Promise<string[]> =>
      (await app.inject({ method: "GET", url: `/api/admin/announcements${query}`, ...adminAuth }))
        .json<Announcement[]>()
        .map((a) => a.title)
        .sort();

    expect(await list("")).toEqual(["Edición", "General", "Programado"]);
    expect(await list("?scope=portal")).toEqual(["General"]);
    expect(await list("?scope=cuencada")).toEqual(["Edición", "Programado"]);
    expect(await list(`?cuencadaId=${edition.id}`)).toEqual(["Edición", "Programado"]);
    const conflicting = await app.inject({
      method: "GET",
      url: `/api/admin/announcements?scope=portal&cuencadaId=${edition.id}`,
      ...adminAuth
    });
    expect(conflicting.statusCode).toBe(400);
  });

  it("patches with a merged publish/expiry check and deletes", async () => {
    const row = await insertAnnouncement({ cuencadaId: null, publishAt: new Date("2026-09-10T00:00:00Z") });
    const url = `/api/admin/announcements/${row.id}`;

    const expiresBeforePublish = await app.inject({ method: "PATCH", url, payload: { expiresAt: "2026-09-09T00:00:00Z" }, ...adminAuth });
    const empty = await app.inject({ method: "PATCH", url, payload: {}, ...adminAuth });
    const ok = await app.inject({ method: "PATCH", url, payload: { pinned: true, expiresAt: "2026-09-30T00:00:00Z" }, ...adminAuth });
    const removed = await app.inject({ method: "DELETE", url, ...adminAuth });
    const missing = await app.inject({ method: "PATCH", url, payload: { pinned: false }, ...adminAuth });
    const missingDelete = await app.inject({ method: "DELETE", url, ...adminAuth });

    expect(expiresBeforePublish.statusCode).toBe(400);
    expect(expiresBeforePublish.json<ApiError>().error.details?.[0]?.path).toBe("expiresAt");
    expect(empty.statusCode).toBe(400);
    expect(ok.statusCode).toBe(200);
    expect(ok.json<Announcement>()).toMatchObject({ pinned: true, expiresAt: "2026-09-30T00:00:00.000Z" });
    expect(removed.statusCode).toBe(204);
    expect(missing.statusCode).toBe(404);
    expect(missingDelete.statusCode).toBe(404);
    expect(await auditCount("announcement.updated")).toBe(1);
    expect(await auditCount("announcement.deleted")).toBe(1);
  });

  it("answers 401 without a token and 403 for members on every admin route", async () => {
    const id = randomUUID();
    const routes = [
      { method: "GET" as const, url: "/api/admin/announcements" },
      { method: "POST" as const, url: "/api/admin/announcements", payload: { cuencadaId: null, title: "X", body: "Y" } },
      { method: "PATCH" as const, url: `/api/admin/announcements/${id}`, payload: { pinned: true } },
      { method: "DELETE" as const, url: `/api/admin/announcements/${id}` }
    ];
    for (const route of routes) {
      expect((await app.inject(route)).statusCode, `${route.method} ${route.url}`).toBe(401);
      expect((await app.inject({ ...route, ...memberAuth })).statusCode, `${route.method} ${route.url}`).toBe(403);
    }
  });
});
