import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { quoteIdent, TEST_DATABASE_URL, withDatabase, workerDatabaseName } from "../../test/env.js";
import { currentRunId } from "../../test/helpers/db.js";
import { migrationsFolder } from "./migrate.js";

/**
 * Upgrade tests. Migration 0001: a fresh database is migrated to 0000 only,
 * filled with seed-era rows, then migrated to the latest version. Migration
 * 0002: the same database is first taken 0000 → 0001, filled with rows in the
 * 0001 shape, then migrated to the latest version. The scratch database uses a
 * harness-style name so the global teardown also reclaims it.
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
let upTo0001Folder: string;

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

async function dropScratch(): Promise<void> {
  const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`drop database if exists ${quoteIdent(scratchName)} with (force)`);
  } finally {
    await admin.end();
  }
}

beforeAll(async () => {
  partialFolder = await migrationsUpTo(1);
  upTo0001Folder = await migrationsUpTo(2);
});

// Every test starts from a brand-new database migrated to 0000 only.
beforeEach(async () => {
  await sql?.end();
  await dropScratch();
  const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`create database ${quoteIdent(scratchName)}`);
  } finally {
    await admin.end();
  }
  sql = postgres(withDatabase(TEST_DATABASE_URL, scratchName), { max: 1, onnotice: () => {} });
  await migrate(drizzle(sql), { migrationsFolder: partialFolder });
});

afterAll(async () => {
  await sql?.end();
  if (partialFolder) await rm(partialFolder, { recursive: true, force: true });
  if (upTo0001Folder) await rm(upTo0001Folder, { recursive: true, force: true });
  await dropScratch();
});

describe("migration 0001", () => {
  it("upgrades a seeded 0000 database, keeps its data and enforces the new constraints", async () => {
    // Seed-era rows, written with the 0000 column set.
    const [admin] = await sql<{ id: string }[]>`
      insert into users (email, password_hash, display_name, role, status, must_change_password)
      values (' Admin@Cuencada.com ', 'argon2-hash', 'Administrador Cuencada', 'admin', 'active', true)
      returning id
    `;
    if (!admin) throw new Error("admin insert returned no row");
    await sql`insert into profiles (user_id, full_name, city, photo_url) values (${admin.id}, 'Administrador Cuencada', 'México', 'avatars/admin.webp')`;
    await sql`insert into profiles (user_id, full_name) values (null, 'Huérfano')`;
    // An older duplicate profile for the same user: the dedupe keeps the newest one.
    await sql`
      insert into profiles (user_id, full_name, created_at, updated_at)
      values (${admin.id}, 'Perfil viejo', now() - interval '1 day', now() - interval '1 day')
    `;
    await sql`
      insert into sessions (user_id, refresh_token_hash, expires_at)
      values (${admin.id}, 'old-refresh-hash', now() + interval '30 days')
    `;
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
    await sql`insert into chat_rooms (room_type, title) values ('general', 'Familia')`;
    await sql`insert into chat_rooms (cuencada_id, room_type, title) values (${cuencada.id}, 'event', 'Cuencada 2026')`;
    await sql`insert into audit_logs (action, entity_type, metadata) values ('legacy.note', 'user', '[1,2]')`;

    await migrate(drizzle(sql), { migrationsFolder });

    const users = await sql`select email, role, must_change_password from users`;
    expect(users).toEqual([{ email: "admin@cuencada.com", role: "admin", must_change_password: true }]);

    expect(await sql`select count(*)::int as count from sessions`).toEqual([{ count: 0 }]);

    const rooms = await sql`select kind, cuencada_id, title from chat_rooms order by kind`;
    expect(rooms).toEqual([
      { kind: "cuencada", cuencada_id: cuencada.id, title: "Cuencada 2026" },
      { kind: "global", cuencada_id: null, title: "Familia" }
    ]);

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

  it("aborts and rolls back to 0000 when family_relationships has rows", async () => {
    const [user] = await sql<{ id: string }[]>`
      insert into users (email, display_name) values ('tia@example.test', 'Tía') returning id
    `;
    if (!user) throw new Error("user insert returned no row");
    await sql`
      insert into family_relationships (person_user_id, relative_user_id, relationship_type)
      values (${user.id}, ${user.id}, 'sibling')
    `;

    await expect(migrate(drizzle(sql), { migrationsFolder })).rejects.toThrow();

    // Nothing from 0001 survived: still one applied migration, old tables and columns intact.
    expect(await sql`select count(*)::int as count from drizzle.__drizzle_migrations`).toEqual([{ count: 1 }]);
    expect(await sql`select count(*)::int as count from family_relationships`).toEqual([{ count: 1 }]);
    expect(await sql`select to_regclass('public.people')::text as people`).toEqual([{ people: null }]);
    const photoColumn = await sql`
      select 1 from information_schema.columns where table_name = 'profiles' and column_name = 'photo_url'
    `;
    expect(photoColumn).toHaveLength(1);
  });
});

/** Insert one row and return its id. */
async function insertId(query: Promise<{ id: string }[]>): Promise<string> {
  const [row] = await query;
  if (!row) throw new Error("insert returned no row");
  return row.id;
}

describe("migration 0002", () => {
  it("upgrades a seeded 0001 database: backfill, defaults, composite FKs, tags and revoked reasons", async () => {
    await migrate(drizzle(sql), { migrationsFolder: upTo0001Folder });

    // Rows in the 0001 shape.
    const userId = await insertId(sql`
      insert into users (email, display_name) values ('tia@example.test', 'Tía') returning id
    `);
    await sql`insert into profiles (user_id, full_name) values (${userId}, 'Tía Morales')`;
    const editionRow = (year: number, published: boolean): Promise<{ id: string }[]> => sql`
      insert into cuencadas (year, slug, title, starts_at, ends_at, city, state, description, is_published, created_at)
      values (${year}, ${String(year)}, ${`Cuencada ${year}`}, ${`${year}-09-13T00:00:00-06:00`},
              ${`${year}-09-18T00:00:00-06:00`}, 'Mérida', 'Yucatán', 'Reunión', ${published},
              ${`${year - 1}-01-15T12:00:00Z`})
      returning id
    `;
    const published = await insertId(editionRow(2026, true));
    const unpublished = await insertId(editionRow(2025, false));
    const draft = await insertId(editionRow(2027, false));
    // Once-published, now unpublished: its edition chat room survives.
    await sql`insert into chat_rooms (kind, cuencada_id, title) values ('cuencada', ${unpublished}, 'Cuencada 2025')`;

    const hotel = await insertId(sql`
      insert into cuencada_locations (cuencada_id, name, kind) values (${published}, 'Hotel Chariot', 'hotel') returning id
    `);
    const venue = await insertId(sql`
      insert into cuencada_locations (cuencada_id, name, kind) values (${published}, 'Salón', 'venue') returning id
    `);
    const otherHotel = await insertId(sql`
      insert into cuencada_locations (cuencada_id, name, kind) values (${draft}, 'Hotel 2027', 'hotel') returning id
    `);
    const linked = await insertId(sql`
      insert into cuencada_itinerary_items (cuencada_id, date, title, location_id)
      values (${published}, '2026-09-14', 'Cenote', ${venue}) returning id
    `);
    // A cross-edition reference that slipped past the service: 0002 unlinks it.
    const crossLinked = await insertId(sql`
      insert into cuencada_itinerary_items (cuencada_id, date, title, location_id)
      values (${published}, '2026-09-15', 'Uxmal', ${otherHotel}) returning id
    `);
    const rsvp = await insertId(sql`
      insert into cuencada_rsvps (cuencada_id, user_id, status, hotel_location_id)
      values (${published}, ${userId}, 'yes', ${hotel}) returning id
    `);
    // 0001 rejects the new revoked reason.
    const sessionId = await insertId(sql`
      insert into sessions (user_id, idle_expires_at, absolute_expires_at)
      values (${userId}, now() + interval '1 day', now() + interval '30 days') returning id
    `);
    expect(
      await sqlState(sql`update sessions set revoked_at = now(), revoked_reason = 'logout_all' where id = ${sessionId}`)
    ).toBe("23514");

    await migrate(drizzle(sql), { migrationsFolder });
    expect(await sql`select count(*)::int as count from drizzle.__drizzle_migrations`).toEqual([{ count: 3 }]);

    // listed_in_directory defaults to true, for existing and new profiles.
    expect(await sql`select listed_in_directory from profiles`).toEqual([{ listed_in_directory: true }]);
    const newUser = await insertId(sql`insert into users (email, display_name) values ('primo@example.test', 'Primo') returning id`);
    await sql`insert into profiles (user_id, full_name) values (${newUser}, 'Primo')`;
    expect(await sql`select listed_in_directory from profiles where user_id = ${newUser}`).toEqual([
      { listed_in_directory: true }
    ]);

    // first_published_at = created_at for editions that were ever published; null for drafts.
    const editions = await sql`
      select year, (first_published_at at time zone 'UTC')::text as first_published_utc,
             first_published_at = created_at as equals_created
      from cuencadas order by year
    `;
    expect(editions).toEqual([
      { year: 2025, first_published_utc: "2024-01-15 12:00:00", equals_created: true },
      { year: 2026, first_published_utc: "2025-01-15 12:00:00", equals_created: true },
      { year: 2027, first_published_utc: null, equals_created: null }
    ]);

    // Tags default to an empty array and are capped at 6 with no NULL elements.
    expect(await sql`select tags from cuencada_itinerary_items where id = ${linked}`).toEqual([{ tags: [] }]);
    await sql`update cuencada_itinerary_items set tags = ${sql.array(["a", "b", "c", "d", "e", "f"])} where id = ${linked}`;
    expect(
      await sqlState(
        sql`update cuencada_itinerary_items set tags = ${sql.array(["a", "b", "c", "d", "e", "f", "g"])} where id = ${linked}`
      )
    ).toBe("23514");
    expect(
      await sqlState(sql`update cuencada_itinerary_items set tags = array['a', null]::text[] where id = ${linked}`)
    ).toBe("23514");

    // The pre-existing cross-edition reference was unlinked; the valid ones kept.
    const items = await sql`select id, location_id from cuencada_itinerary_items order by date`;
    expect(items).toEqual([
      { id: linked, location_id: venue },
      { id: crossLinked, location_id: null }
    ]);
    expect(await sql`select hotel_location_id from cuencada_rsvps where id = ${rsvp}`).toEqual([
      { hotel_location_id: hotel }
    ]);

    // Composite FKs: a location of another edition is rejected.
    expect(
      await sqlState(sql`
        insert into cuencada_itinerary_items (cuencada_id, date, title, location_id)
        values (${published}, '2026-09-16', 'Progreso', ${otherHotel})
      `)
    ).toBe("23503");
    expect(await sqlState(sql`update cuencada_rsvps set hotel_location_id = ${otherHotel} where id = ${rsvp}`)).toBe(
      "23503"
    );

    // Deleting a location nulls only the referencing column, never cuencada_id.
    await sql`delete from cuencada_locations where id = ${venue}`;
    expect(await sql`select cuencada_id, location_id from cuencada_itinerary_items where id = ${linked}`).toEqual([
      { cuencada_id: published, location_id: null }
    ]);
    await sql`delete from cuencada_locations where id = ${hotel}`;
    expect(await sql`select cuencada_id, hotel_location_id, status from cuencada_rsvps where id = ${rsvp}`).toEqual([
      { cuencada_id: published, hotel_location_id: null, status: "yes" }
    ]);

    // The new revoked reason is accepted; old ones still are; unknown ones are not.
    await sql`update sessions set revoked_at = now(), revoked_reason = 'logout_all' where id = ${sessionId}`;
    await sql`update sessions set revoked_reason = 'refresh_reuse' where id = ${sessionId}`;
    expect(await sqlState(sql`update sessions set revoked_reason = 'bogus' where id = ${sessionId}`)).toBe("23514");
  });
});
