import argon2 from "argon2";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { fakeRange } from "../test/helpers/breach.js";
import { getTestDb } from "../test/helpers/db.js";
import { createBreachedPasswordChecker } from "./lib/breachedPasswords.js";
import {
  announcements,
  chatRooms,
  cuencadaItineraryItems,
  cuencadaLocations,
  cuencadas,
  dailyMessages,
  profiles,
  users
} from "./db/schema/index.js";
import { DEV_PLACEHOLDER_LINKS } from "./seed-data.js";
import {
  assertSeedPasswordNotBreached,
  DEFAULT_DAILY_MESSAGES_FILE,
  resolveSeedOptions,
  runSeed,
  SEED_PASSWORD_MIN_LENGTH,
  SeedConfigError,
  type SeedOptions
} from "./seed.js";

const options: SeedOptions = {
  adminEmail: "admin@cuencada.com",
  adminTempPassword: "temporal-segura-para-pruebas",
  dailyMessagesFile: DEFAULT_DAILY_MESSAGES_FILE,
  links: { ...DEV_PLACEHOLDER_LINKS }
};

const STRONG = "una-frase-temporal-larga-y-segura";

/** Every member-only link, as production must pass them (fictional values). */
const ALL_LINKS = {
  SEED_WHATSAPP_URL: "https://chat.example.com/grupo-nuevo",
  SEED_EXTERNAL_ALBUM_URL: "https://album.example.com/nuevo",
  SEED_LYRICS_URL: "https://docs.example.com/letra",
  SEED_PROGRAM_URL: "https://docs.example.com/programa"
};

async function counts(): Promise<Record<string, number>> {
  const db = getTestDb();
  return {
    users: await db.$count(users),
    profiles: await db.$count(profiles),
    cuencadas: await db.$count(cuencadas),
    locations: await db.$count(cuencadaLocations),
    itinerary: await db.$count(cuencadaItineraryItems),
    announcements: await db.$count(announcements),
    dailyMessages: await db.$count(dailyMessages),
    chatRooms: await db.$count(chatRooms)
  };
}

describe("runSeed", () => {
  it("creates the admin, the 2026 Cuencada, daily messages and both chat rooms, and is idempotent", async () => {
    const db = getTestDb();

    const first = await runSeed(db, options);
    expect(first).toEqual({
      adminCreated: true,
      profileCreated: true,
      cuencadaCreated: true,
      locationsCreated: 6,
      itineraryCreated: 6,
      announcementsCreated: 2,
      dailyMessagesCreated: 10,
      chatRoomsCreated: 2
    });
    const afterFirst = await counts();

    const [adminBefore] = await db.select().from(users);
    const second = await runSeed(db, { ...options, adminTempPassword: "otra-contrasena-distinta" });
    expect(second).toEqual({
      adminCreated: false,
      profileCreated: false,
      cuencadaCreated: false,
      locationsCreated: 0,
      itineraryCreated: 0,
      announcementsCreated: 0,
      dailyMessagesCreated: 0,
      chatRoomsCreated: 0
    });
    expect(await counts()).toEqual(afterFirst);
    expect(afterFirst).toEqual({
      users: 1,
      profiles: 1,
      cuencadas: 1,
      locations: 6,
      itinerary: 6,
      announcements: 2,
      dailyMessages: 10,
      chatRooms: 2
    });

    // The admin keeps the original temporary password and must change it.
    const [admin] = await db.select().from(users);
    expect(admin?.passwordHash).toBe(adminBefore?.passwordHash);
    expect(admin?.role).toBe("admin");
    expect(admin?.mustChangePassword).toBe(true);
    expect(await argon2.verify(admin?.passwordHash ?? "", options.adminTempPassword)).toBe(true);
  });

  it("stamps first_published_at on the published 2026 edition once and keeps it on re-runs", async () => {
    const db = getTestDb();
    const before = Date.now();

    await runSeed(db, options);
    const [seeded] = await db.select().from(cuencadas);
    expect(seeded?.isPublished).toBe(true);
    const stamped = seeded?.firstPublishedAt?.getTime();
    expect(stamped).toBeGreaterThanOrEqual(before - 1000);
    expect(stamped).toBeLessThanOrEqual(Date.now() + 1000);

    await runSeed(db, options);
    const [again] = await db.select().from(cuencadas);
    expect(again?.firstPublishedAt?.getTime()).toBe(stamped);
  });

  it("ports the legacy 2026 content", async () => {
    const db = getTestDb();
    await runSeed(db, options);

    const [edition] = await db.select().from(cuencadas).where(eq(cuencadas.year, 2026));
    expect(edition).toMatchObject({
      slug: "2026",
      timezone: "America/Merida",
      songUrl: "/canciones/Cancion_Oficial.mp3",
      heroImageUrl: "/images/Logo_Cuencada2026.jpg",
      whatsappUrl: DEV_PLACEHOLDER_LINKS.whatsappUrl,
      weatherWidgetUrl: "https://forecast7.com/es/20d97n89d59/merida/",
      externalAlbumUrl: DEV_PLACEHOLDER_LINKS.externalAlbumUrl,
      isPublished: true
    });
    expect(edition?.firstPublishedAt).toBeInstanceOf(Date);

    const locations = await db.select().from(cuencadaLocations).orderBy(cuencadaLocations.sortOrder);
    expect(locations.map((location) => [location.name, location.url, location.mapsUrl])).toEqual([
      ["Hotel Chariot Mérida", "https://www.hotelchariotmerida.com/", null],
      ["Hotel El Conquistador", "https://www.elconquistador.com.mx/", null],
      [
        "Cenote Santa Bárbara",
        null,
        "https://www.google.com/maps/search/?api=1&query=Cenotes+Santa+Barbara+Homun+Yucatan"
      ],
      ["Izamal", null, "https://www.google.com/maps/search/?api=1&query=Izamal+Yucatan"],
      ["Uxmal", null, "https://www.google.com/maps/search/?api=1&query=Uxmal+Yucatan"],
      ["Progreso", null, "https://www.google.com/maps/search/?api=1&query=Progreso+Yucatan"]
    ]);

    const items = await db.select().from(cuencadaItineraryItems).orderBy(cuencadaItineraryItems.date);
    expect(items.map((item) => item.date)).toEqual([
      "2026-09-13",
      "2026-09-14",
      "2026-09-15",
      "2026-09-16",
      "2026-09-17",
      "2026-09-18"
    ]);
    const day14 = items[1];
    expect(day14).toMatchObject({ startTime: "07:40:00", endTime: "18:00:00", priceNote: "$1,000 p/p" });
    const cenote = locations.find((location) => location.name === "Cenote Santa Bárbara");
    expect(day14?.locationId).toBe(cenote?.id);

    const links = await db.select().from(announcements).orderBy(announcements.title);
    expect(links.map((row) => [row.title, row.visibility, row.pinned, row.cuencadaId])).toEqual([
      ["Letra oficial de la canción", "members", true, edition?.id],
      ["Programa completo", "members", true, edition?.id]
    ]);
    expect(links[0]?.body).toContain(DEV_PLACEHOLDER_LINKS.lyricsUrl);
    expect(links[1]?.body).toContain(DEV_PLACEHOLDER_LINKS.programUrl);

    const rooms = await db.select().from(chatRooms).orderBy(chatRooms.kind);
    expect(rooms.map((room) => [room.kind, room.cuencadaId])).toEqual([
      ["cuencada", edition?.id],
      ["global", null]
    ]);

    const [message] = await db.select().from(dailyMessages).where(eq(dailyMessages.date, "2026-09-13"));
    expect(message?.message).toContain("CUENCADA 2026");
  });

  it("seeds no member-only links when none are configured", async () => {
    const db = getTestDb();
    const none = { whatsappUrl: null, externalAlbumUrl: null, lyricsUrl: null, programUrl: null };
    const result = await runSeed(db, { ...options, links: none });

    expect(result.announcementsCreated).toBe(0);
    const [edition] = await db.select().from(cuencadas);
    expect(edition).toMatchObject({ whatsappUrl: null, externalAlbumUrl: null });
  });
});

describe("resolveSeedOptions", () => {
  it("refuses to run in production without an admin password", () => {
    expect(() => resolveSeedOptions({ NODE_ENV: "production" })).toThrow(SeedConfigError);
  });

  it("refuses when NODE_ENV is unset and the password is missing or weak", () => {
    expect(() => resolveSeedOptions({})).toThrow(SeedConfigError);
    expect(() => resolveSeedOptions({ SEED_ADMIN_TEMP_PASSWORD: "Password123!" })).toThrow(SeedConfigError);
  });

  it("refuses the .env.example placeholders outside development and test", () => {
    for (const placeholder of ["replace-with-vault-value", "change-me-in-vault", "REPLACE-WITH-VAULT-VALUE"]) {
      expect(() => resolveSeedOptions({ NODE_ENV: "production", SEED_ADMIN_TEMP_PASSWORD: placeholder })).toThrow(
        SeedConfigError
      );
      expect(() => resolveSeedOptions({ SEED_ADMIN_TEMP_PASSWORD: placeholder })).toThrow(SeedConfigError);
    }
  });

  it(`refuses passwords shorter than ${SEED_PASSWORD_MIN_LENGTH} characters outside development and test`, () => {
    expect(() => resolveSeedOptions({ NODE_ENV: "staging", SEED_ADMIN_TEMP_PASSWORD: "frase-de-15-car" })).toThrow(
      SeedConfigError
    );
    expect(
      resolveSeedOptions({ NODE_ENV: "staging", SEED_ADMIN_TEMP_PASSWORD: "frase-de-16-cars", ...ALL_LINKS }).adminTempPassword
    ).toBe("frase-de-16-cars");
  });

  it("accepts a strong password in production, normalizes the email and reads every link", () => {
    const resolved = resolveSeedOptions({
      NODE_ENV: "production",
      SEED_ADMIN_EMAIL: " Admin@Cuencada.com ",
      SEED_ADMIN_TEMP_PASSWORD: STRONG,
      ...ALL_LINKS
    });
    expect(resolved.adminEmail).toBe("admin@cuencada.com");
    expect(resolved.adminTempPassword).toBe(STRONG);
    expect(resolved.links).toEqual({
      whatsappUrl: ALL_LINKS.SEED_WHATSAPP_URL,
      externalAlbumUrl: ALL_LINKS.SEED_EXTERNAL_ALBUM_URL,
      lyricsUrl: ALL_LINKS.SEED_LYRICS_URL,
      programUrl: ALL_LINKS.SEED_PROGRAM_URL
    });
  });

  it("refuses in production when any SEED_*_URL is missing, naming only the missing variables", () => {
    const { SEED_LYRICS_URL: _lyrics, SEED_PROGRAM_URL: _program, ...twoLinks } = ALL_LINKS;
    const attempt = () => resolveSeedOptions({ NODE_ENV: "production", SEED_ADMIN_TEMP_PASSWORD: STRONG, ...twoLinks });
    expect(attempt).toThrow(SeedConfigError);
    expect(attempt).toThrow(/SEED_LYRICS_URL, SEED_PROGRAM_URL/);
    expect(attempt).not.toThrow(/SEED_WHATSAPP_URL/);
    expect(attempt).not.toThrow(/example\.com/);
    expect(() => resolveSeedOptions({ NODE_ENV: "production", SEED_ADMIN_TEMP_PASSWORD: STRONG })).toThrow(
      /SEED_WHATSAPP_URL, SEED_EXTERNAL_ALBUM_URL, SEED_LYRICS_URL, SEED_PROGRAM_URL/
    );
  });

  it("seeds only the given links when SEED_ALLOW_MISSING_LINKS=true", () => {
    const resolved = resolveSeedOptions({
      NODE_ENV: "production",
      SEED_ADMIN_TEMP_PASSWORD: STRONG,
      SEED_ALLOW_MISSING_LINKS: "true",
      SEED_PROGRAM_URL: ALL_LINKS.SEED_PROGRAM_URL
    });
    expect(resolved.links).toEqual({
      whatsappUrl: null,
      externalAlbumUrl: null,
      lyricsUrl: null,
      programUrl: ALL_LINKS.SEED_PROGRAM_URL
    });
    expect(() =>
      resolveSeedOptions({ NODE_ENV: "production", SEED_ADMIN_TEMP_PASSWORD: STRONG, SEED_ALLOW_MISSING_LINKS: "1" })
    ).toThrow(SeedConfigError);
  });

  it("refuses a breached admin temporary password in production with a clear seed error", async () => {
    const range = fakeRange([STRONG]);
    const checker = createBreachedPasswordChecker({ enabled: true, minCount: 1, logger: { warn: vi.fn() }, fetcher: range.fetcher });

    await expect(
      assertSeedPasswordNotBreached({ adminTempPassword: STRONG }, { NODE_ENV: "production" }, checker)
    ).rejects.toThrow(/SEED_ADMIN_TEMP_PASSWORD appears in known data breaches/);
    await expect(
      assertSeedPasswordNotBreached({ adminTempPassword: "otra-frase-temporal-larga" }, { NODE_ENV: "production" }, checker)
    ).resolves.toBeUndefined();
  });

  it("skips the seed breach check outside production, when turned off, and fails open when unreachable", async () => {
    const range = fakeRange([STRONG]);
    const checker = createBreachedPasswordChecker({ enabled: true, minCount: 1, logger: { warn: vi.fn() }, fetcher: range.fetcher });
    await assertSeedPasswordNotBreached({ adminTempPassword: STRONG }, { NODE_ENV: "development" }, checker);
    await assertSeedPasswordNotBreached({ adminTempPassword: STRONG }, { NODE_ENV: "production", PASSWORD_BREACH_CHECK: "OFF" }, checker);
    expect(range.urls).toEqual([]);

    const logger = { warn: vi.fn() };
    const offline = createBreachedPasswordChecker({
      enabled: true,
      minCount: 1,
      logger,
      fetcher: fakeRange([STRONG], { networkError: true }).fetcher
    });
    await expect(
      assertSeedPasswordNotBreached({ adminTempPassword: STRONG }, { NODE_ENV: "production" }, offline)
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(STRONG);
  });

  it("rejects non-https links", () => {
    expect(() =>
      resolveSeedOptions({
        NODE_ENV: "production",
        SEED_ADMIN_TEMP_PASSWORD: STRONG,
        ...ALL_LINKS,
        SEED_LYRICS_URL: "http://x.example.com"
      })
    ).toThrow(/SEED_LYRICS_URL must be an https/);
    expect(() => resolveSeedOptions({ NODE_ENV: "development", SEED_WHATSAPP_URL: "javascript:alert(1)" })).toThrow(
      SeedConfigError
    );
  });

  it("falls back to the development password and placeholder links only in development and test", () => {
    const dev = resolveSeedOptions({ NODE_ENV: "development" });
    expect(dev.adminTempPassword).toBe("Password123!");
    expect(dev.links).toEqual(DEV_PLACEHOLDER_LINKS);
    expect(Object.values(DEV_PLACEHOLDER_LINKS).every((url) => url.startsWith("https://example.com/"))).toBe(true);
    const partial = resolveSeedOptions({ NODE_ENV: "test", SEED_WHATSAPP_URL: ALL_LINKS.SEED_WHATSAPP_URL });
    expect(partial.links).toEqual({ ...DEV_PLACEHOLDER_LINKS, whatsappUrl: ALL_LINKS.SEED_WHATSAPP_URL });
    expect(resolveSeedOptions({ NODE_ENV: "test" }).adminTempPassword).toBe("Password123!");
  });
});
