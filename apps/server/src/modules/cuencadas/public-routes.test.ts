import type { CuencadaHome, CuencadaSummary, MemberCuencadaDetails, PublicCuencada } from "@cuencada/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import {
  insertAnnouncement,
  insertCuencada,
  insertDailyMessage,
  insertItineraryItem,
  insertLocation,
  insertMedia,
  type MutableClock,
  mutableClock
} from "../../../test/helpers/cuencadas.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { createUser, loginAs } from "../../../test/helpers/factories.js";
import type { App } from "../../app.js";
import { LEGACY_DEV_LINKS } from "../../seed-data.js";
import { DEFAULT_DAILY_MESSAGES_FILE, runSeed } from "../../seed.js";

const MEMBER_ONLY_KEYS = ["whatsappUrl", "externalAlbumUrl", "isPublished", "createdAt", "updatedAt"];

let app: App;
let clock: MutableClock;

beforeEach(async () => {
  // Default: 2026-09-01 noon in Mérida (2026 edition upcoming).
  clock = mutableClock("2026-09-01T18:00:00Z");
  app = await createTestApp({ clock });
});

afterEach(async () => {
  await app.close();
});

describe("GET /api/cuencadas/:year", () => {
  it("returns only public items, public live announcements and no member-only fields", async () => {
    const edition = await insertCuencada();
    const hotel = await insertLocation(edition.id, { name: "Hotel público", sortOrder: 1 });
    await insertLocation(edition.id, { name: "Casa privada", visibility: "members", sortOrder: 0 });
    await insertItineraryItem(edition.id, { title: "Llegada", startTime: "19:30", locationId: hotel.id });
    await insertItineraryItem(edition.id, { title: "Cena secreta", visibility: "members" });
    await insertAnnouncement({ cuencadaId: edition.id, title: "Aviso público" });
    await insertAnnouncement({ cuencadaId: edition.id, title: "Aviso de miembros", visibility: "members" });
    await insertAnnouncement({ cuencadaId: edition.id, title: "Aviso programado", publishAt: new Date("2026-12-01T00:00:00Z") });
    await insertAnnouncement({
      cuencadaId: edition.id,
      title: "Aviso vencido",
      publishAt: new Date("2026-01-01T00:00:00Z"),
      expiresAt: new Date("2026-02-01T00:00:00Z")
    });

    const response = await app.inject({ method: "GET", url: "/api/cuencadas/2026" });

    expect(response.statusCode).toBe(200);
    const body = response.json<PublicCuencada>();
    for (const key of MEMBER_ONLY_KEYS) expect(body).not.toHaveProperty(key);
    expect(response.body).not.toContain("SECRETO");
    expect(response.body).not.toContain("album-secreto");
    expect(body.status).toBe("upcoming");
    expect(body.timezone).toBe("America/Merida");
    expect(body.publicItinerary.map((item) => item.title)).toEqual(["Llegada"]);
    expect(body.publicItinerary[0]).toMatchObject({ startTime: "19:30", endTime: null, locationId: hotel.id });
    expect(body.publicLocations.map((location) => location.name)).toEqual(["Hotel público"]);
    expect(body.publicAnnouncements.map((announcement) => announcement.title)).toEqual(["Aviso público"]);
  });

  it("answers 404 for drafts and unknown years, and 400 for a malformed year", async () => {
    await insertCuencada({ year: 2027, isPublished: false });

    const draft = await app.inject({ method: "GET", url: "/api/cuencadas/2027" });
    const missing = await app.inject({ method: "GET", url: "/api/cuencadas/2030" });
    const invalid = await app.inject({ method: "GET", url: "/api/cuencadas/20x6" });

    expect(draft.statusCode).toBe(404);
    expect(draft.json<{ error: { code: string } }>().error.code).toBe("NOT_FOUND");
    expect(missing.statusCode).toBe(404);
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json<{ error: { code: string } }>().error.code).toBe("VALIDATION");
  });

  it("picks today's message in the edition's timezone, not UTC", async () => {
    const edition = await insertCuencada();
    await insertDailyMessage(edition.id, "2026-09-12", "Mañana es el gran día");
    await insertDailyMessage(edition.id, "2026-09-13", "Hoy comienza");

    // 05:30 UTC on the 13th is still 23:30 on the 12th in Mérida.
    clock.set("2026-09-13T05:30:00Z");
    const evening = await app.inject({ method: "GET", url: "/api/cuencadas/2026" });
    clock.set("2026-09-13T06:00:00Z");
    const midnight = await app.inject({ method: "GET", url: "/api/cuencadas/2026" });
    clock.set("2026-09-20T12:00:00Z");
    const none = await app.inject({ method: "GET", url: "/api/cuencadas/2026" });

    expect(evening.json<PublicCuencada>().todayMessage?.message).toBe("Mañana es el gran día");
    expect(evening.json<PublicCuencada>().status).toBe("upcoming");
    expect(midnight.json<PublicCuencada>().todayMessage?.message).toBe("Hoy comienza");
    expect(midnight.json<PublicCuencada>().status).toBe("active");
    expect(none.json<PublicCuencada>().todayMessage).toBeNull();
    expect(none.json<PublicCuencada>().status).toBe("past");
  });
});

describe("GET /api/cuencadas", () => {
  it("lists published editions newest first with timezone and hasMedia, without drafts", async () => {
    const withMedia = await insertCuencada({ year: 2024 });
    const hiddenOnly = await insertCuencada({ year: 2025 });
    await insertCuencada({ year: 2026 });
    const draft = await insertCuencada({ year: 2027, isPublished: false });
    await insertMedia(withMedia.id);
    await insertMedia(hiddenOnly.id, { moderationStatus: "hidden" });
    await insertMedia(hiddenOnly.id, { uploadStatus: "processing" });
    await insertMedia(hiddenOnly.id, { deletedAt: new Date() });
    await insertMedia(draft.id);

    const response = await app.inject({ method: "GET", url: "/api/cuencadas" });

    expect(response.statusCode).toBe(200);
    const body = response.json<CuencadaSummary[]>();
    expect(body.map((summary) => [summary.year, summary.status, summary.hasMedia])).toEqual([
      [2026, "upcoming", false],
      [2025, "past", false],
      [2024, "past", true]
    ]);
    expect(body[0]?.timezone).toBe("America/Merida");
    for (const summary of body) for (const key of MEMBER_ONLY_KEYS) expect(summary).not.toHaveProperty(key);
  });
});

describe("GET /api/cuencadas/home", () => {
  it("features the upcoming edition and returns the latest past one and portal-wide public announcements", async () => {
    await insertCuencada({ year: 2024 });
    await insertCuencada({ year: 2025 });
    const upcoming = await insertCuencada({ year: 2026 });
    await insertCuencada({ year: 2027, isPublished: false });
    await insertDailyMessage(upcoming.id, "2026-09-01", "Faltan doce días");
    await insertAnnouncement({ cuencadaId: null, title: "General público", pinned: true });
    await insertAnnouncement({ cuencadaId: null, title: "General de miembros", visibility: "members" });
    await insertAnnouncement({ cuencadaId: upcoming.id, title: "De la edición" });

    const response = await app.inject({ method: "GET", url: "/api/cuencadas/home" });

    expect(response.statusCode).toBe(200);
    const body = response.json<CuencadaHome>();
    expect(body.mode).toBe("upcoming");
    expect(body.featured?.year).toBe(2026);
    expect(body.featured?.todayMessage?.message).toBe("Faltan doce días");
    expect(body.featured?.publicAnnouncements.map((a) => a.title)).toEqual(["De la edición"]);
    expect(body.featured).not.toHaveProperty("whatsappUrl");
    expect(body.latestPast?.year).toBe(2025);
    expect(body.announcements.map((a) => a.title)).toEqual(["General público"]);
    expect(response.body).not.toContain("SECRETO");
  });

  it("switches to active during the edition and to memories after it", async () => {
    await insertCuencada({ year: 2026 });

    clock.set("2026-09-15T12:00:00Z");
    const during = (await app.inject({ method: "GET", url: "/api/cuencadas/home" })).json<CuencadaHome>();
    clock.set("2026-10-01T12:00:00Z");
    const after = (await app.inject({ method: "GET", url: "/api/cuencadas/home" })).json<CuencadaHome>();

    expect(during.mode).toBe("active");
    expect(during.featured?.status).toBe("active");
    expect(after.mode).toBe("memories");
    expect(after.featured).toBeNull();
    expect(after.latestPast?.year).toBe(2026);
  });

  it("answers an empty memories home when nothing is published", async () => {
    await insertCuencada({ year: 2026, isPublished: false });

    const response = await app.inject({ method: "GET", url: "/api/cuencadas/home" });

    expect(response.json()).toEqual({ mode: "memories", featured: null, latestPast: null, announcements: [] });
  });
});

describe("GET /api/cuencadas/:year/members", () => {
  it("returns member-only links, every item and the seeded pinned link announcements", async () => {
    await runSeed(getTestDb(), {
      adminEmail: "admin@cuencada.com",
      adminTempPassword: "temporal-segura-para-pruebas",
      dailyMessagesFile: DEFAULT_DAILY_MESSAGES_FILE,
      links: { ...LEGACY_DEV_LINKS }
    });
    const member = await createUser();
    // Seeded announcements publish at the DB's real now(); read after it.
    clock.set(new Date(Date.now() + 60_000).toISOString());

    const publicView = await app.inject({ method: "GET", url: "/api/cuencadas/2026" });
    const response = await app.inject({ method: "GET", url: "/api/cuencadas/2026/members", ...(await loginAs(app, member)) });

    expect(response.statusCode).toBe(200);
    const body = response.json<MemberCuencadaDetails>();
    expect(body.year).toBe(2026);
    expect(body.whatsappUrl).toBe(LEGACY_DEV_LINKS.whatsappUrl);
    expect(body.externalAlbumUrl).toBe(LEGACY_DEV_LINKS.externalAlbumUrl);
    expect(body.itinerary).toHaveLength(6);
    expect(body.locations).toHaveLength(6);
    const pinned = body.announcements.filter((a) => a.pinned && a.visibility === "members");
    expect(pinned).toHaveLength(2);
    // The same announcements never reach the anonymous view.
    expect(publicView.json<PublicCuencada>().publicAnnouncements).toEqual([]);
    expect(publicView.body).not.toContain(String(LEGACY_DEV_LINKS.whatsappUrl));
  });

  it("includes members-only items and announcements", async () => {
    const edition = await insertCuencada();
    await insertItineraryItem(edition.id, { title: "Cena secreta", visibility: "members" });
    await insertLocation(edition.id, { name: "Casa privada", visibility: "members" });
    await insertAnnouncement({ cuencadaId: edition.id, title: "Aviso de miembros", visibility: "members" });
    const member = await createUser();

    const response = await app.inject({ method: "GET", url: "/api/cuencadas/2026/members", ...(await loginAs(app, member)) });

    const body = response.json<MemberCuencadaDetails>();
    expect(body.itinerary.map((item) => item.title)).toEqual(["Cena secreta"]);
    expect(body.locations.map((location) => location.name)).toEqual(["Casa privada"]);
    expect(body.announcements.map((a) => a.title)).toEqual(["Aviso de miembros"]);
    expect(body.whatsappUrl).toBe("https://chat.whatsapp.com/SECRETO");
  });

  it("answers 401 without a token, 403 before the password change, 404 for drafts and 400 for a bad year", async () => {
    await insertCuencada({ year: 2027, isPublished: false });
    const member = await createUser();
    const pending = await createUser({ mustChangePassword: true });
    const auth = await loginAs(app, member);

    const anonymous = await app.inject({ method: "GET", url: "/api/cuencadas/2026/members" });
    const mustChange = await app.inject({ method: "GET", url: "/api/cuencadas/2027/members", ...(await loginAs(app, pending)) });
    const draft = await app.inject({ method: "GET", url: "/api/cuencadas/2027/members", ...auth });
    const invalid = await app.inject({ method: "GET", url: "/api/cuencadas/nope/members", ...auth });

    expect(anonymous.statusCode).toBe(401);
    expect(mustChange.statusCode).toBe(403);
    expect(draft.statusCode).toBe(404);
    expect(invalid.statusCode).toBe(400);
  });
});
