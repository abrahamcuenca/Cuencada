import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { FakeStorage } from "../../../test/helpers/fakes.js";
import { createCuencada, createMember, insertMedia, type Member, makePng, uploadMedia } from "../../../test/helpers/media.js";
import type { App } from "../../app.js";
import { auditLogs, mediaItems, mediaReports } from "../../db/schema/index.js";

let app: App;
let storage: FakeStorage;
let cuencadaId: string;
let owner: Member;
let other: Member;
let admin: Member;

beforeEach(async () => {
  storage = new FakeStorage();
  app = await createTestApp({ storage });
  cuencadaId = (await createCuencada()).id;
  owner = await createMember();
  other = await createMember();
  admin = await createMember({ role: "admin" });
});

afterEach(async () => {
  await app.close();
});

async function auditFor(action: string, entityId: string): Promise<Array<typeof auditLogs.$inferSelect>> {
  return getTestDb()
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, action), eq(auditLogs.entityId, entityId)));
}

async function row(id: string): Promise<typeof mediaItems.$inferSelect | undefined> {
  const [found] = await getTestDb().select().from(mediaItems).where(eq(mediaItems.id, id));
  return found;
}

describe("PATCH /api/media/:id", () => {
  it("lets the uploader and an admin edit the caption, with audit", async () => {
    const item = await insertMedia({ cuencadaId, uploadedByUserId: owner.user.id });

    const byOwner = await app.inject({ method: "PATCH", url: `/api/media/${item.id}`, ...owner.auth, payload: { caption: "  Atardecer  " } });
    const byAdmin = await app.inject({ method: "PATCH", url: `/api/media/${item.id}`, ...admin.auth, payload: { caption: "" } });

    expect(byOwner.statusCode).toBe(200);
    expect(byOwner.json()).toMatchObject({ caption: "Atardecer", isMine: true, canEdit: true });
    expect(byAdmin.statusCode).toBe(200);
    expect(byAdmin.json()).toMatchObject({ caption: null });
    const audits = await auditFor("media.updated", item.id);
    expect(audits.map((audit) => audit.metadata)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ byAdmin: false }),
        expect.objectContaining({ byAdmin: true })
      ])
    );
  });

  it("answers 404 to another member, 400 for a long caption and 401 without a token", async () => {
    const item = await insertMedia({ cuencadaId, uploadedByUserId: owner.user.id });

    const byOther = await app.inject({ method: "PATCH", url: `/api/media/${item.id}`, ...other.auth, payload: { caption: "x" } });
    const tooLong = await app.inject({ method: "PATCH", url: `/api/media/${item.id}`, ...owner.auth, payload: { caption: "x".repeat(501) } });
    const anonymous = await app.inject({ method: "PATCH", url: `/api/media/${item.id}`, payload: { caption: "x" } });

    expect(byOther.statusCode).toBe(404);
    expect(tooLong.statusCode).toBe(400);
    expect(anonymous.statusCode).toBe(401);
    expect((await row(item.id))?.caption).toBeNull();
  });
});

describe("DELETE /api/media/:id", () => {
  it("soft-deletes a ready item, removes every object and audits once; repeats answer 204", async () => {
    const upload = await uploadMedia(app, storage, owner.auth, await makePng(), { mimeType: "image/png" });
    expect(storage.objects.size).toBe(2); // thumb + display; the original was deleted after processing

    const first = await app.inject({ method: "DELETE", url: `/api/media/${upload.mediaId}`, ...owner.auth });
    const second = await app.inject({ method: "DELETE", url: `/api/media/${upload.mediaId}`, ...owner.auth });

    expect(first.statusCode).toBe(204);
    expect(first.body).toBe("");
    expect(second.statusCode).toBe(204);
    expect(storage.objects.size).toBe(0);
    expect((await row(upload.mediaId))?.deletedAt).not.toBeNull();
    expect((await row(upload.mediaId))?.deletedByUserId).toBe(owner.user.id);
    expect(await auditFor("media.deleted", upload.mediaId)).toHaveLength(1);
    const listed = await app.inject({ method: "GET", url: `/api/media/${upload.mediaId}`, ...owner.auth });
    expect(listed.statusCode).toBe(404);
  });

  it.each(["pending_upload", "processing", "failed"] as const)("lets the uploader cancel an item in %s", async (uploadStatus) => {
    const item = await insertMedia({ cuencadaId, uploadedByUserId: owner.user.id, uploadStatus, thumbKey: null, displayKey: null });
    await storage.put({ key: item.objectKey, body: new Uint8Array([1, 2, 3]), contentType: "image/jpeg" });

    const response = await app.inject({ method: "DELETE", url: `/api/media/${item.id}`, ...owner.auth });

    expect(response.statusCode).toBe(204);
    expect(storage.objects.has(item.objectKey)).toBe(false);
    expect((await row(item.id))?.deletedAt).not.toBeNull();
  });

  it("lets an admin delete anyone's item and answers 404 to other members and for unknown ids", async () => {
    const item = await insertMedia({ cuencadaId, uploadedByUserId: owner.user.id });
    const pending = await insertMedia({ cuencadaId, uploadedByUserId: owner.user.id, uploadStatus: "pending_upload" });

    const byOther = await app.inject({ method: "DELETE", url: `/api/media/${item.id}`, ...other.auth });
    const pendingByOther = await app.inject({ method: "DELETE", url: `/api/media/${pending.id}`, ...other.auth });
    const unknown = await app.inject({ method: "DELETE", url: "/api/media/6f1d3b0e-2c4a-4b8e-9f00-1234567890ab", ...owner.auth });
    const anonymous = await app.inject({ method: "DELETE", url: `/api/media/${item.id}` });
    const byAdmin = await app.inject({ method: "DELETE", url: `/api/media/${item.id}`, ...admin.auth });

    expect(byOther.statusCode).toBe(404);
    expect(pendingByOther.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(anonymous.statusCode).toBe(401);
    expect(byAdmin.statusCode).toBe(204);
    const [audit] = await auditFor("media.deleted", item.id);
    expect(audit?.actorUserId).toBe(admin.user.id);
    expect(audit?.metadata).toMatchObject({ byAdmin: true });
  });
});

describe("POST /api/media/:id/report", () => {
  it("records one report per member and answers 409 on repeat, with audit but without details", async () => {
    const item = await insertMedia({ cuencadaId, uploadedByUserId: owner.user.id });
    const payload = { reason: "privacy", details: "Sale mi dirección" };

    const first = await app.inject({ method: "POST", url: `/api/media/${item.id}/report`, ...other.auth, payload });
    const repeat = await app.inject({ method: "POST", url: `/api/media/${item.id}/report`, ...other.auth, payload });
    const byAdmin = await app.inject({ method: "POST", url: `/api/media/${item.id}/report`, ...admin.auth, payload: { reason: "other" } });

    expect(first.statusCode).toBe(204);
    expect(repeat.statusCode).toBe(409);
    expect(repeat.json()).toMatchObject({ error: { code: "CONFLICT" } });
    expect(byAdmin.statusCode).toBe(204);
    const reports = await getTestDb().select().from(mediaReports).where(eq(mediaReports.mediaId, item.id));
    expect(reports).toHaveLength(2);
    expect(reports.find((report) => report.reporterUserId === other.user.id)?.details).toBe("Sale mi dirección");
    const audits = await auditFor("media.reported", item.id);
    expect(audits).toHaveLength(2);
    expect(JSON.stringify(audits.map((audit) => audit.metadata))).not.toContain("dirección");
  });

  it("answers 403 for your own item, 404 for an invisible one, 400 for a bad reason and 401 without a token", async () => {
    const mine = await insertMedia({ cuencadaId, uploadedByUserId: owner.user.id });
    const invisible = await insertMedia({ cuencadaId, uploadedByUserId: owner.user.id, moderationStatus: "hidden" });

    const own = await app.inject({ method: "POST", url: `/api/media/${mine.id}/report`, ...owner.auth, payload: { reason: "other" } });
    const notVisible = await app.inject({ method: "POST", url: `/api/media/${invisible.id}/report`, ...other.auth, payload: { reason: "other" } });
    const badReason = await app.inject({ method: "POST", url: `/api/media/${mine.id}/report`, ...other.auth, payload: { reason: "spam" } });
    const anonymous = await app.inject({ method: "POST", url: `/api/media/${mine.id}/report`, payload: { reason: "other" } });

    expect(own.statusCode).toBe(403);
    expect(notVisible.statusCode).toBe(404);
    expect(badReason.statusCode).toBe(400);
    expect(anonymous.statusCode).toBe(401);
  });
});
