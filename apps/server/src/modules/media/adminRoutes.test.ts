import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { FakeStorage } from "../../../test/helpers/fakes.js";
import { createCuencada, createMember, insertMedia, type Member, makePng, uploadMedia } from "../../../test/helpers/media.js";
import type { App } from "../../app.js";
import { auditLogs, mediaItems, mediaReports } from "../../db/schema/index.js";

interface AdminPage {
  items: Array<Record<string, unknown> & { id: string }>;
  nextCursor: string | null;
}

let app: App;
let storage: FakeStorage;
let cuencadaId: string;
let member: Member;
let admin: Member;

async function startApp(requireApproval: boolean): Promise<void> {
  storage = new FakeStorage();
  app = await createTestApp({ storage, config: { MEDIA_REQUIRE_APPROVAL: requireApproval } });
}

beforeEach(async () => {
  cuencadaId = (await createCuencada()).id;
  member = await createMember({ displayName: "Prima" });
  admin = await createMember({ role: "admin", displayName: "Admin" });
});

afterEach(async () => {
  await app.close();
});

async function adminList(query = ""): Promise<AdminPage> {
  const response = await app.inject({ method: "GET", url: `/api/admin/media${query}`, ...admin.auth });
  expect(response.statusCode).toBe(200);
  return response.json<AdminPage>();
}

describe("GET /api/admin/media", () => {
  it("filters the queue by moderation status and reports", async () => {
    await startApp(false);
    const review = await insertMedia({ cuencadaId, uploadedByUserId: member.user.id, moderationStatus: "pending_review" });
    const hidden = await insertMedia({ cuencadaId, moderationStatus: "hidden" });
    const reported = await insertMedia({ cuencadaId, fileName: "IMG_9.JPG" });
    await insertMedia({ cuencadaId, uploadStatus: "pending_upload" });
    await insertMedia({ cuencadaId, deletedAt: new Date() });
    await getTestDb().insert(mediaReports).values({ mediaId: reported.id, reporterUserId: member.user.id, reason: "other" });

    const pending = await adminList("?moderationStatus=pending_review");
    const hiddenOnly = await adminList("?moderationStatus=hidden");
    const reportedOnly = await adminList("?reported=true");
    const all = await adminList();

    expect(pending.items.map((item) => item.id)).toEqual([review.id]);
    expect(pending.items[0]).toMatchObject({ uploaderUserId: member.user.id, uploaderName: "Prima", reportCount: 0 });
    expect(hiddenOnly.items.map((item) => item.id)).toEqual([hidden.id]);
    expect(reportedOnly.items.map((item) => item.id)).toEqual([reported.id]);
    expect(reportedOnly.items[0]).toMatchObject({ reportCount: 1, fileName: "IMG_9.JPG", byteSize: 1000 });
    expect(all.items).toHaveLength(3);
    expect(JSON.stringify(all)).not.toContain("objectKey");
  });

  it("answers 403 to members, 401 without a token and 400 for a bad filter", async () => {
    await startApp(false);

    const asMember = await app.inject({ method: "GET", url: "/api/admin/media", ...member.auth });
    const anonymous = await app.inject({ method: "GET", url: "/api/admin/media" });
    const bad = await app.inject({ method: "GET", url: "/api/admin/media?moderationStatus=deleted", ...admin.auth });

    expect(asMember.statusCode).toBe(403);
    expect(anonymous.statusCode).toBe(401);
    expect(bad.statusCode).toBe(400);
  });
});

describe("GET /api/admin/media/:id/reports", () => {
  it("lists reports with reporter names and 404s unknown items", async () => {
    await startApp(false);
    const item = await insertMedia({ cuencadaId });
    await getTestDb()
      .insert(mediaReports)
      .values({ mediaId: item.id, reporterUserId: member.user.id, reason: "privacy", details: "Mi casa" });

    const response = await app.inject({ method: "GET", url: `/api/admin/media/${item.id}/reports`, ...admin.auth });
    const unknown = await app.inject({
      method: "GET",
      url: "/api/admin/media/6f1d3b0e-2c4a-4b8e-9f00-1234567890ab/reports",
      ...admin.auth
    });
    const asMember = await app.inject({ method: "GET", url: `/api/admin/media/${item.id}/reports`, ...member.auth });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      { id: expect.any(String), reason: "privacy", details: "Mi casa", reporterName: "Prima", createdAt: expect.any(String) }
    ]);
    expect(unknown.statusCode).toBe(404);
    expect(asMember.statusCode).toBe(403);
  });
});

describe("POST /api/admin/media/:id/moderate", () => {
  it("approves an approval-first upload so members can see it, recording moderator and audit", async () => {
    await startApp(true);
    const upload = await uploadMedia(app, storage, member.auth, await makePng(), { mimeType: "image/png" });
    const viewer = await createMember();
    const before = await app.inject({ method: "GET", url: "/api/cuencadas/2026/media", ...viewer.auth });
    expect(before.json<AdminPage>().items).toHaveLength(0);

    const response = await app.inject({
      method: "POST",
      url: `/api/admin/media/${upload.mediaId}/moderate`,
      ...admin.auth,
      payload: { action: "approve", note: "Ok" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      moderationStatus: "approved",
      moderatedByName: "Admin",
      moderationNote: "Ok",
      moderatedAt: expect.any(String)
    });
    const after = await app.inject({ method: "GET", url: "/api/cuencadas/2026/media", ...viewer.auth });
    expect(after.json<AdminPage>().items.map((item) => item.id)).toEqual([upload.mediaId]);
    const [audit] = await getTestDb()
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "media.moderated"), eq(auditLogs.entityId, upload.mediaId)));
    expect(audit).toMatchObject({ actorUserId: admin.user.id });
    expect(audit?.metadata).toMatchObject({ action: "approve", previousStatus: "pending_review", hasNote: true });
  });

  it("auto-approves when the approval flag is off, and hiding removes the item from member lists", async () => {
    await startApp(false);
    const upload = await uploadMedia(app, storage, member.auth, await makePng(), { mimeType: "image/png" });
    const viewer = await createMember();
    const before = await app.inject({ method: "GET", url: "/api/cuencadas/2026/media", ...viewer.auth });
    expect(before.json<AdminPage>().items.map((item) => item.id)).toEqual([upload.mediaId]);

    const hide = await app.inject({
      method: "POST",
      url: `/api/admin/media/${upload.mediaId}/moderate`,
      ...admin.auth,
      payload: { action: "hide" }
    });

    expect(hide.statusCode).toBe(200);
    expect(hide.json()).toMatchObject({ moderationStatus: "hidden", moderationNote: null });
    const after = await app.inject({ method: "GET", url: "/api/cuencadas/2026/media", ...viewer.auth });
    expect(after.json<AdminPage>().items).toHaveLength(0);
    const own = await app.inject({ method: "GET", url: "/api/cuencadas/2026/media", ...member.auth });
    expect(own.json<AdminPage>().items).toHaveLength(0);
  });

  it("deletes softly, removes the objects and then answers 404", async () => {
    await startApp(false);
    const upload = await uploadMedia(app, storage, member.auth, await makePng(), { mimeType: "image/png" });

    const removed = await app.inject({
      method: "POST",
      url: `/api/admin/media/${upload.mediaId}/moderate`,
      ...admin.auth,
      payload: { action: "delete", note: "Duplicada" }
    });
    const again = await app.inject({
      method: "POST",
      url: `/api/admin/media/${upload.mediaId}/moderate`,
      ...admin.auth,
      payload: { action: "approve" }
    });

    expect(removed.statusCode).toBe(200);
    expect(storage.objects.size).toBe(0);
    const [row] = await getTestDb().select().from(mediaItems).where(eq(mediaItems.id, upload.mediaId));
    expect(row?.deletedAt).not.toBeNull();
    expect(row?.deletedByUserId).toBe(admin.user.id);
    expect(again.statusCode).toBe(404);
  });

  it("answers 403 to members, 400 for an unknown action and 404 for pending uploads", async () => {
    await startApp(false);
    const item = await insertMedia({ cuencadaId });
    const pending = await insertMedia({ cuencadaId, uploadStatus: "pending_upload" });

    const asMember = await app.inject({ method: "POST", url: `/api/admin/media/${item.id}/moderate`, ...member.auth, payload: { action: "hide" } });
    const badAction = await app.inject({ method: "POST", url: `/api/admin/media/${item.id}/moderate`, ...admin.auth, payload: { action: "burn" } });
    const notConfirmed = await app.inject({ method: "POST", url: `/api/admin/media/${pending.id}/moderate`, ...admin.auth, payload: { action: "approve" } });

    expect(asMember.statusCode).toBe(403);
    expect(badAction.statusCode).toBe(400);
    expect(notConfirmed.statusCode).toBe(404);
  });
});
