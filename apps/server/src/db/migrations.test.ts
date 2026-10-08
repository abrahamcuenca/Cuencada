import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTACT_HANDLE_RULES, E164_PATTERN, type HandleNetwork, PersonRevisionAction, isE164, isValidHandle } from "@cuencada/types";
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
 * 0001 shape, then migrated to the latest version. Migration 0003: likewise
 * from 0002, migration 0004 from 0003, migration 0005 (data only) from
 * 0004, and migration 0006 (wider revision action CHECK) from 0005. The scratch database uses a
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
let upTo0002Folder: string;
let upTo0003Folder: string;
let upTo0004Folder: string;
let upTo0005Folder: string;
/** Number of migrations in the real journal (the "latest" version). */
let latestCount: number;

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
  upTo0002Folder = await migrationsUpTo(3);
  upTo0003Folder = await migrationsUpTo(4);
  upTo0004Folder = await migrationsUpTo(5);
  upTo0005Folder = await migrationsUpTo(6);
  const journal = JSON.parse(await readFile(join(migrationsFolder, "meta", "_journal.json"), "utf8")) as Journal; // drizzle-kit's own file shape
  latestCount = journal.entries.length;
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
  if (upTo0002Folder) await rm(upTo0002Folder, { recursive: true, force: true });
  if (upTo0003Folder) await rm(upTo0003Folder, { recursive: true, force: true });
  if (upTo0004Folder) await rm(upTo0004Folder, { recursive: true, force: true });
  if (upTo0005Folder) await rm(upTo0005Folder, { recursive: true, force: true });
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
    expect(await sql`select count(*)::int as count from drizzle.__drizzle_migrations`).toEqual([{ count: latestCount }]);

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

describe("migration 0003", () => {
  it("upgrades a seeded 0002 database: existing editions unchanged, undated editions allowed, one date only rejected", async () => {
    await migrate(drizzle(sql), { migrationsFolder: upTo0002Folder });

    // Rows in the 0002 shape: a published and a draft edition, an RSVP with a deadline.
    const userId = await insertId(sql`
      insert into users (email, display_name) values ('tia@example.test', 'Tía') returning id
    `);
    const published = await insertId(sql`
      insert into cuencadas (year, slug, title, starts_at, ends_at, city, state, description, is_published,
                             rsvp_deadline, first_published_at)
      values (2026, '2026', 'Cuencada 2026', '2026-09-13T19:30:00-06:00', '2026-09-18T12:00:00-06:00',
              'Mérida', 'Yucatán', 'Reunión', true, '2026-08-31T23:59:00-06:00', '2026-01-15T12:00:00Z')
      returning id
    `);
    await sql`insert into cuencada_rsvps (cuencada_id, user_id, status) values (${published}, ${userId}, 'yes')`;
    // 0002 refuses an undated edition.
    expect(
      await sqlState(sql`
        insert into cuencadas (year, slug, title, city, state, description) values (2027, '2027', 'Cuencada 2027', 'X', 'Y', 'Z')
      `)
    ).toBe("23502");
    const before = await sql`select * from cuencadas order by year`;

    await migrate(drizzle(sql), { migrationsFolder });
    expect(await sql`select count(*)::int as count from drizzle.__drizzle_migrations`).toEqual([{ count: latestCount }]);

    // Existing rows are byte-for-byte unchanged.
    expect(await sql`select * from cuencadas order by year`).toEqual(before);
    expect(await sql`select status from cuencada_rsvps`).toEqual([{ status: "yes" }]);

    // An announced edition: no dates, no place, published.
    const announced = await insertId(sql`
      insert into cuencadas (year, slug, title, description, is_published, first_published_at)
      values (2027, '2027', 'Cuencada 2027', 'Fecha y lugar por anunciar', true, now())
      returning id
    `);
    expect(await sql`select starts_at, ends_at, city, state from cuencadas where id = ${announced}`).toEqual([
      { starts_at: null, ends_at: null, city: null, state: null }
    ]);
    // A place without dates (and dates without a place) are fine.
    await sql`update cuencadas set city = 'Valladolid', state = 'Yucatán' where id = ${announced}`;

    // One date only is rejected, both on insert and on update.
    expect(
      await sqlState(sql`
        insert into cuencadas (year, slug, title, description, starts_at)
        values (2028, '2028', 'Cuencada 2028', 'x', '2028-09-13T00:00:00Z')
      `)
    ).toBe("23514");
    expect(
      await sqlState(sql`
        insert into cuencadas (year, slug, title, description, ends_at)
        values (2028, '2028', 'Cuencada 2028', 'x', '2028-09-13T00:00:00Z')
      `)
    ).toBe("23514");
    expect(await sqlState(sql`update cuencadas set ends_at = null where id = ${published}`)).toBe("23514");
    expect(
      await sqlState(sql`update cuencadas set starts_at = '2027-09-13T00:00:00Z' where id = ${announced}`)
    ).toBe("23514");
    // The order rule still holds when both are set.
    expect(
      await sqlState(sql`
        update cuencadas set starts_at = '2027-09-18T00:00:00Z', ends_at = '2027-09-13T00:00:00Z' where id = ${announced}
      `)
    ).toBe("23514");
    // Setting both dates later works; clearing both works.
    await sql`update cuencadas set starts_at = '2027-09-13T00:00:00Z', ends_at = '2027-09-18T00:00:00Z' where id = ${announced}`;
    await sql`update cuencadas set starts_at = null, ends_at = null where id = ${announced}`;

    // `year` is still required and unique on its own.
    expect(
      await sqlState(sql`insert into cuencadas (year, slug, title, description) values (2027, '2027b', 'Otra', 'x')`)
    ).toBe("23505");
    expect(await sqlState(sql`insert into cuencadas (slug, title, description) values ('sin-año', 'Otra', 'x')`)).toBe(
      "23502"
    );
  });
});

describe("migration 0004", () => {
  /** Old-shape columns that must be byte-for-byte unchanged by 0004. */
  const selectOldPeople =
    "select id, user_id, full_name, nickname, family_branch, birth_year, death_year, deceased, created_by_user_id, " +
    "created_at, updated_at from people order by full_name";
  const selectOldProfiles =
    "select id, user_id, full_name, family_branch, city, phone, avatar_key, bio, show_email, show_phone, show_city, " +
    "listed_in_directory, created_at, updated_at from profiles order by full_name";

  it("upgrades a seeded 0003 database: existing people and profiles unchanged, new columns empty", async () => {
    await migrate(drizzle(sql), { migrationsFolder: upTo0003Folder });

    // Rows in the 0003 shape.
    const userId = await insertId(sql`
      insert into users (email, display_name) values ('ana@example.test', 'Ana') returning id
    `);
    await sql`
      insert into profiles (user_id, full_name, city, phone, show_email, show_phone, show_city)
      values (${userId}, 'Ana Morales Vega', 'Mérida', '555 010 0101', true, false, true)
    `;
    const ana = await insertId(sql`
      insert into people (user_id, full_name, family_branch, birth_year, created_by_user_id)
      values (${userId}, 'Ana Morales Vega', 'Rama Norte', 1990, ${userId}) returning id
    `);
    const bisabuelo = await insertId(sql`
      insert into people (full_name, birth_year, death_year, deceased) values ('Bisabuelo Vega', 1901, 1980, true) returning id
    `);
    await sql`insert into person_relationships (kind, from_person_id, to_person_id) values ('parent_of', ${bisabuelo}, ${ana})`;
    const peopleBefore = await sql.unsafe(selectOldPeople);
    const profilesBefore = await sql.unsafe(selectOldProfiles);

    await migrate(drizzle(sql), { migrationsFolder });
    expect(await sql`select count(*)::int as count from drizzle.__drizzle_migrations`).toEqual([{ count: latestCount }]);

    expect(await sql.unsafe(selectOldPeople)).toEqual(peopleBefore);
    // Every pre-0004 edge came from the admin-only routes: it is not member-created (Security M1).
    expect(await sql`select kind, created_by_member from person_relationships`).toEqual([
      { kind: "parent_of", created_by_member: false }
    ]);
    expect(await sql.unsafe(selectOldProfiles)).toEqual(profilesBefore);
    expect(
      await sql`
        select birth_date, death_date, birthplace, bio, photo_key, photo_updated_at, updated_by_user_id
        from people where id = ${ana}
      `
    ).toEqual([
      {
        birth_date: null,
        death_date: null,
        birthplace: null,
        bio: null,
        photo_key: null,
        photo_updated_at: null,
        updated_by_user_id: null
      }
    ]);
    // The phone is not rewritten to E.164 by the migration (a later WP backfills it).
    expect(
      await sql`
        select phone, whatsapp, instagram, facebook, tiktok, linkedin, github, website, contact_visibility
        from profiles where user_id = ${userId}
      `
    ).toEqual([
      {
        phone: "555 010 0101",
        whatsapp: null,
        instagram: null,
        facebook: null,
        tiktok: null,
        linkedin: null,
        github: null,
        website: null,
        contact_visibility: {}
      }
    ]);
    // An old-style insert (0003 column set) still works.
    await sql`insert into people (full_name, birth_year) values ('Nueva Persona', 2001)`;
  });

  it("enforces the people date, length and photo CHECKs", async () => {
    await migrate(drizzle(sql), { migrationsFolder });
    const person = await insertId(sql`insert into people (full_name) values ('Luis Vega') returning id`);
    const update = (fragment: postgres.PendingQuery<postgres.Row[]>): Promise<string | undefined> =>
      sqlState(sql`update people set ${fragment} where id = ${person}`);

    // A date needs its year, and must fall in it.
    expect(await update(sql`birth_date = '1950-03-04'`)).toBe("23514");
    expect(await update(sql`birth_year = 1951, birth_date = '1950-03-04'`)).toBe("23514");
    expect(await update(sql`birth_year = 1950, birth_date = '1950-03-04'`)).toBeUndefined();
    // Changing the year away from a stored date is refused; clearing the date first works.
    expect(await update(sql`birth_year = 1949`)).toBe("23514");
    expect(await update(sql`birth_year = null`)).toBe("23514");

    // Death date: needs its year, deceased, and not before birth.
    expect(await update(sql`death_date = '1990-01-01'`)).toBe("23514");
    expect(await update(sql`death_year = 1990, death_date = '1990-01-01'`)).toBe("23514"); // not deceased
    expect(await update(sql`death_year = 1950, death_date = '1950-01-01', deceased = true`)).toBe("23514"); // before birth
    expect(await update(sql`death_year = 1950, death_date = '1950-03-04', deceased = true`)).toBeUndefined(); // same day
    expect(await update(sql`death_year = 1990, death_date = '1990-01-01', deceased = true`)).toBeUndefined();

    // Year-only people are still fine.
    expect(await update(sql`birth_date = null, death_date = null, birth_year = 1930, death_year = 1931`)).toBeUndefined();

    // Lengths are counted in characters, not bytes.
    expect(await update(sql`birthplace = ${"é".repeat(120)}`)).toBeUndefined();
    expect(await update(sql`birthplace = ${"é".repeat(121)}`)).toBe("23514");
    expect(await update(sql`bio = ${"ñ".repeat(1000)}`)).toBeUndefined();
    expect(await update(sql`bio = ${"ñ".repeat(1001)}`)).toBe("23514");

    // A photo key needs its timestamp.
    expect(await update(sql`photo_key = 'people/x/photo-512.webp'`)).toBe("23514");
    expect(await update(sql`photo_key = 'people/x/photo-512.webp', photo_updated_at = now()`)).toBeUndefined();
  });

  it("enforces the contact CHECKs with exactly the contract's handle rules", async () => {
    await migrate(drizzle(sql), { migrationsFolder });
    const userId = await insertId(sql`insert into users (email, display_name) values ('beto@example.test', 'Beto') returning id`);
    await sql`insert into profiles (user_id, full_name) values (${userId}, 'Beto Morales')`;
    const store = (column: string, value: string): Promise<string | undefined> =>
      sqlState(sql`update profiles set ${sql(column)} = ${value} where user_id = ${userId}`);

    const corpus = [
      "ana.morales",
      "ana_morales",
      "Ana-Morales",
      "a",
      "ab",
      "abcde",
      "x".repeat(24),
      "x".repeat(25),
      "x".repeat(30),
      "x".repeat(31),
      "x".repeat(39),
      "x".repeat(40),
      "x".repeat(50),
      "x".repeat(51),
      "x".repeat(100),
      "x".repeat(101),
      ".ana",
      "ana.",
      "-ana",
      "ana-",
      "an--a",
      "a-b-c",
      "javascript:alert(1)",
      "ana/../../evil",
      "ana%2F..%2Fevil",
      "ana@evil.com",
      "evil.com@ana",
      "ana?x=1",
      "ana#x",
      "ana morales",
      "ana\nmorales",
      "ana\n",
      "аna", // Cyrillic а
      "ａｎａ", // full-width
      "ana\u200B", // zero-width space
      ""
    ];
    // Object.keys of the rules object is exactly its HandleNetwork keys.
    for (const network of Object.keys(CONTACT_HANDLE_RULES) as HandleNetwork[]) {
      for (const value of corpus) {
        const accepted = (await store(network, value)) === undefined;
        expect(accepted, `${network}: ${JSON.stringify(value)}`).toBe(isValidHandle(network, value));
      }
    }

    const phones = ["+525512345678", "+15551234567", "+1234567", "+123456", "+1234567890123456", "+052", "5512345678", "+52 55 1234 5678", "+52551234567\n"];
    for (const value of phones) {
      const accepted = (await store("whatsapp", value)) === undefined;
      expect(accepted, `whatsapp: ${JSON.stringify(value)}`).toBe(isE164(value));
    }

    expect(await store("website", "https://example.com/ana")).toBeUndefined();
    expect(await store("website", `https://example.com/${"a".repeat(180)}`)).toBeUndefined(); // 200 chars
    expect(await store("website", `https://example.com/${"a".repeat(181)}`)).toBe("23514");
    expect(await store("website", "http://example.com")).toBe("23514");
    expect(await store("website", "javascript:alert(1)")).toBe("23514");
    expect(await store("website", " https://example.com")).toBe("23514");

    // The visibility map: an object of booleans over the seven stored kinds only.
    const visibility = (json: string): Promise<string | undefined> =>
      sqlState(sql`update profiles set contact_visibility = ${json}::jsonb where user_id = ${userId}`);
    expect(await visibility(`{"whatsapp": true, "instagram": false, "website": true}`)).toBeUndefined();
    expect(await visibility("{}")).toBeUndefined();
    expect(await visibility(`{"email": true}`)).toBe("23514"); // show_email is the source of truth
    expect(await visibility(`{"phone": false}`)).toBe("23514");
    expect(await visibility(`{"whatsapp": "yes"}`)).toBe("23514");
    expect(await visibility(`{"whatsapp": null}`)).toBe("23514");
    expect(await visibility(`{"whatsapp": {"x": true}}`)).toBe("23514");
    expect(await visibility("[]")).toBe("23514");
    expect(await visibility("null")).toBe("23514");
    expect(await sqlState(sql`update profiles set contact_visibility = null where user_id = ${userId}`)).toBe("23502");
  });

  it("cascades photo uploads, keeps revisions through deletes and checks revision actions", async () => {
    await migrate(drizzle(sql), { migrationsFolder });
    const adminId = await insertId(sql`insert into users (email, display_name) values ('admin@example.test', 'Admin') returning id`);
    const editorId = await insertId(sql`insert into users (email, display_name) values ('tia@example.test', 'Tía') returning id`);
    const person = await insertId(sql`
      insert into people (full_name, updated_by_user_id, created_by_user_id) values ('Abuela Vega', ${editorId}, ${adminId}) returning id
    `);

    // Photo uploads: mime/size CHECKs like avatar_uploads.
    const upload = (mime: string, size: number, key: string): Promise<string | undefined> =>
      sqlState(sql`
        insert into person_photo_uploads (person_id, uploaded_by_user_id, object_key, mime_type, byte_size, expires_at)
        values (${person}, ${editorId}, ${key}, ${mime}, ${size}, now() + interval '15 minutes')
      `);
    expect(await upload("image/jpeg", 1024, "people/p/u1")).toBeUndefined();
    expect(await upload("image/heic", 1024, "people/p/u2")).toBe("23514");
    expect(await upload("image/png", 0, "people/p/u3")).toBe("23514");
    expect(await upload("image/png", 10 * 1024 * 1024 + 1, "people/p/u4")).toBe("23514");
    expect(await upload("image/webp", 10, "people/p/u1")).toBe("23505"); // object key unique

    // Revisions: action CHECK, object snapshots that name the person, no self-revert.
    const snapshot = (fields: Record<string, unknown> = {}): string => JSON.stringify({ type: "person", personId: person, ...fields });
    const revision = (action: string, before: string | null = snapshot(), after: string | null = null): Promise<string | undefined> =>
      sqlState(sql`
        insert into person_revisions (person_id, actor_user_id, action, before, after)
        values (${person}, ${editorId}, ${action}, ${before}::jsonb, ${after}::jsonb)
      `);
    for (const action of Object.values(PersonRevisionAction)) expect(await revision(action), action).toBeUndefined();
    expect(await revision("person.bogus")).toBe("23514");
    expect(await revision("person.update", "[1, 2]")).toBe("23514");
    expect(await revision("person.update", JSON.stringify("text"))).toBe("23514");
    // Security L2: every snapshot must carry personId (a string), and a revision needs one snapshot.
    expect(await revision("person.update", JSON.stringify({ type: "person", fullName: "x" }))).toBe("23514");
    expect(await revision("person.update", snapshot(), JSON.stringify({ type: "person" }))).toBe("23514");
    expect(await revision("person.update", JSON.stringify({ type: "person", personId: 42 }))).toBe("23514");
    expect(await revision("person.update", JSON.stringify({ type: "person", personId: null }))).toBe("23514");
    expect(await revision("person.update", null, null)).toBe("23514");
    expect(await revision("person.create", null, snapshot())).toBeUndefined();
    const original = await insertId(sql`
      insert into person_revisions (person_id, actor_user_id, action, before, after)
      values (${person}, ${editorId}, 'person.update', ${snapshot({ fullName: "Abuela" })}::jsonb,
              ${snapshot({ fullName: "Abuela Vega" })}::jsonb)
      returning id
    `);
    expect(await sqlState(sql`update person_revisions set reverted_by_revision_id = id where id = ${original}`)).toBe("23514");
    const revert = await insertId(sql`
      insert into person_revisions (person_id, actor_user_id, action, after)
      values (${person}, ${adminId}, 'person.revert', ${snapshot()}::jsonb) returning id
    `);
    await sql`update person_revisions set reverted_by_revision_id = ${revert} where id = ${original}`;
    // Retention cleanup deleting the revert row unlinks the original instead of failing.
    await sql`delete from person_revisions where id = ${revert}`;
    expect(await sql`select reverted_by_revision_id from person_revisions where id = ${original}`).toEqual([
      { reverted_by_revision_id: null }
    ]);
    const relationshipRevision = await insertId(sql`
      insert into person_revisions (relationship_id, actor_user_id, action, after)
      values (gen_random_uuid(), ${editorId}, 'relationship.create',
              ${JSON.stringify({ type: "relationship", personId: person, fromPersonId: adminId, toPersonId: person })}::jsonb)
      returning id
    `);

    // Deleting the editor's account: set null everywhere, nothing lost.
    await sql`delete from users where id = ${editorId}`;
    expect(await sql`select updated_by_user_id from people where id = ${person}`).toEqual([{ updated_by_user_id: null }]);
    expect(await sql`select uploaded_by_user_id from person_photo_uploads`).toEqual([{ uploaded_by_user_id: null }]);
    expect(await sql`select count(*)::int as count from person_revisions where actor_user_id is null`).toEqual([
      { count: Object.values(PersonRevisionAction).length + 3 }
    ]);

    // Deleting the person: uploads cascade, revisions survive with person_id null.
    const revisionCount = await sql`select count(*)::int as count from person_revisions`;
    await sql`delete from people where id = ${person}`;
    expect(await sql`select count(*)::int as count from person_photo_uploads`).toEqual([{ count: 0 }]);
    expect(await sql`select count(*)::int as count from person_revisions`).toEqual(revisionCount);
    expect(await sql`select count(*)::int as count from person_revisions where person_id is not null`).toEqual([{ count: 0 }]);
    expect(await sql`select before from person_revisions where id = ${original}`).toEqual([
      { before: { type: "person", personId: person, fullName: "Abuela" } }
    ]);
    expect(await sql`select relationship_id is not null as kept from person_revisions where id = ${relationshipRevision}`).toEqual([
      { kept: true }
    ]);
    // A removal request can still find all history about the deleted person (the WP-4.1 purge query).
    const aboutPerson = sql`
      select count(*)::int as count from person_revisions
      where person_id = ${person} or ${person} in (before ->> 'personId', after ->> 'personId',
        before ->> 'fromPersonId', before ->> 'toPersonId', after ->> 'fromPersonId', after ->> 'toPersonId')
    `;
    expect(await aboutPerson).toEqual(revisionCount);

    // The PII comment is on the table.
    expect(await sql`select obj_description('person_revisions'::regclass, 'pg_class') like '%PII%' as commented`).toEqual([
      { commented: true }
    ]);
  });
});

describe("migration 0005 (WhatsApp carry-over, data only)", () => {
  /** One user + profile in the 0004 shape; returns the user id. */
  async function member(
    email: string,
    profile: { phone: string | null; showPhone: boolean; whatsapp?: string; visibility?: Record<string, boolean> }
  ): Promise<string> {
    const userId = await insertId(sql`insert into users (email, display_name) values (${email}, 'Prima') returning id`);
    await sql`
      insert into profiles (user_id, full_name, phone, show_phone, whatsapp, contact_visibility)
      values (${userId}, ${email}, ${profile.phone}, ${profile.showPhone}, ${profile.whatsapp ?? null}, ${JSON.stringify(profile.visibility ?? {})}::jsonb)
    `;
    return userId;
  }

  const contactsOf = async (userId: string): Promise<unknown> =>
    (await sql`select phone, show_phone, whatsapp, contact_visibility from profiles where user_id = ${userId}`)[0];

  it("uses the same E.164 pattern as the WhatsApp CHECK", async () => {
    const file = await readFile(join(migrationsFolder, "0005_whatsapp_carryover.sql"), "utf8");
    expect(file).toContain(`'${E164_PATTERN}'`);
  });

  it("copies E.164 phones to WhatsApp with the phone's visibility, leaves everything else alone, and is idempotent", async () => {
    await migrate(drizzle(sql), { migrationsFolder: upTo0004Folder });

    const shown = await member("shown@example.test", { phone: "+525550100101", showPhone: true });
    const hidden = await member("hidden@example.test", { phone: "+525550100102", showPhone: false });
    const legacy = await member("legacy@example.test", { phone: "55 5010 0103", showPhone: true });
    const noPhone = await member("nophone@example.test", { phone: null, showPhone: true });
    const ownWhatsapp = await member("own@example.test", {
      phone: "+525550100104",
      showPhone: true,
      whatsapp: "+12025550199",
      visibility: { whatsapp: false }
    });
    const keptKey = await member("kept@example.test", {
      phone: "+525550100105",
      showPhone: true,
      visibility: { whatsapp: false, instagram: true }
    });
    const before = {
      legacy: await contactsOf(legacy),
      noPhone: await contactsOf(noPhone),
      ownWhatsapp: await contactsOf(ownWhatsapp)
    };

    await migrate(drizzle(sql), { migrationsFolder });
    expect(await sql`select count(*)::int as count from drizzle.__drizzle_migrations`).toEqual([{ count: latestCount }]);

    // E.164 + shown → WhatsApp copied and shown.
    expect(await contactsOf(shown)).toEqual({
      phone: "+525550100101",
      show_phone: true,
      whatsapp: "+525550100101",
      contact_visibility: { whatsapp: true }
    });
    // E.164 + hidden → copied but hidden.
    expect(await contactsOf(hidden)).toEqual({
      phone: "+525550100102",
      show_phone: false,
      whatsapp: "+525550100102",
      contact_visibility: { whatsapp: false }
    });
    // Legacy phone, no phone and an existing WhatsApp: untouched.
    expect(await contactsOf(legacy)).toEqual(before.legacy);
    expect(await contactsOf(noPhone)).toEqual(before.noPhone);
    expect(await contactsOf(ownWhatsapp)).toEqual(before.ownWhatsapp);
    // An explicit visibility choice is preserved (the number is still carried over).
    expect(await contactsOf(keptKey)).toEqual({
      phone: "+525550100105",
      show_phone: true,
      whatsapp: "+525550100105",
      contact_visibility: { whatsapp: false, instagram: true }
    });

    // Re-running the statement changes nothing.
    const all = "select user_id, phone, show_phone, whatsapp, contact_visibility, updated_at from profiles order by user_id";
    const once = await sql.unsafe(all);
    const statement = await readFile(join(migrationsFolder, "0005_whatsapp_carryover.sql"), "utf8");
    const result = await sql.unsafe(statement);
    expect(result.count).toBe(0);
    expect(await sql.unsafe(all)).toEqual(once);
  });
});

describe("migration 0006 (person.merge revision action, expand-only)", () => {
  it("keeps every existing revision, accepts person.merge afterwards, and still rejects unknown actions", async () => {
    await migrate(drizzle(sql), { migrationsFolder: upTo0005Folder });
    const person = await insertId(sql`insert into people (full_name) values ('Abuela Vega') returning id`);
    const snapshot = JSON.stringify({ type: "person", personId: person });
    const revision = (action: string): Promise<string | undefined> =>
      sqlState(sql`insert into person_revisions (person_id, action, before) values (${person}, ${action}, ${snapshot}::jsonb)`);
    const oldActions = Object.values(PersonRevisionAction).filter((action) => action !== PersonRevisionAction.PersonMerge);
    for (const action of oldActions) expect(await revision(action), action).toBeUndefined();
    expect(await revision(PersonRevisionAction.PersonMerge)).toBe("23514");
    const before = await sql`select id, action, before, after, created_at from person_revisions order by id`;

    await migrate(drizzle(sql), { migrationsFolder });
    expect(await sql`select count(*)::int as count from drizzle.__drizzle_migrations`).toEqual([{ count: latestCount }]);
    expect(await sql`select id, action, before, after, created_at from person_revisions order by id`).toEqual(before);
    const merged = JSON.stringify({ type: "merge", personId: person, id: person, duplicatePersonId: person });
    expect(await sqlState(sql`insert into person_revisions (person_id, action, before) values (${person}, 'person.merge', ${merged}::jsonb)`)).toBeUndefined();
    expect(await revision("person.bogus")).toBe("23514");
    expect(
      await sql`select convalidated from pg_constraint where conname = 'person_revisions_action_check'`
    ).toEqual([{ convalidated: true }]);
  });
});
