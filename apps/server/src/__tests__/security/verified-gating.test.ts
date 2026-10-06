/**
 * WP-2.3 L2 (MEDIUM, A01) regression: owner decision on 2026-10-06.
 *
 * Photos and uploader names reveal who belongs to the family, as the attendees
 * list does. Member edition details carry the WhatsApp group and album links.
 * So the gallery, every media route and `/cuencadas/:year/members` require a
 * verified email: an unverified member gets 403 `EMAIL_UNVERIFIED` and no data.
 * Announcements and the RSVP summary (counts only) stay open to unverified
 * members.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../../app.js";
import { createTestApp } from "../../../test/helpers/app.js";
import { insertAnnouncement, insertCuencada } from "../../../test/helpers/cuencadas.js";
import { type AuthInjectOptions, bearerFor, createSession, createUser } from "../../../test/helpers/factories.js";
import { insertMedia } from "../../../test/helpers/media.js";

const YEAR = 2099;
let app: App;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

async function authFor(emailVerified: boolean): Promise<{ id: string; auth: AuthInjectOptions }> {
  const user = await createUser({ emailVerified });
  return { id: user.id, auth: await bearerFor(user, await createSession(user.id)) };
}

describe("verified-email gating of the gallery and member edition links", () => {
  it("answers 403 EMAIL_UNVERIFIED on every media route and on the member edition details, and leaks nothing", async () => {
    const edition = await insertCuencada({ year: YEAR });
    const unverified = await authFor(false);
    // The unverified member even owns this item: ownership does not bypass the gate.
    const own = await insertMedia({ cuencadaId: edition.id, uploadedByUserId: unverified.id, caption: "Leyenda privada" });
    const requests = [
      { method: "GET" as const, url: `/api/cuencadas/${YEAR}/media` },
      { method: "GET" as const, url: `/api/media/${own.id}` },
      { method: "PATCH" as const, url: `/api/media/${own.id}`, payload: { caption: "x" } },
      { method: "DELETE" as const, url: `/api/media/${own.id}` },
      { method: "POST" as const, url: `/api/media/${own.id}/report`, payload: { reason: "other" } },
      { method: "POST" as const, url: `/api/media/${own.id}/confirm` },
      {
        method: "POST" as const,
        url: `/api/cuencadas/${YEAR}/media/uploads`,
        payload: { fileName: "foto.png", mimeType: "image/png", byteSize: 1000 }
      },
      { method: "GET" as const, url: `/api/cuencadas/${YEAR}/members` }
    ];
    for (const request of requests) {
      const response = await app.inject({ ...request, ...unverified.auth });
      expect({ url: `${request.method} ${request.url}`, status: response.statusCode, code: response.json<{ error?: { code: string } }>().error?.code }).toEqual({
        url: `${request.method} ${request.url}`,
        status: 403,
        code: "EMAIL_UNVERIFIED"
      });
      expect(response.body).not.toMatch(/Leyenda privada|whatsapp|onedrive|thumbUrl/i);
    }
  });

  it("serves the same routes to a verified member (control)", async () => {
    const edition = await insertCuencada({ year: YEAR });
    const verified = await authFor(true);
    const item = await insertMedia({ cuencadaId: edition.id });
    for (const url of [`/api/cuencadas/${YEAR}/media`, `/api/media/${item.id}`, `/api/cuencadas/${YEAR}/members`]) {
      const response = await app.inject({ method: "GET", url, ...verified.auth });
      expect({ url, status: response.statusCode }).toEqual({ url, status: 200 });
    }
  });

  it("keeps announcements and the RSVP summary open to unverified members", async () => {
    await insertCuencada({ year: YEAR });
    await insertAnnouncement({ visibility: "members" });
    const unverified = await authFor(false);
    for (const url of ["/api/announcements", `/api/cuencadas/${YEAR}/rsvp/summary`]) {
      const response = await app.inject({ method: "GET", url, ...unverified.auth });
      expect({ url, status: response.statusCode }).toEqual({ url, status: 200 });
    }
  });
});
