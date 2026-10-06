import argon2 from "argon2";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getTestDb } from "../test/helpers/db.js";
import {
  chatRooms,
  cuencadaItineraryItems,
  cuencadaLocations,
  cuencadas,
  dailyMessages,
  profiles,
  users
} from "./db/schema/index.js";
import { DEFAULT_DAILY_MESSAGES_FILE, resolveSeedOptions, runSeed, SeedConfigError } from "./seed.js";

const options = {
  adminEmail: "admin@cuencada.com",
  adminTempPassword: "temporal-segura-para-pruebas",
  dailyMessagesFile: DEFAULT_DAILY_MESSAGES_FILE
};

async function counts(): Promise<Record<string, number>> {
  const db = getTestDb();
  return {
    users: await db.$count(users),
    profiles: await db.$count(profiles),
    cuencadas: await db.$count(cuencadas),
    locations: await db.$count(cuencadaLocations),
    itinerary: await db.$count(cuencadaItineraryItems),
    dailyMessages: await db.$count(dailyMessages),
    chatRooms: await db.$count(chatRooms)
  };
}

describe("runSeed", () => {
  it("creates the admin, the 2026 Cuencada, daily messages and the global room, and is idempotent", async () => {
    const db = getTestDb();

    const first = await runSeed(db, options);
    expect(first).toEqual({
      adminCreated: true,
      profileCreated: true,
      cuencadaCreated: true,
      locationsCreated: 6,
      itineraryCreated: 6,
      dailyMessagesCreated: 10,
      chatRoomCreated: true
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
      dailyMessagesCreated: 0,
      chatRoomCreated: false
    });
    expect(await counts()).toEqual(afterFirst);
    expect(afterFirst).toEqual({
      users: 1,
      profiles: 1,
      cuencadas: 1,
      locations: 6,
      itinerary: 6,
      dailyMessages: 10,
      chatRooms: 1
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
      whatsappUrl: "https://chat.whatsapp.com/IvI6oayIIoEJ8Wn7EWQxO0?s=cl&p=i&mlu=0",
      weatherWidgetUrl: "https://forecast7.com/es/20d97n89d59/merida/",
      externalAlbumUrl: "https://1drv.ms/f/c/b0c7d5955d4a8581/IgAC5vDMrmIvTJwWwOjkJJM7AT3DxtBo9OFj8FSXJI_GQY0?e=ASBPLY",
      isPublished: true
    });

    const locations = await db.select().from(cuencadaLocations).orderBy(cuencadaLocations.sortOrder);
    expect(locations.map((location) => location.name)).toEqual([
      "Hotel Chariot Mérida",
      "Hotel El Conquistador",
      "Cenote Santa Bárbara",
      "Izamal",
      "Uxmal",
      "Progreso"
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

    const [message] = await db.select().from(dailyMessages).where(eq(dailyMessages.date, "2026-09-13"));
    expect(message?.message).toContain("CUENCADA 2026");
  });
});

describe("resolveSeedOptions", () => {
  it("refuses to run in production without an admin password", () => {
    expect(() => resolveSeedOptions({ NODE_ENV: "production" })).toThrow(SeedConfigError);
  });

  it("refuses weak or placeholder passwords in production", () => {
    expect(() => resolveSeedOptions({ NODE_ENV: "production", SEED_ADMIN_TEMP_PASSWORD: "short" })).toThrow(
      SeedConfigError
    );
    expect(() => resolveSeedOptions({ NODE_ENV: "production", SEED_ADMIN_TEMP_PASSWORD: "Password123!" })).toThrow(
      SeedConfigError
    );
  });

  it("accepts a strong password in production and normalizes the email", () => {
    const resolved = resolveSeedOptions({
      NODE_ENV: "production",
      SEED_ADMIN_EMAIL: " Admin@Cuencada.com ",
      SEED_ADMIN_TEMP_PASSWORD: "una-frase-larga-y-segura"
    });
    expect(resolved.adminEmail).toBe("admin@cuencada.com");
    expect(resolved.adminTempPassword).toBe("una-frase-larga-y-segura");
  });

  it("falls back to a development password outside production", () => {
    expect(resolveSeedOptions({ NODE_ENV: "development" }).adminTempPassword).toBe("Password123!");
  });
});
