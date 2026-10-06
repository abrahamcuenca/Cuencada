import argon2 from "argon2";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getTestDb } from "../test/helpers/db.js";
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
import { LEGACY_DEV_LINKS } from "./seed-data.js";
import {
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
  links: { ...LEGACY_DEV_LINKS }
};

const STRONG = "una-frase-temporal-larga-y-segura";

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

  it("ports the legacy 2026 content", async () => {
    const db = getTestDb();
    await runSeed(db, options);

    const [edition] = await db.select().from(cuencadas).where(eq(cuencadas.year, 2026));
    expect(edition).toMatchObject({
      slug: "2026",
      timezone: "America/Merida",
      songUrl: "/canciones/Cancion_Oficial.mp3",
      heroImageUrl: "/images/Logo_Cuencada2026.jpg",
      whatsappUrl: "https://chat.whatsapp.com/IvI6oayIIoEJ8Wn7EWQxO0?s=cl&p=i&mlu=0",
      weatherWidgetUrl: "https://forecast7.com/es/20d97n89d59/merida/",
      externalAlbumUrl: "https://1drv.ms/f/c/b0c7d5955d4a8581/IgAC5vDMrmIvTJwWwOjkJJM7AT3DxtBo9OFj8FSXJI_GQY0?e=ASBPLY",
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
    expect(links[0]?.body).toContain(LEGACY_DEV_LINKS.lyricsUrl);
    expect(links[1]?.body).toContain(LEGACY_DEV_LINKS.programUrl);

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
    expect(resolveSeedOptions({ NODE_ENV: "staging", SEED_ADMIN_TEMP_PASSWORD: "frase-de-16-cars" }).adminTempPassword).toBe(
      "frase-de-16-cars"
    );
  });

  it("accepts a strong password in production, normalizes the email and seeds no links by default", () => {
    const resolved = resolveSeedOptions({
      NODE_ENV: "production",
      SEED_ADMIN_EMAIL: " Admin@Cuencada.com ",
      SEED_ADMIN_TEMP_PASSWORD: STRONG
    });
    expect(resolved.adminEmail).toBe("admin@cuencada.com");
    expect(resolved.adminTempPassword).toBe(STRONG);
    expect(resolved.links).toEqual({ whatsappUrl: null, externalAlbumUrl: null, lyricsUrl: null, programUrl: null });
  });

  it("reads links from SEED_*_URL and rejects non-https values", () => {
    const resolved = resolveSeedOptions({
      NODE_ENV: "production",
      SEED_ADMIN_TEMP_PASSWORD: STRONG,
      SEED_WHATSAPP_URL: "https://chat.whatsapp.com/nuevo",
      SEED_PROGRAM_URL: "https://example.com/programa"
    });
    expect(resolved.links).toEqual({
      whatsappUrl: "https://chat.whatsapp.com/nuevo",
      externalAlbumUrl: null,
      lyricsUrl: null,
      programUrl: "https://example.com/programa"
    });
    expect(() =>
      resolveSeedOptions({ NODE_ENV: "production", SEED_ADMIN_TEMP_PASSWORD: STRONG, SEED_LYRICS_URL: "http://x.example.com" })
    ).toThrow(SeedConfigError);
  });

  it("falls back to the development password and legacy links only in development and test", () => {
    const dev = resolveSeedOptions({ NODE_ENV: "development" });
    expect(dev.adminTempPassword).toBe("Password123!");
    expect(dev.links).toEqual(LEGACY_DEV_LINKS);
    expect(resolveSeedOptions({ NODE_ENV: "test" }).adminTempPassword).toBe("Password123!");
  });
});
