/**
 * Idempotent seed: the initial admin, the 2026 Cuencada (locations,
 * itinerary), its daily messages from `mensajes.txt`, and the global chat room.
 *
 * Re-running it only inserts what is missing. It never overwrites rows that
 * already exist, so content edited by admins and the admin's changed password
 * survive. Run with `node dist/seed.js` (or `pnpm db:seed:dev` from source).
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { emailSchema, parseDailyMessagesText, passwordSchema } from "@cuencada/types";
import argon2 from "argon2";
import { and, eq, sql } from "drizzle-orm";
import { type Database, createDatabase } from "./db/client.js";
import {
  chatRooms,
  cuencadaItineraryItems,
  cuencadaLocations,
  cuencadas,
  dailyMessages,
  profiles,
  users
} from "./db/schema/index.js";
import { cuencada2026, type SeedLocationKey } from "./seed-data.js";

/** Default location of the legacy daily-messages file (repo root). */
export const DEFAULT_DAILY_MESSAGES_FILE = fileURLToPath(new URL("../../../mensajes.txt", import.meta.url));

/** Temporary password used only outside production when none is configured. */
const DEV_FALLBACK_PASSWORD = "Password123!";

/** Well-known or placeholder passwords that are never accepted in production. */
const WEAK_PASSWORDS = new Set(
  [DEV_FALLBACK_PASSWORD, "password1234", "changeme1234", "cuencada2026", "admin1234567", "123456789012"].map((p) =>
    p.toLowerCase()
  )
);

/** Validated seed settings. */
export interface SeedOptions {
  adminEmail: string;
  adminTempPassword: string;
  dailyMessagesFile: string;
}

/** What one seed run inserted (all zeros on a repeat run). */
export interface SeedResult {
  adminCreated: boolean;
  profileCreated: boolean;
  cuencadaCreated: boolean;
  locationsCreated: number;
  itineraryCreated: number;
  dailyMessagesCreated: number;
  chatRoomCreated: boolean;
}

/** Thrown when the environment is unsafe or incomplete for seeding. */
export class SeedConfigError extends Error {
  override name = "SeedConfigError";
}

/**
 * Read and validate seed settings from the environment. In production the
 * admin password must be set, satisfy the password policy and not be a known
 * placeholder; elsewhere a development fallback is used when it is missing.
 *
 * @throws SeedConfigError when the settings are unsafe.
 */
export function resolveSeedOptions(env: NodeJS.ProcessEnv = process.env): SeedOptions {
  const isProduction = env.NODE_ENV === "production";
  const email = emailSchema.safeParse(env.SEED_ADMIN_EMAIL ?? "admin@cuencada.com");
  if (!email.success) throw new SeedConfigError("SEED_ADMIN_EMAIL is not a valid email address.");

  const configured = env.SEED_ADMIN_TEMP_PASSWORD;
  if (!configured && isProduction) {
    throw new SeedConfigError("SEED_ADMIN_TEMP_PASSWORD is required in production.");
  }
  const password = configured || DEV_FALLBACK_PASSWORD;
  if (isProduction) {
    if (!passwordSchema.safeParse(password).success || WEAK_PASSWORDS.has(password.toLowerCase())) {
      throw new SeedConfigError(
        "SEED_ADMIN_TEMP_PASSWORD is too weak for production (12–128 characters, not a placeholder)."
      );
    }
  }

  return {
    adminEmail: email.data,
    adminTempPassword: password,
    dailyMessagesFile: env.SEED_DAILY_MESSAGES_FILE || DEFAULT_DAILY_MESSAGES_FILE
  };
}

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Insert the admin (must change password on first login) and its profile if missing. */
async function seedAdmin(tx: Transaction, options: SeedOptions): Promise<Pick<SeedResult, "adminCreated" | "profileCreated">> {
  const [existing] = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(sql`lower(${users.email})`, options.adminEmail))
    .limit(1);

  let adminId = existing?.id;
  let adminCreated = false;
  if (!adminId) {
    const [created] = await tx
      .insert(users)
      .values({
        email: options.adminEmail,
        displayName: "Administrador Cuencada",
        passwordHash: await argon2.hash(options.adminTempPassword, { type: argon2.argon2id }),
        role: "admin",
        status: "active",
        mustChangePassword: true
      })
      .returning({ id: users.id });
    if (!created) throw new Error("seed: admin insert returned no row");
    adminId = created.id;
    adminCreated = true;
  }

  const insertedProfile = await tx
    .insert(profiles)
    .values({ userId: adminId, fullName: "Administrador Cuencada", city: "México" })
    .onConflictDoNothing({ target: profiles.userId })
    .returning({ id: profiles.id });

  return { adminCreated, profileCreated: insertedProfile.length > 0 };
}

/** Insert the 2026 edition and any of its missing locations and itinerary items. */
async function seedCuencada2026(
  tx: Transaction
): Promise<{ cuencadaId: string } & Pick<SeedResult, "cuencadaCreated" | "locationsCreated" | "itineraryCreated">> {
  const data = cuencada2026();
  const inserted = await tx
    .insert(cuencadas)
    .values({
      ...data.cuencada,
      slug: String(data.cuencada.year),
      startsAt: new Date(data.cuencada.startsAt),
      endsAt: new Date(data.cuencada.endsAt),
      rsvpDeadline: data.cuencada.rsvpDeadline === null ? null : new Date(data.cuencada.rsvpDeadline)
    })
    .onConflictDoNothing({ target: cuencadas.year })
    .returning({ id: cuencadas.id });

  const [row] = await tx.select({ id: cuencadas.id }).from(cuencadas).where(eq(cuencadas.year, data.cuencada.year));
  if (!row) throw new Error("seed: 2026 Cuencada missing after insert");
  const cuencadaId = row.id;

  const locationIds = new Map<SeedLocationKey, string>();
  let locationsCreated = 0;
  for (const [sortOrder, { key, input }] of data.locations.entries()) {
    const [found] = await tx
      .select({ id: cuencadaLocations.id })
      .from(cuencadaLocations)
      .where(and(eq(cuencadaLocations.cuencadaId, cuencadaId), eq(cuencadaLocations.name, input.name)))
      .limit(1);
    if (found) {
      locationIds.set(key, found.id);
      continue;
    }
    const [created] = await tx
      .insert(cuencadaLocations)
      .values({ ...input, cuencadaId, sortOrder })
      .returning({ id: cuencadaLocations.id });
    if (!created) throw new Error(`seed: location insert returned no row (${input.name})`);
    locationIds.set(key, created.id);
    locationsCreated += 1;
  }

  let itineraryCreated = 0;
  for (const [sortOrder, { locationKey, input }] of data.itinerary.entries()) {
    const [found] = await tx
      .select({ id: cuencadaItineraryItems.id })
      .from(cuencadaItineraryItems)
      .where(
        and(
          eq(cuencadaItineraryItems.cuencadaId, cuencadaId),
          eq(cuencadaItineraryItems.date, input.date),
          eq(cuencadaItineraryItems.title, input.title)
        )
      )
      .limit(1);
    if (found) continue;
    await tx.insert(cuencadaItineraryItems).values({
      ...input,
      cuencadaId,
      locationId: locationKey === null ? null : (locationIds.get(locationKey) ?? null),
      sortOrder
    });
    itineraryCreated += 1;
  }

  return { cuencadaId, cuencadaCreated: inserted.length > 0, locationsCreated, itineraryCreated };
}

/** Insert daily messages from the legacy file; existing dates are left untouched. */
async function seedDailyMessages(tx: Transaction, cuencadaId: string, file: string): Promise<number> {
  const parsed = parseDailyMessagesText(await readFile(file, "utf8"));
  if (parsed.errors.length > 0) {
    const details = parsed.errors.map((error) => `${error.path}: ${error.message}`).join("; ");
    throw new Error(`seed: ${file} has invalid lines: ${details}`);
  }
  if (parsed.entries.length === 0) return 0;

  const inserted = await tx
    .insert(dailyMessages)
    .values(parsed.entries.map((entry) => ({ cuencadaId, date: entry.date, message: entry.message })))
    .onConflictDoNothing({ target: [dailyMessages.cuencadaId, dailyMessages.date] })
    .returning({ id: dailyMessages.id });
  return inserted.length;
}

/** Insert the single global chat room if it does not exist. */
async function seedGlobalChatRoom(tx: Transaction, title: string): Promise<boolean> {
  const inserted = await tx
    .insert(chatRooms)
    .values({ kind: "global", cuencadaId: null, title })
    .onConflictDoNothing({ target: chatRooms.kind, where: sql`kind = 'global'` })
    .returning({ id: chatRooms.id });
  return inserted.length > 0;
}

/**
 * Run the whole seed in one transaction. Safe to call repeatedly.
 *
 * @param db - Database to seed (the caller owns and closes the pool).
 * @param options - Settings from {@link resolveSeedOptions}.
 * @returns Counts of what this run inserted.
 */
export async function runSeed(db: Database, options: SeedOptions): Promise<SeedResult> {
  return db.transaction(async (tx) => {
    const admin = await seedAdmin(tx, options);
    const { cuencadaId, ...edition } = await seedCuencada2026(tx);
    const dailyMessagesCreated = await seedDailyMessages(tx, cuencadaId, options.dailyMessagesFile);
    const chatRoomCreated = await seedGlobalChatRoom(tx, cuencada2026().chatRoomTitle);
    return { ...admin, ...edition, dailyMessagesCreated, chatRoomCreated };
  });
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new SeedConfigError("Set DATABASE_URL to the database to seed.");
  const options = resolveSeedOptions();
  const db = createDatabase({ DATABASE_URL: databaseUrl }, { max: 1 });
  try {
    const result = await runSeed(db, options);
    process.stdout.write(`seed: done ${JSON.stringify(result)}\n`);
  } finally {
    await db.close();
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`seed: failed: ${message}\n`);
    process.exitCode = 1;
  });
}
