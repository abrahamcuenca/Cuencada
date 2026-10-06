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
import { emailSchema, httpsUrlSchema, parseDailyMessagesText, passwordSchema } from "@cuencada/types";
import argon2 from "argon2";
import { and, eq, sql } from "drizzle-orm";
import { type Database, createDatabase } from "./db/client.js";
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
import {
  cuencada2026,
  LEGACY_DEV_LINKS,
  type SeedCuencada,
  type SeedLinks,
  type SeedLocationKey
} from "./seed-data.js";

/** Default location of the legacy daily-messages file (repo root). */
export const DEFAULT_DAILY_MESSAGES_FILE = fileURLToPath(new URL("../../../mensajes.txt", import.meta.url));

/** Temporary password used only when `NODE_ENV` is explicitly `development` or `test`. */
const DEV_FALLBACK_PASSWORD = "Password123!";

/** Minimum admin temporary-password length outside development and test. */
export const SEED_PASSWORD_MIN_LENGTH = 16;

/**
 * Well-known passwords and `.env.example` placeholders that are never accepted
 * outside development and test (compared case-insensitively).
 */
const WEAK_PASSWORDS = new Set(
  [
    DEV_FALLBACK_PASSWORD,
    "replace-with-vault-value",
    "change-me-in-vault",
    "password1234",
    "changeme1234",
    "cuencada2026",
    "admin1234567",
    "123456789012"
  ].map((p) => p.toLowerCase())
);

/** Validated seed settings. */
export interface SeedOptions {
  adminEmail: string;
  adminTempPassword: string;
  dailyMessagesFile: string;
  /** Member-only links for the 2026 edition; `null` when not configured. */
  links: SeedLinks;
}

/** What one seed run inserted (all zeros on a repeat run). */
export interface SeedResult {
  adminCreated: boolean;
  profileCreated: boolean;
  cuencadaCreated: boolean;
  locationsCreated: number;
  itineraryCreated: number;
  announcementsCreated: number;
  dailyMessagesCreated: number;
  chatRoomsCreated: number;
}

/** Thrown when the environment is unsafe or incomplete for seeding. */
export class SeedConfigError extends Error {
  override name = "SeedConfigError";
}

/**
 * Read one optional link env var. Values come from vault at cutover and are
 * never committed; dev/test fall back to the (already public) legacy link.
 */
function readLink(env: NodeJS.ProcessEnv, name: string, devOrTest: boolean, legacy: string): string | null {
  const raw = env[name];
  if (!raw) return devOrTest ? legacy : null;
  const parsed = httpsUrlSchema.safeParse(raw);
  if (!parsed.success) throw new SeedConfigError(`${name} must be an https:// URL.`);
  return parsed.data;
}

/** Resolve the member-only links of the 2026 edition from `SEED_*_URL` env vars. */
function resolveLinks(env: NodeJS.ProcessEnv, devOrTest: boolean): SeedLinks {
  return {
    whatsappUrl: readLink(env, "SEED_WHATSAPP_URL", devOrTest, LEGACY_DEV_LINKS.whatsappUrl),
    externalAlbumUrl: readLink(env, "SEED_EXTERNAL_ALBUM_URL", devOrTest, LEGACY_DEV_LINKS.externalAlbumUrl),
    lyricsUrl: readLink(env, "SEED_LYRICS_URL", devOrTest, LEGACY_DEV_LINKS.lyricsUrl),
    programUrl: readLink(env, "SEED_PROGRAM_URL", devOrTest, LEGACY_DEV_LINKS.programUrl)
  };
}

/**
 * Read and validate seed settings from the environment. Fails closed: the
 * development fallback password (and weak passwords) are allowed only when
 * `NODE_ENV` is explicitly `development` or `test`. With any other value,
 * including unset, `SEED_ADMIN_TEMP_PASSWORD` must be set, pass the password
 * policy, be at least {@link SEED_PASSWORD_MIN_LENGTH} characters and not be a
 * known placeholder.
 *
 * @throws SeedConfigError when the settings are unsafe.
 */
export function resolveSeedOptions(env: NodeJS.ProcessEnv = process.env): SeedOptions {
  const devOrTest = env.NODE_ENV === "development" || env.NODE_ENV === "test";
  const email = emailSchema.safeParse(env.SEED_ADMIN_EMAIL ?? "admin@cuencada.com");
  if (!email.success) throw new SeedConfigError("SEED_ADMIN_EMAIL is not a valid email address.");

  const configured = env.SEED_ADMIN_TEMP_PASSWORD;
  let password: string;
  if (devOrTest) {
    password = configured || DEV_FALLBACK_PASSWORD;
  } else {
    if (!configured) {
      throw new SeedConfigError(
        "SEED_ADMIN_TEMP_PASSWORD is required unless NODE_ENV is development or test."
      );
    }
    const weak =
      configured.length < SEED_PASSWORD_MIN_LENGTH ||
      !passwordSchema.safeParse(configured).success ||
      WEAK_PASSWORDS.has(configured.trim().toLowerCase());
    if (weak) {
      throw new SeedConfigError(
        `SEED_ADMIN_TEMP_PASSWORD is too weak (at least ${SEED_PASSWORD_MIN_LENGTH} characters, not a placeholder).`
      );
    }
    password = configured;
  }

  return {
    adminEmail: email.data,
    adminTempPassword: password,
    dailyMessagesFile: env.SEED_DAILY_MESSAGES_FILE || DEFAULT_DAILY_MESSAGES_FILE,
    links: resolveLinks(env, devOrTest)
  };
}

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Insert the admin (must change password on first login) and its profile if missing. */
async function seedAdmin(
  tx: Transaction,
  options: SeedOptions
): Promise<{ adminId: string } & Pick<SeedResult, "adminCreated" | "profileCreated">> {
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

  return { adminId, adminCreated, profileCreated: insertedProfile.length > 0 };
}

/** Insert the 2026 edition and any of its missing locations and itinerary items. */
async function seedCuencada2026(
  tx: Transaction,
  data: SeedCuencada
): Promise<{ cuencadaId: string } & Pick<SeedResult, "cuencadaCreated" | "locationsCreated" | "itineraryCreated">> {
  const inserted = await tx
    .insert(cuencadas)
    .values({
      ...data.cuencada,
      slug: String(data.cuencada.year),
      startsAt: new Date(data.cuencada.startsAt),
      endsAt: new Date(data.cuencada.endsAt),
      rsvpDeadline: data.cuencada.rsvpDeadline === null ? null : new Date(data.cuencada.rsvpDeadline),
      // Seeded already published: record it, like T2 does on a first publish.
      firstPublishedAt: data.cuencada.isPublished ? new Date() : null
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

/** Insert the member-only link announcements of the edition that are missing (matched by title). */
async function seedAnnouncements(
  tx: Transaction,
  cuencadaId: string,
  adminId: string,
  announcementsToSeed: SeedCuencada["announcements"]
): Promise<number> {
  let created = 0;
  for (const input of announcementsToSeed) {
    const [found] = await tx
      .select({ id: announcements.id })
      .from(announcements)
      .where(and(eq(announcements.cuencadaId, cuencadaId), eq(announcements.title, input.title)))
      .limit(1);
    if (found) continue;
    await tx.insert(announcements).values({ ...input, cuencadaId, createdByUserId: adminId });
    created += 1;
  }
  return created;
}

/**
 * Insert the global room and the 2026 room if missing. The 2026 edition is
 * seeded already published, so T2's "create on first publish" never fires for it.
 */
async function seedChatRooms(tx: Transaction, cuencadaId: string, data: SeedCuencada): Promise<number> {
  const global = await tx
    .insert(chatRooms)
    .values({ kind: "global", cuencadaId: null, title: data.globalChatRoomTitle })
    .onConflictDoNothing({ target: chatRooms.kind, where: sql`kind = 'global'` })
    .returning({ id: chatRooms.id });
  const edition = await tx
    .insert(chatRooms)
    .values({ kind: "cuencada", cuencadaId, title: data.cuencadaChatRoomTitle })
    .onConflictDoNothing({ target: chatRooms.cuencadaId, where: sql`kind = 'cuencada'` })
    .returning({ id: chatRooms.id });
  return global.length + edition.length;
}

/**
 * Run the whole seed in one transaction. Safe to call repeatedly.
 *
 * @param db - Database to seed (the caller owns and closes the pool).
 * @param options - Settings from {@link resolveSeedOptions}.
 * @returns Counts of what this run inserted.
 */
export async function runSeed(db: Database, options: SeedOptions): Promise<SeedResult> {
  const data = cuencada2026(options.links);
  return db.transaction(async (tx) => {
    const { adminId, ...admin } = await seedAdmin(tx, options);
    const { cuencadaId, ...edition } = await seedCuencada2026(tx, data);
    const announcementsCreated = await seedAnnouncements(tx, cuencadaId, adminId, data.announcements);
    const dailyMessagesCreated = await seedDailyMessages(tx, cuencadaId, options.dailyMessagesFile);
    const chatRoomsCreated = await seedChatRooms(tx, cuencadaId, data);
    return { ...admin, ...edition, announcementsCreated, dailyMessagesCreated, chatRoomsCreated };
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
