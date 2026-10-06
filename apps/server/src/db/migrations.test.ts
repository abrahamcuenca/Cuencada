import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { quoteIdent, TEST_DATABASE_URL, withDatabase, workerDatabaseName } from "../../test/env.js";
import { currentRunId } from "../../test/helpers/db.js";
import { migrationsFolder } from "./migrate.js";

/**
 * Upgrade test for migration 0001: a fresh database is migrated to 0000 only,
 * filled with seed-era rows, then migrated to the latest version. The scratch
 * database uses a harness-style name so the global teardown also reclaims it.
 */

interface JournalEntry {
  idx: number;
  tag: string;
}

interface Journal {
  entries: JournalEntry[];
}

const scratchName = workerDatabaseName(currentRunId(), `90${process.env.VITEST_POOL_ID ?? "1"}`);
let sql: postgres.Sql;
let partialFolder: string;

/** Copy the migrations folder keeping only the first `count` journal entries. */
async function migrationsUpTo(count: number): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "cuencada-migrations-"));
  await cp(migrationsFolder, folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal: unknown = JSON.parse(await readFile(journalPath, "utf8"));
  if (typeof journal !== "object" || journal === null || !("entries" in journal) || !Array.isArray(journal.entries)) {
    throw new Error("Unexpected drizzle journal shape");
  }
  const trimmed: Journal = { ...journal, entries: journal.entries.slice(0, count) };
  await writeFile(journalPath, JSON.stringify(trimmed));
  return folder;
}

/** Postgres SQLSTATE of a failed query, if any. */
async function sqlState(query: Promise<unknown>): Promise<string | undefined> {
  try {
    await query;
    return undefined;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
      return error.code;
    }
    throw error;
  }
}

beforeAll(async () => {
  const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`drop database if exists ${quoteIdent(scratchName)} with (force)`);
    await admin.unsafe(`create database ${quoteIdent(scratchName)}`);
  } finally {
    await admin.end();
  }
  sql = postgres(withDatabase(TEST_DATABASE_URL, scratchName), { max: 1, onnotice: () => {} });
  partialFolder = await migrationsUpTo(1);
});

afterAll(async () => {
  await sql?.end();
  if (partialFolder) await rm(partialFolder, { recursive: true, force: true });
  const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`drop database if exists ${quoteIdent(scratchName)} with (force)`);
  } finally {
    await admin.end();
  }
});

describe("migration 0001", () => {
  it("upgrades a seeded 0000 database, keeps its data and enforces the new constraints", async () => {
    await migrate(drizzle(sql), { migrationsFolder: partialFolder });

    // Seed-era rows, written with the 0000 column set.
    const [admin] = await sql<{ id: string }[]>`
      insert into users (email, password_hash, display_name, role, status, must_change_password)
      values ('admin@cuencada.com', 'argon2-hash', 'Administrador Cuencada', 'admin', 'active', true)
      returning id
    `;
    if (!admin) throw new Error("admin insert returned no row");
    await sql`insert into profiles (user_id, full_name, city, photo_url) values (${admin.id}, 'Administrador Cuencada', 'México', 'avatars/admin.webp')`;
    await sql`insert into profiles (user_id, full_name) values (null, 'Huérfano')`;
    const [cuencada] = await sql<{ id: string }[]>`
      insert into cuencadas (year, slug, title, status, starts_at, ends_at, city, state, description, theme_color)
      values (2026, '2026', 'Cuencada 2026', 'upcoming', '2026-09-13T00:00:00-06:00', '2026-09-18T23:59:59-06:00',
              'Mérida', 'Yucatán', 'Reunión familiar', '#0B5E55')
      returning id
    `;
    if (!cuencada) throw new Error("cuencada insert returned no row");
    await sql`
      insert into cuencada_itinerary_items (cuencada_id, item_date, item_time, title, description, display_order)
      values (${cuencada.id}, '2026-09-14T08:00:00-06:00', '7:40 PM', 'Cenote', 'Salida', 3)
    `;
    await sql`insert into cuencada_locations (cuencada_id, name, kind, display_order) values (${cuencada.id}, 'Izamal', 'map', 2)`;
    await sql`insert into audit_logs (actor_user_id, action, entity_type, metadata) values (${admin.id}, 'seed.run', 'user', '{}')`;
    await sql`insert into audit_logs (action, entity_type, metadata) values ('legacy.note', 'user', '[1,2]')`;

    await migrate(drizzle(sql), { migrationsFolder });

    const users = await sql`select email, role, must_change_password from users`;
    expect(users).toEqual([{ email: "admin@cuencada.com", role: "admin", must_change_password: true }]);

    const profiles = await sql`select user_id, full_name, avatar_key, show_city from profiles`;
    expect(profiles).toEqual([
      { user_id: admin.id, full_name: "Administrador Cuencada", avatar_key: "avatars/admin.webp", show_city: false }
    ]);

    const [migrated] = await sql`select theme_color, timezone, external_album_url from cuencadas where id = ${cuencada.id}`;
    expect(migrated).toEqual({ theme_color: "#0b5e55", timezone: "America/Merida", external_album_url: null });

    const [item] = await sql`select date::text as date, start_time::text as start_time, sort_order from cuencada_itinerary_items`;
    expect(item).toEqual({ date: "2026-09-14", start_time: "19:40:00", sort_order: 3 });

    const [location] = await sql`select kind, sort_order, visibility from cuencada_locations`;
    expect(location).toEqual({ kind: "attraction", sort_order: 2, visibility: "public" });

    const audit = await sql<{ action: string; metadata: unknown; type: string }[]>`
      select action, metadata, pg_typeof(metadata)::text as type from audit_logs order by action
    `;
    expect(audit).toEqual([
      { action: "legacy.note", metadata: { legacy: [1, 2] }, type: "jsonb" },
      { action: "seed.run", metadata: {}, type: "jsonb" }
    ]);

    // users.email is unique case-insensitively.
    expect(
      await sqlState(sql`insert into users (email, display_name) values ('Admin@Cuencada.com', 'Duplicado')`)
    ).toBe("23505");

    // A person cannot be related to themselves.
    const [person] = await sql<{ id: string }[]>`insert into people (full_name) values ('Abuela') returning id`;
    if (!person) throw new Error("person insert returned no row");
    expect(
      await sqlState(
        sql`insert into person_relationships (kind, from_person_id, to_person_id) values ('parent_of', ${person.id}, ${person.id})`
      )
    ).toBe("23514");

    // Theme colors must be lowercase #rrggbb.
    expect(await sqlState(sql`update cuencadas set theme_color = 'teal' where id = ${cuencada.id}`)).toBe("23514");

    // profiles.user_id is now required.
    expect(await sqlState(sql`insert into profiles (full_name) values ('Sin usuario')`)).toBe("23502");
  });
});
