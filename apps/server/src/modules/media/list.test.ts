import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import { FAKE_STORAGE_BASE_URL } from "../../../test/helpers/fakes.js";
import { createCuencada, createMember, insertMedia, type Member } from "../../../test/helpers/media.js";
import type { App } from "../../app.js";
import { VIEW_URL_SECONDS } from "./constants.js";

interface ListBody {
  items: Array<Record<string, unknown> & { id: string }>;
  nextCursor: string | null;
}

let app: App;
let cuencadaId: string;
let owner: Member;
let other: Member;

beforeEach(async () => {
  app = await createTestApp();
  cuencadaId = (await createCuencada()).id;
  owner = await createMember({ displayName: "Abraham" });
  other = await createMember({ displayName: "Prima" });
});

afterEach(async () => {
  await app.close();
});

async function list(member: Member, query = ""): Promise<ListBody> {
  const response = await app.inject({ method: "GET", url: `/api/cuencadas/2026/media${query}`, ...member.auth });
  expect(response.statusCode).toBe(200);
  return response.json<ListBody>();
}

describe("GET /api/cuencadas/:year/media", () => {
  it("lists approved ready items plus only the caller's own non-ready items", async () => {
    const uploader = { uploadedByUserId: owner.user.id, cuencadaId };
    const ready = await insertMedia({ ...uploader, caption: "Lista" });
    const processing = await insertMedia({ ...uploader, uploadStatus: "processing", thumbKey: null, displayKey: null });
    const failed = await insertMedia({ ...uploader, uploadStatus: "failed" });
    const review = await insertMedia({ ...uploader, moderationStatus: "pending_review" });
    const pending = await insertMedia({ ...uploader, uploadStatus: "pending_upload" });
    const hidden = await insertMedia({ ...uploader, moderationStatus: "hidden" });
    const deleted = await insertMedia({ ...uploader, deletedAt: new Date() });

    const mine = await list(owner);
    const theirs = await list(other);

    expect(mine.items.map((item) => item.id).sort()).toEqual([ready.id, processing.id, failed.id, review.id].sort());
    expect(theirs.items.map((item) => item.id)).toEqual([ready.id]);
    for (const absent of [pending.id, hidden.id, deleted.id]) {
      expect(mine.items.map((item) => item.id)).not.toContain(absent);
    }
    const ownProcessing = mine.items.find((item) => item.id === processing.id);
    expect(ownProcessing).toMatchObject({ uploadStatus: "processing", thumbUrl: null, displayUrl: null, isMine: true });
  });

  it("returns presigned 1 h URLs and server-computed flags, never keys or bucket names", async () => {
    const item = await insertMedia({ uploadedByUserId: owner.user.id, cuencadaId, caption: "Playa" });
    const videoId = randomUUID();
    const videoKey = `cuencadas/2026/originals/${videoId}.mp4`;
    const video = await insertMedia({
      id: videoId,
      uploadedByUserId: owner.user.id,
      cuencadaId,
      kind: "video",
      mimeType: "video/mp4",
      objectKey: videoKey,
      thumbKey: null,
      displayKey: videoKey, // videos display their original
      width: null,
      height: null,
      durationSeconds: 12
    });
    const admin = await createMember({ role: "admin" });

    const asOther = await list(other);
    const asAdmin = await list(admin);

    const image = asOther.items.find((entry) => entry.id === item.id);
    expect(image).toMatchObject({
      year: 2026,
      kind: "image",
      caption: "Playa",
      uploaderName: "Abraham",
      width: 1600,
      height: 1200,
      isMine: false,
      canEdit: false,
      canDelete: false,
      uploadStatus: "ready",
      moderationStatus: "approved"
    });
    const thumbUrl = new URL(String(image?.thumbUrl));
    expect(thumbUrl.origin).toBe(FAKE_STORAGE_BASE_URL);
    expect(thumbUrl.searchParams.get("X-Fake-Signature")).toBe("get");
    const expires = Number(thumbUrl.searchParams.get("X-Fake-Expires"));
    expect(expires - Date.now()).toBeGreaterThan((VIEW_URL_SECONDS - 60) * 1000);
    expect(expires - Date.now()).toBeLessThanOrEqual(VIEW_URL_SECONDS * 1000);
    expect(decodeURIComponent(thumbUrl.pathname)).toContain("/thumbs/");
    expect(decodeURIComponent(new URL(String(image?.displayUrl)).pathname)).toContain("/display/");

    const clip = asOther.items.find((entry) => entry.id === video.id);
    expect(clip).toMatchObject({ kind: "video", thumbUrl: null, durationSeconds: 12 });
    expect(decodeURIComponent(new URL(String(clip?.displayUrl)).pathname)).toContain("/originals/");

    expect(asAdmin.items.find((entry) => entry.id === item.id)).toMatchObject({ isMine: false, canEdit: true, canDelete: true });
    expect((await list(owner)).items.find((entry) => entry.id === item.id)).toMatchObject({ isMine: true, canEdit: true });

    const serialized = JSON.stringify(asOther);
    for (const field of ["objectKey", "thumbKey", "displayKey", "bucket", "test-bucket", "fileName", "processingError"]) {
      expect(serialized).not.toContain(field);
    }
  });

  it("paginates newest first with a stable keyset, including identical timestamps", async () => {
    const sameInstant = new Date("2026-10-01T12:00:00.123456Z");
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      ids.push((await insertMedia({ cuencadaId, createdAt: sameInstant })).id);
    }
    const newest = await insertMedia({ cuencadaId, createdAt: new Date("2026-10-02T00:00:00Z") });
    const oldest = await insertMedia({ cuencadaId, createdAt: new Date("2026-09-01T00:00:00Z") });
    const tied = [...ids].sort().reverse();

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: ListBody = await list(other, `?limit=3${cursor === null ? "" : `&cursor=${cursor}`}`);
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);

    expect(pages).toBe(3);
    expect(seen).toEqual([newest.id, ...tied, oldest.id]);
  });

  it("filters by kind", async () => {
    await insertMedia({ cuencadaId });
    const video = await insertMedia({ cuencadaId, kind: "video", mimeType: "video/mp4", thumbKey: null });

    const page = await list(other, "?kind=video");

    expect(page.items.map((item) => item.id)).toEqual([video.id]);
  });

  it("answers 400 for a forged cursor or bad limit, 401 without a token, 404 for drafts", async () => {
    await createCuencada({ year: 2027, isPublished: false });

    const forged = await app.inject({ method: "GET", url: "/api/cuencadas/2026/media?cursor=Zm9v", ...other.auth });
    const badLimit = await app.inject({ method: "GET", url: "/api/cuencadas/2026/media?limit=1000", ...other.auth });
    const anonymous = await app.inject({ method: "GET", url: "/api/cuencadas/2026/media" });
    const draft = await app.inject({ method: "GET", url: "/api/cuencadas/2027/media", ...other.auth });

    expect(forged.statusCode).toBe(400);
    expect(badLimit.statusCode).toBe(400);
    expect(anonymous.statusCode).toBe(401);
    expect(draft.statusCode).toBe(404);
  });
});

describe("GET /api/media/:id", () => {
  it("returns a visible item and 404 for another member's non-ready item", async () => {
    const ready = await insertMedia({ cuencadaId, uploadedByUserId: owner.user.id });
    const processing = await insertMedia({ cuencadaId, uploadedByUserId: owner.user.id, uploadStatus: "processing" });
    const admin = await createMember({ role: "admin" });

    const visible = await app.inject({ method: "GET", url: `/api/media/${ready.id}`, ...other.auth });
    const hiddenFromOther = await app.inject({ method: "GET", url: `/api/media/${processing.id}`, ...other.auth });
    const ownProcessing = await app.inject({ method: "GET", url: `/api/media/${processing.id}`, ...owner.auth });
    const asAdmin = await app.inject({ method: "GET", url: `/api/media/${processing.id}`, ...admin.auth });
    const anonymous = await app.inject({ method: "GET", url: `/api/media/${ready.id}` });
    const malformed = await app.inject({ method: "GET", url: "/api/media/123", ...other.auth });

    expect(visible.statusCode).toBe(200);
    expect(visible.json()).toMatchObject({ id: ready.id, isMine: false });
    expect(hiddenFromOther.statusCode).toBe(404);
    expect(ownProcessing.statusCode).toBe(200);
    expect(asAdmin.statusCode).toBe(200);
    expect(anonymous.statusCode).toBe(401);
    expect(malformed.statusCode).toBe(400);
  });
});
