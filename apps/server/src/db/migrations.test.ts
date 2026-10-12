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
 * 0004, migration 0006 (wider revision action CHECK) from 0005, migration
 * 0007 (historical editions) from 0006, and the events migration (WP-5.2,
 * 0008) from the migration just before it (found by tag), and the WP-6.0
 * social/tree/memories migration (0010) from WP-5.3's notices migration
 * (also found by tag). The scratch
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
let upTo0001Folder: string;
let upTo0002Folder: string;
let upTo0003Folder: string;
let upTo0004Folder: string;
let upTo0005Folder: string;
let upTo0006Folder: string;
/** Every migration before the events one (WP-5.2). */
let beforeEventsFolder: string;
/** Every migration up to and including the events one (before WP-5.3's 0009). */
let throughEventsFolder: string;
/** Every migration up to and including WP-5.3's notices migration (before WP-6.0's 0010). */
let throughNoticesFolder: string;
/** Every migration up to and including WP-6.0's 0010 (before WP-7's two-factor migration). */
let throughSocialFolder: string;
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
  upTo0006Folder = await migrationsUpTo(7);
  const journal = JSON.parse(await readFile(join(migrationsFolder, "meta", "_journal.json"), "utf8")) as Journal; // drizzle-kit's own file shape
  latestCount = journal.entries.length;
  const eventsIndex = journal.entries.findIndex((entry) => entry.tag.endsWith("_events"));
  if (eventsIndex < 1) throw new Error("events migration not found in the journal");
  beforeEventsFolder = await migrationsUpTo(eventsIndex);
  throughEventsFolder = await migrationsUpTo(eventsIndex + 1);
  const noticesIndex = journal.entries.findIndex((entry) => entry.tag.endsWith("_event_notices_admin_views"));
  if (noticesIndex < 1) throw new Error("event notices migration not found in the journal");
  throughNoticesFolder = await migrationsUpTo(noticesIndex + 1);
  const socialIndex = journal.entries.findIndex((entry) => entry.tag.endsWith("_social_tree_memories"));
  if (socialIndex < 1) throw new Error("social migration not found in the journal");
  throughSocialFolder = await migrationsUpTo(socialIndex + 1);
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
  if (upTo0006Folder) await rm(upTo0006Folder, { recursive: true, force: true });
  if (beforeEventsFolder) await rm(beforeEventsFolder, { recursive: true, force: true });
  if (throughEventsFolder) await rm(throughEventsFolder, { recursive: true, force: true });
  if (throughNoticesFolder) await rm(throughNoticesFolder, { recursive: true, force: true });
  if (throughSocialFolder) await rm(throughSocialFolder, { recursive: true, force: true });
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

    // Existing rows are byte-for-byte unchanged (columns added by later migrations aside).
    const after = await sql`select * from cuencadas order by year`;
    expect(after.map(({ is_historical: _laterColumn, ...rest }) => rest)).toEqual(before);
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

describe("migration 0007 (historical editions, expand-only)", () => {
  it("upgrades a seeded 0006 database: existing editions read is_historical = false, rows otherwise unchanged", async () => {
    await migrate(drizzle(sql), { migrationsFolder: upTo0006Folder });
    // Rows in the 0006 shape: a dated published edition with a chat room, an undated past one and a draft.
    const dated = await insertId(sql`
      insert into cuencadas (year, slug, title, starts_at, ends_at, city, state, description, is_published, first_published_at)
      values (2025, '2025', 'Cuencada 2025', '2025-09-13T19:30:00-06:00', '2025-09-18T12:00:00-06:00',
              'Ciudad Ficticia', 'Estado Ficticio', 'Reunión', true, '2025-01-15T12:00:00Z')
      returning id
    `);
    await sql`insert into chat_rooms (kind, cuencada_id, title) values ('cuencada', ${dated}, 'Cuencada 2025')`;
    await sql`
      insert into cuencadas (year, slug, title, description, is_published, first_published_at)
      values (2019, '2019', 'Cuencada 2019', 'Fechas desconocidas', true, now())
    `;
    await sql`insert into cuencadas (year, slug, title, description) values (2027, '2027', 'Cuencada 2027', 'Borrador')`;
    expect(await sql`select column_name from information_schema.columns where table_name = 'cuencadas' and column_name = 'is_historical'`).toEqual([]);
    const before = await sql`select * from cuencadas order by year`;

    await migrate(drizzle(sql), { migrationsFolder });
    expect(await sql`select count(*)::int as count from drizzle.__drizzle_migrations`).toEqual([{ count: latestCount }]);

    // Every existing row is unchanged apart from the new column, which reads false.
    const after = await sql`select * from cuencadas order by year`;
    expect(after.map(({ is_historical: _flag, ...rest }) => rest)).toEqual(before);
    expect(after.map((row) => row.is_historical)).toEqual([false, false, false]);
    expect(await sql`select count(*)::int as count from chat_rooms where cuencada_id = ${dated}`).toEqual([{ count: 1 }]);

    // The column is NOT NULL with a false default; 0006-era inserts (without the column) keep working.
    expect(
      await sql`select is_nullable, column_default from information_schema.columns where table_name = 'cuencadas' and column_name = 'is_historical'`
    ).toEqual([{ is_nullable: "NO", column_default: "false" }]);
    await sql`insert into cuencadas (year, slug, title, description) values (2018, '2018', 'Cuencada 2018', 'Sin bandera')`;
    expect(await sql`select is_historical from cuencadas where year = 2018`).toEqual([{ is_historical: false }]);
    await sql`
      insert into cuencadas (year, slug, title, description, is_published, is_historical)
      values (2017, '2017', 'Cuencada 2017', 'Antes del portal', true, true)
    `;
    expect(await sql`select is_historical from cuencadas where year = 2017`).toEqual([{ is_historical: true }]);
    expect(await sqlState(sql`update cuencadas set is_historical = null where year = 2017`)).toBe("23502");
  });
});

describe("migration events (WP-5.2, expand-only)", () => {
  const selectOldRooms = "select id, kind, cuencada_id, title, created_at from chat_rooms order by kind";
  const selectOldMedia =
    "select id, cuencada_id, uploaded_by_user_id, kind, object_key, bucket, thumb_key, display_key, file_name, mime_type, " +
    "byte_size, upload_status, moderation_status, deleted_at, created_at, updated_at from media_items order by object_key";

  /** A user, a published edition with its room, the global room, a message and two media rows (one soft-deleted). */
  async function seedOldShape(): Promise<{ userId: string; cuencadaId: string; roomId: string }> {
    const userId = await insertId(sql`insert into users (email, display_name) values ('ana@example.test', 'Ana') returning id`);
    const cuencadaId = await insertId(sql`
      insert into cuencadas (year, slug, title, description, is_published, first_published_at)
      values (2026, '2026', 'Cuencada 2026', 'Reunión', true, now()) returning id
    `);
    await sql`insert into chat_rooms (kind, title) values ('global', 'Chat familiar')`;
    const roomId = await insertId(sql`
      insert into chat_rooms (kind, cuencada_id, title) values ('cuencada', ${cuencadaId}, 'Cuencada 2026') returning id
    `);
    await sql`insert into chat_messages (room_id, sender_user_id, body) values (${roomId}, ${userId}, 'Hola')`;
    await sql`
      insert into media_items (cuencada_id, uploaded_by_user_id, kind, object_key, bucket, file_name, mime_type, byte_size, upload_status)
      values (${cuencadaId}, ${userId}, 'image', 'cuencadas/2026/originals/a.jpg', 'b', 'a.jpg', 'image/jpeg', 100, 'ready')
    `;
    await sql`
      insert into media_items (cuencada_id, kind, object_key, bucket, file_name, mime_type, byte_size, deleted_at)
      values (${cuencadaId}, 'video', 'cuencadas/2026/originals/b.mp4', 'b', 'b.mp4', 'video/mp4', 100, now())
    `;
    return { userId, cuencadaId, roomId };
  }

  /** A published participants-only event with an organizer, its album, chat room (one message) and a pending cover upload. */
  async function seedEvent(userId: string): Promise<{ eventId: string; albumId: string; roomId: string }> {
    const eventId = await insertId(sql`
      insert into events (slug, year, title, starts_at, ends_at, visibility, status, first_published_at, created_by_user_id)
      values ('viaje-cdmx', 2026, 'Viaje a Ciudad de México', '2026-11-20T10:00:00-06:00', '2026-11-22T18:00:00-06:00',
              'participants', 'published', now(), ${userId})
      returning id
    `);
    await sql`insert into event_participants (event_id, user_id, role, added_by_user_id) values (${eventId}, ${userId}, 'organizer', ${userId})`;
    const albumId = await insertId(sql`
      insert into event_albums (event_id, title, created_by_user_id) values (${eventId}, 'Fotos', ${userId}) returning id
    `);
    const roomId = await insertId(sql`insert into chat_rooms (kind, event_id) values ('event', ${eventId}) returning id`);
    await sql`insert into chat_messages (room_id, sender_user_id, body) values (${roomId}, ${userId}, '¿Quién lleva el pastel?')`;
    await sql`
      insert into event_cover_uploads (event_id, uploaded_by_user_id, object_key, mime_type, byte_size, expires_at)
      values (${eventId}, ${userId}, ${`events/${eventId}/cover/u1.jpg`}, 'image/jpeg', 1000, now() + interval '1 hour')
    `;
    return { eventId, albumId, roomId };
  }

  /** Inserts an album media row; `prefix` defaults to the event layout. */
  function insertAlbumMedia(
    eventId: string,
    albumId: string,
    key: string,
    prefix: string | null = `events/${eventId}/${albumId}`
  ): postgres.PendingQuery<postgres.Row[]> {
    return sql`
      insert into media_items (album_id, storage_prefix, kind, object_key, bucket, file_name, mime_type, byte_size)
      values (${albumId}, ${prefix}, 'image', ${key}, 'b', 'x.jpg', 'image/jpeg', 100)
    `;
  }

  it("upgrades a seeded database: chat rooms, messages and media unchanged, new columns null, old-shape inserts still work", async () => {
    await migrate(drizzle(sql), { migrationsFolder: beforeEventsFolder });
    const { userId, cuencadaId } = await seedOldShape();
    const roomsBefore = await sql.unsafe(selectOldRooms);
    const mediaBefore = await sql.unsafe(selectOldMedia);
    const messagesBefore = await sql`select * from chat_messages`;

    await migrate(drizzle(sql), { migrationsFolder });
    expect(await sql`select count(*)::int as count from drizzle.__drizzle_migrations`).toEqual([{ count: latestCount }]);

    expect(await sql.unsafe(selectOldRooms)).toEqual(roomsBefore);
    expect(await sql`select * from chat_messages`).toEqual(messagesBefore);
    expect(await sql.unsafe(selectOldMedia)).toEqual(mediaBefore);
    expect(await sql`select distinct event_id from chat_rooms`).toEqual([{ event_id: null }]);
    expect(await sql`select distinct album_id, storage_prefix from media_items`).toEqual([{ album_id: null, storage_prefix: null }]);

    // Old code paths: a new edition room and an edition upload without the new columns.
    const cuencada2027 = await insertId(sql`
      insert into cuencadas (year, slug, title, description, is_published, first_published_at)
      values (2027, '2027', 'Cuencada 2027', 'Reunión', true, now()) returning id
    `);
    expect(
      await sqlState(sql`insert into chat_rooms (kind, cuencada_id, title) values ('cuencada', ${cuencada2027}, 'Cuencada 2027')`)
    ).toBeUndefined();
    expect(
      await sqlState(sql`
        insert into media_items (cuencada_id, uploaded_by_user_id, kind, object_key, bucket, file_name, mime_type, byte_size)
        values (${cuencadaId}, ${userId}, 'image', 'cuencadas/2026/originals/c.jpg', 'b', 'c.jpg', 'image/jpeg', 100)
      `)
    ).toBeUndefined();

    const constraints = await sql`
      select conname, convalidated from pg_constraint
      where conname in ('chat_rooms_kind_check', 'chat_rooms_kind_cuencada_check', 'chat_rooms_event_id_events_id_fk',
                        'media_items_scope_check', 'media_items_storage_prefix_check', 'media_items_album_id_event_albums_id_fk')
    `;
    expect(constraints).toHaveLength(6);
    for (const constraint of constraints) expect(constraint.convalidated, String(constraint.conname)).toBe(true);
  });

  it("enforces the events CHECKs: slug, lengths, enums, dates, year from the start date and (year, slug) uniqueness", async () => {
    await migrate(drizzle(sql), { migrationsFolder });
    const insert = (fields: Record<string, string | number | null>): Promise<string | undefined> => {
      const row = { slug: "carne-asada", year: 2026, title: "Carne asada", ...fields };
      return sqlState(sql`insert into events ${sql(row)}`);
    };

    expect(await insert({})).toBeUndefined();
    expect(await insert({})).toBe("23505");
    expect(await insert({ year: 2027 })).toBeUndefined();

    for (const slug of ["ab", "-abc", "abc-", "a--b", "Carne", "méxico", "a b", "x".repeat(61)]) {
      expect(await insert({ slug }), slug).toBe("23514");
    }
    expect(await insert({ slug: "x".repeat(60) })).toBeUndefined();

    expect(await insert({ slug: "t-empty", title: "" })).toBe("23514");
    expect(await insert({ slug: "t-121", title: "x".repeat(121) })).toBe("23514");
    expect(await insert({ slug: "t-120", title: "x".repeat(120) })).toBeUndefined();
    expect(await insert({ slug: "s-281", summary: "x".repeat(281) })).toBe("23514");
    expect(await insert({ slug: "d-4001", details: "x".repeat(4001) })).toBe("23514");
    expect(await insert({ slug: "d-4000", details: "x".repeat(4000) })).toBeUndefined();
    expect(await insert({ slug: "l-161", location_text: "x".repeat(161) })).toBe("23514");
    expect(await insert({ slug: "year-1899", year: 1899 })).toBe("23514");

    expect(await insert({ slug: "vis-bad", visibility: "public" })).toBe("23514");
    expect(await insert({ slug: "st-bad", status: "archived" })).toBe("23514");
    // Published needs `first_published_at`; hidden does not (an admin may hide a draft).
    expect(await insert({ slug: "pub-no-date", status: "published" })).toBe("23514");
    expect(await insert({ slug: "hidden-draft", status: "hidden" })).toBeUndefined();
    expect(await insert({ slug: "cover-half", cover_key: "u1" })).toBe("23514");
    // The cover key must sit under this event's own prefix.
    const [own, other] = await sql<{ id: string }[]>`select id from events order by slug limit 2`;
    if (!own || !other) throw new Error("expected two events");
    const upload = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
    const setCover = (key: string): Promise<string | undefined> =>
      sqlState(sql`update events set cover_key = ${key}, cover_updated_at = now() where id = ${own.id}`);
    expect(await setCover(`events/${own.id}/cover/${upload}-1280.webp`)).toBeUndefined();
    expect(await setCover(`events/${other.id}/cover/${upload}-1280.webp`)).toBe("23514");
    expect(await setCover(`events/${own.id}/cover/${upload}-640.webp`)).toBe("23514");
    expect(await setCover(`events/${own.id}/cover/../x-1280.webp`)).toBe("23514");

    // Dates: both or neither, end after start; year = the start's year in the event's timezone.
    expect(await insert({ slug: "one-date", starts_at: "2026-11-20T10:00:00Z" })).toBe("23514");
    expect(await insert({ slug: "backwards", starts_at: "2026-11-20T10:00:00Z", ends_at: "2026-11-20T09:00:00Z" })).toBe("23514");
    expect(
      await insert({ slug: "wrong-year", year: 2025, starts_at: "2026-11-20T10:00:00Z", ends_at: "2026-11-21T10:00:00Z" })
    ).toBe("23514");
    // 05:00 UTC on Jan 1 2027 is Dec 31 2026 in Mérida.
    expect(
      await insert({ slug: "nochevieja", year: 2026, starts_at: "2027-01-01T05:00:00Z", ends_at: "2027-01-01T08:00:00Z" })
    ).toBeUndefined();
    expect(
      await insert({
        slug: "nochevieja-utc",
        year: 2026,
        timezone: "UTC",
        starts_at: "2027-01-01T05:00:00Z",
        ends_at: "2027-01-01T08:00:00Z"
      })
    ).toBe("23514");
  });

  it("enforces participant roles, album titles, cover upload MIME/size and the chat room kind <-> column rule", async () => {
    await migrate(drizzle(sql), { migrationsFolder });
    const { userId, cuencadaId } = await seedOldShape();
    const { eventId } = await seedEvent(userId);

    const other = await insertId(sql`insert into users (email, display_name) values ('beto@example.test', 'Beto') returning id`);
    expect(await sqlState(sql`insert into event_participants (event_id, user_id, role) values (${eventId}, ${other}, 'guest')`)).toBe(
      "23514"
    );
    expect(await sqlState(sql`insert into event_participants (event_id, user_id) values (${eventId}, ${other})`)).toBeUndefined();
    expect(await sqlState(sql`insert into event_participants (event_id, user_id) values (${eventId}, ${other})`)).toBe("23505");
    expect(await sql`select role, joined_at is not null as joined from event_participants where user_id = ${other}`).toEqual([
      { role: "participant", joined: true }
    ]);

    expect(await sqlState(sql`insert into event_albums (event_id, title) values (${eventId}, '')`)).toBe("23514");
    expect(await sqlState(sql`insert into event_albums (event_id, title) values (${eventId}, ${"x".repeat(81)})`)).toBe("23514");
    expect(await sqlState(sql`insert into event_albums (event_id, title, sort_order) values (${eventId}, 'Día 2', 1001)`)).toBe(
      "23514"
    );

    const upload = (mime: string, size: number, key: string): Promise<string | undefined> =>
      sqlState(sql`
        insert into event_cover_uploads (event_id, object_key, mime_type, byte_size, expires_at)
        values (${eventId}, ${key}, ${mime}, ${size}, now())
      `);
    expect(await upload("image/gif", 10, "k1")).toBe("23514");
    expect(await upload("image/webp", 0, "k2")).toBe("23514");
    expect(await upload("image/webp", 10 * 1024 * 1024 + 1, "k3")).toBe("23514");
    expect(await upload("image/webp", 10 * 1024 * 1024, "k4")).toBeUndefined();
    expect(await upload("image/webp", 10, "k4")).toBe("23505");

    const room = (kind: string, cuencada: string | null, event: string | null): Promise<string | undefined> =>
      sqlState(sql`insert into chat_rooms (kind, cuencada_id, event_id) values (${kind}, ${cuencada}, ${event})`);
    expect(await room("event", null, null)).toBe("23514");
    expect(await room("event", cuencadaId, eventId)).toBe("23514");
    expect(await room("cuencada", cuencadaId, eventId)).toBe("23514");
    expect(await room("global", null, eventId)).toBe("23514");
    expect(await room("party", null, null)).toBe("23514");
    // One room per event.
    expect(await room("event", null, eventId)).toBe("23505");
  });

  it("enforces exactly one media scope and the storage prefix shape", async () => {
    await migrate(drizzle(sql), { migrationsFolder });
    const { userId, cuencadaId } = await seedOldShape();
    const { eventId, albumId } = await seedEvent(userId);

    expect(await sqlState(insertAlbumMedia(eventId, albumId, "k-ok"))).toBeUndefined();
    // Album media needs a prefix, and only the two server layouts are accepted.
    expect(await sqlState(insertAlbumMedia(eventId, albumId, "k-null", null))).toBe("23514");
    expect(await sqlState(insertAlbumMedia(eventId, albumId, "k-dots", "events/../x"))).toBe("23514");
    expect(await sqlState(insertAlbumMedia(eventId, albumId, "k-upper", `events/${eventId.toUpperCase()}/${albumId}`))).toBe("23514");
    expect(await sqlState(insertAlbumMedia(eventId, albumId, "k-trailing", `events/${eventId}/${albumId}/`))).toBe("23514");

    const scoped = (cuencada: string | null, album: string | null, prefix: string | null, key: string): Promise<string | undefined> =>
      sqlState(sql`
        insert into media_items (cuencada_id, album_id, storage_prefix, kind, object_key, bucket, file_name, mime_type, byte_size)
        values (${cuencada}, ${album}, ${prefix}, 'image', ${key}, 'b', 'x.jpg', 'image/jpeg', 100)
      `);
    expect(await scoped(null, null, null, "k-none")).toBe("23514");
    expect(await scoped(cuencadaId, albumId, `events/${eventId}/${albumId}`, "k-both")).toBe("23514");
    expect(await scoped(cuencadaId, null, "cuencadas/2026", "k-edition-prefix")).toBeUndefined();
    expect(await scoped(cuencadaId, null, "cuencadas/26", "k-edition-bad")).toBe("23514");

    expect(
      await sql`select indexdef like '%WHERE (album_id IS NOT NULL)%' as partial from pg_indexes where indexname = 'media_items_album_keyset_idx'`
    ).toEqual([{ partial: true }]);
  });

  it("cascades an event delete to participants, albums, cover uploads and the chat room, but never past album media", async () => {
    await migrate(drizzle(sql), { migrationsFolder });
    const { userId, roomId: editionRoom } = await seedOldShape();
    const { eventId, albumId, roomId } = await seedEvent(userId);
    await insertAlbumMedia(eventId, albumId, "k-album");
    await sql`update media_items set deleted_at = now() where album_id = ${albumId}`;

    // RESTRICT: even a soft-deleted media row blocks the album and the event.
    expect(await sqlState(sql`delete from event_albums where id = ${albumId}`)).toBe("23503");
    expect(await sqlState(sql`delete from events where id = ${eventId}`)).toBe("23503");
    expect(await sql`select count(*)::int as count from events`).toEqual([{ count: 1 }]);

    await sql`delete from media_items where album_id = ${albumId}`;
    await sql`delete from events where id = ${eventId}`;
    for (const table of ["event_participants", "event_albums", "event_cover_uploads"]) {
      expect(await sql.unsafe(`select count(*)::int as count from ${table}`), table).toEqual([{ count: 0 }]);
    }
    expect(await sql`select count(*)::int as count from chat_rooms where id = ${roomId}`).toEqual([{ count: 0 }]);
    expect(await sql`select count(*)::int as count from chat_messages where room_id = ${roomId}`).toEqual([{ count: 0 }]);
    // Edition data is untouched.
    expect(await sql`select count(*)::int as count from chat_messages where room_id = ${editionRoom}`).toEqual([{ count: 1 }]);
    expect(await sql`select count(*)::int as count from media_items where cuencada_id is not null`).toEqual([{ count: 2 }]);
  });

  it("removes a deleted user's participations and keeps their events and albums with the user FKs nulled", async () => {
    await migrate(drizzle(sql), { migrationsFolder });
    const owner = await insertId(sql`insert into users (email, display_name) values ('carla@example.test', 'Carla') returning id`);
    const { eventId, albumId } = await seedEvent(owner);
    const guest = await insertId(sql`insert into users (email, display_name) values ('dani@example.test', 'Dani') returning id`);
    await sql`insert into event_participants (event_id, user_id, added_by_user_id) values (${eventId}, ${guest}, ${owner})`;

    await sql`delete from users where id = ${owner}`;
    expect(await sql`select user_id, added_by_user_id from event_participants where event_id = ${eventId}`).toEqual([
      { user_id: guest, added_by_user_id: null }
    ]);
    expect(await sql`select created_by_user_id from events where id = ${eventId}`).toEqual([{ created_by_user_id: null }]);
    expect(await sql`select created_by_user_id from event_albums where id = ${albumId}`).toEqual([{ created_by_user_id: null }]);
    expect(await sql`select uploaded_by_user_id from event_cover_uploads where event_id = ${eventId}`).toEqual([
      { uploaded_by_user_id: null }
    ]);
  });
});

describe("migration 0009 (WP-5.3 event notices and admin-view dedupe, expand-only)", () => {
  it("adds a nullable notice column without touching participants and a deduping admin-view table that cascades", async () => {
    await migrate(drizzle(sql), { migrationsFolder: throughEventsFolder });
    const admin = await insertId(sql`insert into users (email, display_name, role) values ('admin@example.test', 'Admin', 'admin') returning id`);
    const ana = await insertId(sql`insert into users (email, display_name) values ('ana@example.test', 'Ana') returning id`);
    const eventId = await insertId(sql`
      insert into events (slug, year, title, visibility, status, first_published_at)
      values ('viaje-k7q2', 2026, 'Viaje', 'participants', 'published', now()) returning id
    `);
    await sql`insert into event_participants (event_id, user_id, role, added_by_user_id) values (${eventId}, ${ana}, 'participant', ${admin})`;
    const before = await sql`select event_id, user_id, role, added_by_user_id, joined_at from event_participants`;

    await migrate(drizzle(sql), { migrationsFolder });
    expect(await sql`select count(*)::int as count from drizzle.__drizzle_migrations`).toEqual([{ count: latestCount }]);
    expect(await sql`select event_id, user_id, role, added_by_user_id, joined_at from event_participants`).toEqual(before);
    expect(await sql`select notice_seen_at from event_participants`).toEqual([{ notice_seen_at: null }]);
    // 0008-era inserts (without the column) keep working.
    const bea = await insertId(sql`insert into users (email, display_name) values ('bea@example.test', 'Bea') returning id`);
    await sql`insert into event_participants (event_id, user_id) values (${eventId}, ${bea})`;

    const bucket = "2026-10-11T10:00:00Z";
    await sql`insert into event_admin_views (admin_user_id, event_id, hour_bucket) values (${admin}, ${eventId}, ${bucket})`;
    expect(
      await sqlState(sql`insert into event_admin_views (admin_user_id, event_id, hour_bucket) values (${admin}, ${eventId}, ${bucket})`)
    ).toBe("23505");
    const inserted = await sql`
      insert into event_admin_views (admin_user_id, event_id, hour_bucket) values (${admin}, ${eventId}, ${bucket})
      on conflict do nothing returning event_id
    `;
    expect(inserted).toEqual([]);
    await sql`delete from events where id = ${eventId}`;
    expect(await sql`select count(*)::int as count from event_admin_views`).toEqual([{ count: 0 }]);
  });
});

describe("migration 0010 (WP-6.0 social, notifications, Memory Box, tree links; expand-only)", () => {
  const selectMedia =
    "select id, cuencada_id, album_id, storage_prefix, uploaded_by_user_id, kind, object_key, upload_status, moderation_status, " +
    "deleted_at, created_at, updated_at from media_items order by object_key";

  /** Users, an edition and an event (album + participants in every notice state) and two media rows, in the 0009 shape. */
  async function seed0009(): Promise<{
    admin: string;
    ana: string;
    bea: string;
    cara: string;
    cuencadaId: string;
    eventId: string;
    albumId: string;
  }> {
    const admin = await insertId(sql`insert into users (email, display_name, role) values ('admin@example.test', 'Admin', 'admin') returning id`);
    const ana = await insertId(sql`insert into users (email, display_name) values ('ana@example.test', 'Ana') returning id`);
    const bea = await insertId(sql`insert into users (email, display_name) values ('bea@example.test', 'Bea') returning id`);
    const cara = await insertId(sql`insert into users (email, display_name) values ('cara@example.test', 'Cara') returning id`);
    const cuencadaId = await insertId(sql`
      insert into cuencadas (year, slug, title, description, is_published, first_published_at)
      values (2026, '2026', 'Cuencada 2026', 'Reunión', true, now()) returning id
    `);
    const eventId = await insertId(sql`
      insert into events (slug, year, title, visibility, status, first_published_at, created_by_user_id)
      values ('viaje-k7q2', 2026, 'Viaje', 'participants', 'published', now(), ${admin}) returning id
    `);
    const albumId = await insertId(sql`insert into event_albums (event_id, title) values (${eventId}, 'Fotos') returning id`);
    // Organizer added themself (no notice), Ana added by the admin (pending notice),
    // Bea added but dismissed, Cara self-joined (no adder).
    await sql`insert into event_participants (event_id, user_id, role, added_by_user_id) values (${eventId}, ${admin}, 'organizer', ${admin})`;
    await sql`
      insert into event_participants (event_id, user_id, added_by_user_id, joined_at)
      values (${eventId}, ${ana}, ${admin}, '2026-10-01T12:00:00Z')
    `;
    await sql`insert into event_participants (event_id, user_id, added_by_user_id, notice_seen_at) values (${eventId}, ${bea}, ${admin}, now())`;
    await sql`insert into event_participants (event_id, user_id) values (${eventId}, ${cara})`;
    await sql`
      insert into media_items (cuencada_id, storage_prefix, uploaded_by_user_id, kind, object_key, bucket, file_name, mime_type, byte_size, upload_status)
      values (${cuencadaId}, 'cuencadas/2026', ${ana}, 'image', 'cuencadas/2026/originals/a.jpg', 'b', 'a.jpg', 'image/jpeg', 100, 'ready')
    `;
    const albumPrefix = `events/${eventId}/${albumId}`;
    await sql`
      insert into media_items (album_id, storage_prefix, kind, object_key, bucket, file_name, mime_type, byte_size, deleted_at)
      values (${albumId}, ${albumPrefix}, 'image', ${`${albumPrefix}/originals/b.jpg`}, 'b', 'b.jpg', 'image/jpeg', 100, now())
    `;
    return { admin, ana, bea, cara, cuencadaId, eventId, albumId };
  }

  /** A Memory Box (published by default). */
  function insertMemoryAlbum(title = "Fotos de la abuela", status = "published"): Promise<string> {
    return insertId(sql`insert into memory_albums (title, status) values (${title}, ${status}) returning id`);
  }

  /** A media row in a box; `prefix` defaults to the box's own. */
  function insertMemoryMedia(albumId: string, key: string, prefix: string | null = `memories/${albumId}`): Promise<{ id: string }[]> {
    return sql<{ id: string }[]>`
      insert into media_items (memory_album_id, storage_prefix, kind, object_key, bucket, file_name, mime_type, byte_size)
      values (${albumId}, ${prefix}, 'image', ${key}, 'b', 'x.jpg', 'image/jpeg', 100) returning id
    `;
  }

  /** The id of the seeded edition photo. */
  async function editionMediaId(): Promise<string> {
    return insertId(sql`select id from media_items where cuencada_id is not null`);
  }

  it("upgrades a seeded 0009 database: media unchanged, undismissed event notices become notifications, old-shape writes still work", async () => {
    await migrate(drizzle(sql), { migrationsFolder: throughNoticesFolder });
    const { admin, ana, cuencadaId, eventId, albumId } = await seed0009();
    const mediaBefore = await sql.unsafe(selectMedia);
    const participantsBefore = await sql`select * from event_participants order by user_id`;

    await migrate(drizzle(sql), { migrationsFolder });
    expect(await sql`select count(*)::int as count from drizzle.__drizzle_migrations`).toEqual([{ count: latestCount }]);

    expect(await sql.unsafe(selectMedia)).toEqual(mediaBefore);
    expect(await sql`select distinct memory_album_id from media_items`).toEqual([{ memory_album_id: null }]);
    // The deprecated notice column is kept as it was.
    expect(await sql`select * from event_participants order by user_id`).toEqual(participantsBefore);

    // Exactly Ana's pending notice became a notification, dated when she was added.
    const notifications = await sql`
      select user_id, kind, actor_user_id, media_id, event_id, proposal_id, dedupe_key, count, seen_at,
             (created_at = '2026-10-01T12:00:00Z'::timestamptz and updated_at = created_at) as dated_at_join
      from notifications
    `;
    expect(notifications).toEqual([
      {
        user_id: ana,
        kind: "event_added",
        actor_user_id: admin,
        media_id: null,
        event_id: eventId,
        proposal_id: null,
        dedupe_key: `event:${eventId}`,
        count: 1,
        seen_at: null,
        dated_at_join: true
      }
    ]);
    expect(await sql`select id, root_person_id from family_settings`).toEqual([{ id: true, root_person_id: null }]);

    // 0009-era writes (no memory_album_id) keep working for both scopes.
    expect(
      await sqlState(sql`
        insert into media_items (cuencada_id, kind, object_key, bucket, file_name, mime_type, byte_size)
        values (${cuencadaId}, 'image', 'cuencadas/2026/originals/c.jpg', 'b', 'c.jpg', 'image/jpeg', 100)
      `)
    ).toBeUndefined();
    expect(
      await sqlState(sql`
        insert into media_items (album_id, storage_prefix, kind, object_key, bucket, file_name, mime_type, byte_size)
        values (${albumId}, ${`events/${eventId}/${albumId}`}, 'image', 'k-album-2', 'b', 'd.jpg', 'image/jpeg', 100)
      `)
    ).toBeUndefined();
    const dani = await insertId(sql`insert into users (email, display_name) values ('dani@example.test', 'Dani') returning id`);
    expect(
      await sqlState(sql`insert into event_participants (event_id, user_id, added_by_user_id) values (${eventId}, ${dani}, ${admin})`)
    ).toBeUndefined();

    const constraints = await sql`
      select conname, convalidated from pg_constraint
      where conname in ('media_items_scope_check', 'media_items_storage_prefix_check', 'media_items_memory_prefix_check',
                        'media_items_memory_album_id_memory_albums_id_fk')
    `;
    expect(constraints).toHaveLength(4);
    for (const constraint of constraints) expect(constraint.convalidated, String(constraint.conname)).toBe(true);
    expect(
      await sql`select indexdef like '%WHERE (memory_album_id IS NOT NULL)%' as partial from pg_indexes where indexname = 'media_items_memory_keyset_idx'`
    ).toEqual([{ partial: true }]);
  });

  it("enforces the Memory Box scope: exactly one scope, a prefix pinned to its own box, and the box CHECKs", async () => {
    await migrate(drizzle(sql), { migrationsFolder });
    const { cuencadaId, eventId, albumId } = await seed0009();
    const box = await insertMemoryAlbum();
    const otherBox = await insertMemoryAlbum("Otra caja");

    expect(await sqlState(insertMemoryMedia(box, "m-ok"))).toBeUndefined();
    expect(await sqlState(insertMemoryMedia(box, "m-null", null))).toBe("23514");
    expect(await sqlState(insertMemoryMedia(box, "m-other-box", `memories/${otherBox}`))).toBe("23514");
    expect(await sqlState(insertMemoryMedia(box, "m-events", `events/${eventId}/${albumId}`))).toBe("23514");
    expect(await sqlState(insertMemoryMedia(box, "m-upper", `memories/${box.toUpperCase()}`))).toBe("23514");
    expect(await sqlState(insertMemoryMedia(box, "m-trailing", `memories/${box}/`))).toBe("23514");
    expect(
      await sqlState(sql`
        insert into media_items (cuencada_id, memory_album_id, storage_prefix, kind, object_key, bucket, file_name, mime_type, byte_size)
        values (${cuencadaId}, ${box}, ${`memories/${box}`}, 'image', 'm-two-scopes', 'b', 'x.jpg', 'image/jpeg', 100)
      `)
    ).toBe("23514");
    const ghost = "00000000-0000-4000-8000-000000000000";
    expect(await sqlState(insertMemoryMedia(ghost, "m-ghost"))).toBe("23503");

    const album = (title: string, status = "draft", sortOrder = 0, description: string | null = null): Promise<string | undefined> =>
      sqlState(sql`insert into memory_albums (title, status, sort_order, description) values (${title}, ${status}, ${sortOrder}, ${description})`);
    expect(await album("Caja")).toBeUndefined();
    expect(await album("")).toBe("23514");
    expect(await album("x".repeat(121))).toBe("23514");
    expect(await album("x".repeat(120))).toBeUndefined();
    expect(await album("Caja", "archived")).toBe("23514");
    expect(await album("Caja", "hidden", 1001)).toBe("23514");
    expect(await album("Caja", "hidden", -1)).toBe("23514");
    expect(await album("Caja", "draft", 0, "d".repeat(2001))).toBe("23514");
    expect(await album("Caja", "draft", 0, "d".repeat(2000))).toBeUndefined();
    expect(await sql`select status from memory_albums where title = 'Caja' and description is null`).toEqual([{ status: "draft" }]);
    expect(await sql`select status, sort_order from memory_albums where id = ${box}`).toEqual([{ status: "published", sort_order: 0 }]);
  });

  it("enforces the notification CHECKs: kind, kind-to-target, no self-notification, count and one row per recipient and key", async () => {
    await migrate(drizzle(sql), { migrationsFolder });
    const { admin, ana, bea, eventId } = await seed0009();
    const mediaId = await editionMediaId();
    const from = await insertId(sql`insert into people (full_name) values ('Abuelo Vega') returning id`);
    const to = await insertId(sql`insert into people (full_name) values ('Abuelo J. Vega') returning id`);
    const proposal = await insertId(sql`
      insert into tree_link_proposals (kind, from_person_id, to_person_id, proposed_by_user_id, status, resolved_at)
      values ('same_person', ${from}, ${to}, ${ana}, 'approved', now()) returning id
    `);

    const notify = (
      kind: string,
      target: { media?: string; event?: string; proposal?: string },
      options: { user?: string; actor?: string | null; key?: string | null; count?: number } = {}
    ): Promise<string | undefined> =>
      sqlState(sql`
        insert into notifications (user_id, kind, actor_user_id, media_id, event_id, proposal_id, dedupe_key, count)
        values (${options.user ?? ana}, ${kind}, ${options.actor === undefined ? bea : options.actor}, ${target.media ?? null},
                ${target.event ?? null}, ${target.proposal ?? null}, ${options.key ?? null}, ${options.count ?? 1})
      `);

    expect(await notify("photo_tag_request", { media: mediaId })).toBeUndefined();
    expect(await notify("photo_tagged", { media: mediaId })).toBe("23514");
    expect(await notify("photo_commented", { media: mediaId })).toBeUndefined();
    expect(await notify("photo_liked", { media: mediaId }, { actor: null })).toBeUndefined();
    expect(await notify("event_added", { event: eventId }, { user: bea, actor: admin })).toBeUndefined();
    expect(await notify("tree_proposal_resolved", { proposal }, { actor: admin })).toBeUndefined();

    expect(await notify("photo_shared", { media: mediaId })).toBe("23514");
    expect(await notify("photo_liked", { event: eventId })).toBe("23514");
    expect(await notify("photo_liked", { media: mediaId, event: eventId })).toBe("23514");
    expect(await notify("event_added", { media: mediaId })).toBe("23514");
    expect(await notify("tree_proposal_resolved", { event: eventId })).toBe("23514");
    expect(await notify("photo_liked", {})).toBe("23514");
    // No self-notifications.
    expect(await notify("photo_liked", { media: mediaId }, { user: ana, actor: ana })).toBe("23514");
    expect(await notify("photo_liked", { media: mediaId }, { count: 0 })).toBe("23514");
    expect(await notify("photo_liked", { media: mediaId }, { key: "" })).toBe("23514");
    expect(await notify("photo_liked", { media: mediaId }, { key: "k".repeat(201) })).toBe("23514");

    // One row per (recipient, key); the same key for another recipient, and any number of keyless rows, are fine.
    const key = `like:${mediaId}`;
    expect(await notify("photo_liked", { media: mediaId }, { key })).toBeUndefined();
    expect(await notify("photo_liked", { media: mediaId }, { key })).toBe("23505");
    expect(await notify("photo_liked", { media: mediaId }, { key, user: admin })).toBeUndefined();
    const coalesced = await sql`
      insert into notifications (user_id, kind, actor_user_id, media_id, dedupe_key)
      values (${ana}, 'photo_liked', ${admin}, ${mediaId}, ${key})
      on conflict (user_id, dedupe_key) where dedupe_key is not null
      do update set count = notifications.count + 1, actor_user_id = excluded.actor_user_id, seen_at = null
      returning count, actor_user_id
    `;
    expect(coalesced).toEqual([{ count: 2, actor_user_id: admin }]);
    expect(
      await sql`select indexdef like '%WHERE (seen_at IS NULL)%' as partial from pg_indexes where indexname = 'notifications_user_unseen_idx'`
    ).toEqual([{ partial: true }]);
  });

  it("enforces the tag, like, comment and comment-report CHECKs", async () => {
    await migrate(drizzle(sql), { migrationsFolder });
    const { ana, bea } = await seed0009();
    const mediaId = await editionMediaId();
    const person = await insertId(sql`insert into people (full_name) values ('Ana Morales Vega') returning id`);
    const other = await insertId(sql`insert into people (full_name) values ('Bea Morales Vega') returning id`);

    const tag = (personId: string, x: number | null, y: number | null): Promise<string | undefined> =>
      sqlState(sql`insert into media_tags (media_id, person_id, tagged_by_user_id, x, y) values (${mediaId}, ${personId}, ${ana}, ${x}, ${y})`);
    expect(await tag(person, 0.25, 0.75)).toBeUndefined();
    expect(await tag(person, null, null)).toBe("23505");
    expect(await tag(other, 0.5, null)).toBe("23514");
    expect(await tag(other, 1.5, 0.5)).toBe("23514");
    expect(await tag(other, 0.5, -0.1)).toBe("23514");
    expect(await tag(other, 1, 0)).toBeUndefined();
    // A tag defaults to pending (fail closed); approved <=> approved_at.
    expect(await sql`select x::text, y::text, status, approved_at from media_tags where person_id = ${person}`).toEqual([
      { x: "0.2500", y: "0.7500", status: "pending", approved_at: null }
    ]);
    const setStatus = (status: string, approved: boolean): Promise<string | undefined> =>
      sqlState(sql`
        update media_tags set status = ${status}, approved_at = case when ${approved} then now() end where person_id = ${person}
      `);
    expect(await setStatus("approved", false)).toBe("23514");
    expect(await setStatus("pending", true)).toBe("23514");
    expect(await setStatus("hidden", false)).toBe("23514");
    expect(await setStatus("approved", true)).toBeUndefined();
    expect(await sql`select status from media_tags where person_id = ${person}`).toEqual([{ status: "approved" }]);

    const like = (userId: string): Promise<string | undefined> =>
      sqlState(sql`insert into media_likes (media_id, user_id) values (${mediaId}, ${userId})`);
    expect(await like(ana)).toBeUndefined();
    expect(await like(ana)).toBe("23505");
    expect(await like(bea)).toBeUndefined();

    const comment = (
      body: string,
      options: { author?: string; clientId?: string | null; deleted?: boolean; deletedBy?: string | null } = {}
    ): Promise<string | undefined> =>
      sqlState(sql`
        insert into media_comments (media_id, author_user_id, body, client_comment_id, deleted_at, deleted_by_user_id)
        values (${mediaId}, ${options.author ?? ana}, ${body}, ${options.clientId ?? null},
                case when ${options.deleted === true} then now() end, ${options.deletedBy ?? null})
      `);
    expect(await comment("¡Qué bonita foto!")).toBeUndefined();
    expect(await comment("x".repeat(1000))).toBeUndefined();
    expect(await comment("x".repeat(1001))).toBe("23514");
    expect(await comment("")).toBe("23514");
    expect(await comment("   ")).toBe("23514");
    // Tombstones: an empty body only once deleted; a deleter needs a deletion time.
    expect(await comment("", { deleted: true, deletedBy: ana })).toBeUndefined();
    expect(await comment("  ", { deleted: true })).toBe("23514");
    expect(await comment("Hola", { deletedBy: ana })).toBe("23514");
    // Idempotent sends: one client id per author.
    const clientId = "00000000-0000-4000-8000-0000000000c1";
    expect(await comment("Uno", { clientId })).toBeUndefined();
    expect(await comment("Otra vez", { clientId })).toBe("23505");
    expect(await comment("Mismo id, otra persona", { clientId, author: bea })).toBeUndefined();

    const first = await insertId(sql`select id from media_comments where body = '¡Qué bonita foto!'`);
    const report = (reporter: string, reason: string, details: string | null = null): Promise<string | undefined> =>
      sqlState(sql`insert into comment_reports (comment_id, reporter_user_id, reason, details) values (${first}, ${reporter}, ${reason}, ${details})`);
    expect(await report(bea, "inappropriate")).toBeUndefined();
    expect(await report(bea, "other")).toBe("23505");
    expect(await report(ana, "spam")).toBe("23514");
    expect(await report(ana, "other", "d".repeat(501))).toBe("23514");
  });

  it("enforces the tree-link proposal and family-settings CHECKs", async () => {
    await migrate(drizzle(sql), { migrationsFolder });
    const { ana, bea, admin } = await seed0009();
    const abuelo = await insertId(sql`insert into people (full_name) values ('Abuelo Vega') returning id`);
    const abueloDos = await insertId(sql`insert into people (full_name) values ('Abuelo J. Vega') returning id`);
    const tia = await insertId(sql`insert into people (full_name) values ('Tía Rosa Vega') returning id`);

    const propose = (
      kind: string,
      from: string,
      to: string,
      options: { relation?: string | null; status?: string; resolved?: boolean; note?: string | null; by?: string } = {}
    ): Promise<string | undefined> =>
      sqlState(sql`
        insert into tree_link_proposals (kind, from_person_id, to_person_id, relation, proposed_by_user_id, status, resolved_by_user_id, resolved_at, note)
        values (${kind}, ${from}, ${to}, ${options.relation ?? null}, ${options.by ?? ana}, ${options.status ?? "pending"},
                ${options.resolved === true ? admin : null}, case when ${options.resolved === true} then now() end, ${options.note ?? null})
      `);
    expect(await propose("same_person", abuelo, abueloDos)).toBeUndefined();
    // One pending proposal per proposer and unordered pair, whatever the kind (PR #56 L2).
    expect(await propose("same_person", abueloDos, abuelo)).toBe("23505");
    expect(await propose("relate", abuelo, abueloDos, { relation: "parent_of" })).toBe("23505");
    // Another member's proposal for the same pair is neither blocked nor blocking.
    expect(await propose("same_person", abueloDos, abuelo, { by: bea })).toBeUndefined();
    expect(
      await sql`select count(*)::int as count from tree_link_proposals where least(from_person_id, to_person_id) = least(${abuelo}::uuid, ${abueloDos}::uuid) and status = 'pending'`
    ).toEqual([{ count: 2 }]);
    // Resolved ones do not block a new proposal.
    expect(await propose("relate", abuelo, abueloDos, { relation: "partner_of", status: "rejected", resolved: true })).toBeUndefined();

    expect(await propose("relate", abuelo, tia, { relation: "parent_of" })).toBeUndefined();
    expect(await propose("relate", tia, abueloDos)).toBe("23514");
    expect(await propose("same_person", tia, abueloDos, { relation: "parent_of" })).toBe("23514");
    expect(await propose("relate", tia, abueloDos, { relation: "sibling_of" })).toBe("23514");
    expect(await propose("cousin", tia, abueloDos)).toBe("23514");
    expect(await propose("same_person", tia, tia)).toBe("23514");
    expect(await propose("same_person", tia, abueloDos, { status: "maybe" })).toBe("23514");
    // pending <=> not resolved.
    expect(await propose("same_person", tia, abueloDos, { resolved: true })).toBe("23514");
    expect(await propose("same_person", tia, abueloDos, { status: "approved" })).toBe("23514");
    expect(await propose("same_person", tia, abueloDos, { note: "n".repeat(501) })).toBe("23514");
    expect(
      await sqlState(sql`
        update tree_link_proposals set resolution_note = ${"n".repeat(501)}, status = 'rejected', resolved_at = now()
        where from_person_id = ${abuelo} and to_person_id = ${tia}
      `)
    ).toBe("23514");

    // A single settings row.
    expect(await sqlState(sql`insert into family_settings (id) values (false)`)).toBe("23514");
    expect(await sqlState(sql`insert into family_settings (id) values (true)`)).toBe("23505");
    await sql`update family_settings set root_person_id = ${abuelo}, updated_by_user_id = ${admin}`;
    expect(await sql`select root_person_id from family_settings`).toEqual([{ root_person_id: abuelo }]);
  });

  it("cascades media, event, proposal and user deletes, restricts box deletes and fails closed on a person in a pending proposal", async () => {
    await migrate(drizzle(sql), { migrationsFolder });
    const { admin, ana, bea, cara, eventId } = await seed0009();
    const mediaId = await editionMediaId();
    const tagged = await insertId(sql`insert into people (full_name) values ('Ana Morales Vega') returning id`);
    await sql`insert into media_tags (media_id, person_id, tagged_by_user_id) values (${mediaId}, ${tagged}, ${bea})`;
    await sql`insert into media_likes (media_id, user_id) values (${mediaId}, ${bea})`;
    const commentId = await insertId(sql`insert into media_comments (media_id, author_user_id, body) values (${mediaId}, ${bea}, 'Hola') returning id`);
    await sql`insert into comment_reports (comment_id, reporter_user_id, reason) values (${commentId}, ${ana}, 'other')`;
    await sql`insert into notifications (user_id, kind, actor_user_id, media_id) values (${ana}, 'photo_liked', ${bea}, ${mediaId})`;

    // A removed actor, author or tagger stays as null; their likes go.
    await sql`delete from users where id = ${bea}`;
    expect(await sql`select actor_user_id from notifications where media_id = ${mediaId}`).toEqual([{ actor_user_id: null }]);
    expect(await sql`select author_user_id from media_comments`).toEqual([{ author_user_id: null }]);
    expect(await sql`select tagged_by_user_id from media_tags`).toEqual([{ tagged_by_user_id: null }]);
    expect(await sql`select count(*)::int as count from media_likes`).toEqual([{ count: 0 }]);

    // A media delete takes its tags, likes, comments, their reports and its notifications.
    await sql`delete from media_items where id = ${mediaId}`;
    for (const table of ["media_tags", "media_likes", "media_comments", "comment_reports"]) {
      expect(await sql.unsafe(`select count(*)::int as count from ${table}`), table).toEqual([{ count: 0 }]);
    }
    expect(await sql`select count(*)::int as count from notifications where media_id is not null`).toEqual([{ count: 0 }]);

    // A person delete takes their tags.
    const box = await insertMemoryAlbum();
    const boxMedia = await insertId(insertMemoryMedia(box, "m-cascade"));
    await sql`insert into media_tags (media_id, person_id) values (${boxMedia}, ${tagged})`;
    await sql`delete from people where id = ${tagged}`;
    expect(await sql`select count(*)::int as count from media_tags`).toEqual([{ count: 0 }]);

    // Box delete: RESTRICT while any media row (even soft-deleted) points at it; the cover goes null with its media.
    await sql`update memory_albums set cover_media_id = ${boxMedia} where id = ${box}`;
    await sql`update media_items set deleted_at = now() where id = ${boxMedia}`;
    expect(await sqlState(sql`delete from memory_albums where id = ${box}`)).toBe("23503");
    await sql`delete from media_items where id = ${boxMedia}`;
    expect(await sql`select cover_media_id from memory_albums where id = ${box}`).toEqual([{ cover_media_id: null }]);
    expect(await sqlState(sql`delete from memory_albums where id = ${box}`)).toBeUndefined();

    // An event delete takes its event_added notifications (Ana's migrated one).
    await sql`insert into notifications (user_id, kind, actor_user_id, event_id) values (${ana}, 'event_added', ${admin}, ${eventId})`;
    expect(await sql`select count(*)::int as count from notifications where event_id = ${eventId}`).toEqual([{ count: 1 }]);
    await sql`delete from media_items where album_id is not null`;
    await sql`delete from events where id = ${eventId}`;
    expect(await sql`select count(*)::int as count from notifications`).toEqual([{ count: 0 }]);

    // Proposals: a person in a pending proposal cannot be deleted (fail closed until WP-6.4 withdraws it);
    // a resolved proposal survives the delete with the person nulled; its notification follows the proposal.
    const from = await insertId(sql`insert into people (full_name) values ('Abuelo Vega') returning id`);
    const to = await insertId(sql`insert into people (full_name) values ('Abuelo J. Vega') returning id`);
    const proposal = await insertId(sql`
      insert into tree_link_proposals (kind, from_person_id, to_person_id, proposed_by_user_id)
      values ('same_person', ${from}, ${to}, ${ana}) returning id
    `);
    expect(await sqlState(sql`delete from people where id = ${from}`)).toBe("23514");
    await sql`update tree_link_proposals set status = 'approved', resolved_by_user_id = ${admin}, resolved_at = now() where id = ${proposal}`;
    await sql`insert into notifications (user_id, kind, actor_user_id, proposal_id) values (${ana}, 'tree_proposal_resolved', ${admin}, ${proposal})`;
    await sql`update family_settings set root_person_id = ${from}`;
    await sql`delete from people where id = ${from}`;
    expect(await sql`select from_person_id, to_person_id, status from tree_link_proposals`).toEqual([
      { from_person_id: null, to_person_id: to, status: "approved" }
    ]);
    expect(await sql`select root_person_id from family_settings`).toEqual([{ root_person_id: null }]);
    await sql`delete from users where id = ${admin}`;
    expect(await sql`select resolved_by_user_id from tree_link_proposals`).toEqual([{ resolved_by_user_id: null }]);
    expect(await sql`select actor_user_id from notifications`).toEqual([{ actor_user_id: null }]);
    await sql`delete from tree_link_proposals where id = ${proposal}`;
    expect(await sql`select count(*)::int as count from notifications`).toEqual([{ count: 0 }]);

    // A recipient delete takes their notifications.
    await sql`insert into notifications (user_id, kind, event_id) values (${cara}, 'event_added', ${await insertId(sql`
      insert into events (slug, year, title) values ('cena-a2b3', 2026, 'Cena') returning id
    `)})`;
    await sql`delete from users where id = ${cara}`;
    expect(await sql`select count(*)::int as count from notifications`).toEqual([{ count: 0 }]);
  });
});

describe("migration 0011 (WP-7 two-step verification, expand-only)", () => {
  it("upgrades a 0010 database: sessions keep working and read as not verified; old-shape session writes still work", async () => {
    await migrate(drizzle(sql), { migrationsFolder: throughSocialFolder });
    const admin = await insertId(sql`insert into users (email, display_name, role) values ('admin@example.test', 'Admin', 'admin') returning id`);
    const session = await insertId(sql`
      insert into sessions (user_id, idle_expires_at, absolute_expires_at)
      values (${admin}, now() + interval '1 day', now() + interval '2 days') returning id
    `);

    await migrate(drizzle(sql), { migrationsFolder });
    expect(await sql`select count(*)::int as count from drizzle.__drizzle_migrations`).toEqual([{ count: latestCount }]);
    // Existing sessions are "not verified": admins must enroll on their next request (the gate).
    expect(await sql`select two_factor_verified_at from sessions where id = ${session}`).toEqual([{ two_factor_verified_at: null }]);
    // 0010-era code inserts sessions without the new column.
    await sql`insert into sessions (user_id, idle_expires_at, absolute_expires_at) values (${admin}, now() + interval '1 day', now() + interval '2 days')`;

    // The new tables enforce their rules.
    await sql`insert into user_totp (user_id, secret_ciphertext, secret_iv, secret_tag) values (${admin}, 'c', 'i', 't')`;
    expect(await sqlState(sql`update user_totp set last_used_step = -1`)).toBe("23514");
    const challenge = sql`
      insert into two_factor_challenges (token_hash, user_id, method, expires_at)
      values ('h1', ${admin}, 'password', now() + interval '5 minutes')
    `;
    await challenge;
    expect(await sqlState(sql`update two_factor_challenges set attempts = 6`)).toBe("23514");
    expect(
      await sqlState(sql`insert into two_factor_challenges (token_hash, user_id, method, expires_at) values ('h2', ${admin}, 'sms', now())`)
    ).toBe("23514");
    await sql`insert into user_recovery_codes (user_id, code_hash) values (${admin}, 'r1')`;
    expect(await sqlState(sql`insert into user_recovery_codes (user_id, code_hash) values (${admin}, 'r1')`)).toBe("23505");
    await sql`insert into trusted_devices (user_id, token_hash, user_agent_label, expires_at) values (${admin}, 't1', 'iPhone · Safari', now())`;
    expect(
      await sqlState(sql`insert into trusted_devices (user_id, token_hash, user_agent_label, expires_at) values (${admin}, 't1', 'x', now())`)
    ).toBe("23505");

    // Deleting the user removes every 2FA row.
    await sql`delete from users where id = ${admin}`;
    for (const table of ["user_totp", "user_recovery_codes", "trusted_devices", "two_factor_challenges"]) {
      expect(await sql.unsafe(`select count(*)::int as count from ${table}`), table).toEqual([{ count: 0 }]);
    }
  });
});
