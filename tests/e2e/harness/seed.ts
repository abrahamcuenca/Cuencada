/**
 * E2E database setup: drop + recreate the dedicated e2e database, apply the
 * real migrations, run the real product seed (admin, 2026 edition, chat
 * rooms) and then add fictional e2e fixtures (one cast per Playwright
 * project, a future 2027 edition with RSVP open, small family trees).
 *
 * Guarded (`dbGuard.ts`): loopback host, `*_e2e` name, the test container's
 * port and the test-cluster marker, all checked before any DROP/CREATE.
 */
import { assertCurrentDatabase, assertTestClusterMarker, type E2eDatabaseTarget, type GuardQuery } from "./dbGuard.js";
import { E2E_SEED_ADMIN_TEMP_PASSWORD, e2eSeedEnv } from "./seedEnv.js";
import { createDatabase, type Database } from "../../../apps/server/dist/db/client.js";
import { runMigrations } from "../../../apps/server/dist/db/migrate.js";
import { hashPassword } from "../../../apps/server/dist/lib/passwords.js";
import { resolveSeedOptions, runSeed } from "../../../apps/server/dist/seed.js";
import {
  ANNOUNCED_YEAR,
  CastRole,
  castMember,
  FUTURE_YEAR,
  familyNames,
  invitedPerson,
  MEMBER_PASSWORD,
  PROJECT_KEYS,
  ProjectKey,
  TEMP_ADMIN_PASSWORD
} from "./people.js";

/**
 * Drop and recreate the e2e database. Static URL checks first, then a live
 * check of the test-cluster marker on the cluster's `postgres` database,
 * both before any DROP/CREATE (see `dbGuard.ts`).
 */
async function recreateDatabase(target: E2eDatabaseTarget): Promise<void> {
  const name = target.database;
  // Canonical URL from parsed fields (no query string: nothing can forge settings per connection).
  const admin = createDatabase({ DATABASE_URL: target.adminUrl }, { max: 1 });
  try {
    await assertTestClusterMarker(guardQuery(admin));
    // `name` matched /^[a-z0-9_]+_e2e$/ above, so quoting it is safe.
    await admin.$client.unsafe(`drop database if exists "${name}" with (force)`);
    await admin.$client.unsafe(`create database "${name}"`);
  } finally {
    await admin.close();
  }
}

type Sql = Database["$client"];

async function insertUser(
  sql: Sql,
  project: ProjectKey,
  role: CastRole,
  hashes: { member: string; temp: string }
): Promise<string> {
  const cast = castMember(project, role);
  const [row] = await sql<{ id: string }[]>`
    insert into users (email, password_hash, display_name, role, status, must_change_password, email_verified_at, password_changed_at)
    values (${cast.email}, ${cast.mustChangePassword ? hashes.temp : hashes.member}, ${cast.displayName}, ${cast.role},
            'active', ${cast.mustChangePassword}, now(), ${cast.mustChangePassword ? null : sql`now()`})
    returning id`;
  if (row === undefined) throw new Error("e2e seed: user insert returned no row");
  await sql`
    insert into profiles (user_id, full_name, city, family_branch, show_city, listed_in_directory)
    values (${row.id}, ${cast.displayName}, ${cast.city}, 'Norte', true, true)`;
  return row.id;
}

/** The fictional 2027 edition: published, in the future, RSVP open, a hotel and a short programa. */
async function seedFutureEdition(sql: Sql): Promise<string> {
  const [edition] = await sql<{ id: string }[]>`
    insert into cuencadas (year, slug, title, starts_at, ends_at, timezone, city, state, country, description,
                           theme_color, is_published, first_published_at, rsvp_deadline)
    values (${FUTURE_YEAR}, ${String(FUTURE_YEAR)}, ${`Cuencada ${FUTURE_YEAR}`},
            '2027-07-10T10:00:00-06:00', '2027-07-14T18:00:00-06:00', 'America/Merida',
            'Pueblo Ejemplo', 'Estado Ejemplo', 'México',
            'Edición de prueba para los tests end-to-end. Todo el contenido es ficticio.',
            '#0b5e55', true, now(), '2027-06-30T23:59:00-06:00')
    returning id`;
  if (edition === undefined) throw new Error("e2e seed: edition insert returned no row");
  const [hotel] = await sql<{ id: string }[]>`
    insert into cuencada_locations (cuencada_id, name, kind, description, sort_order)
    values (${edition.id}, 'Hotel Ejemplo', 'hotel', 'Hotel ficticio para los tests.', 0)
    returning id`;
  await sql`
    insert into cuencada_itinerary_items (cuencada_id, date, title, description, location_id, sort_order)
    values (${edition.id}, '2027-07-10', 'Bienvenida', 'Llegada y registro en el hotel.', ${hotel?.id ?? null}, 0),
           (${edition.id}, '2027-07-11', 'Comida familiar', 'Comida en el jardín.', null, 1)`;
  // Long unbreakable tokens (a URL, a long place name, a long tag): the 320 px overflow gate
  // keeps the programa cards from being pushed wider by content like this (WP-2.2).
  await sql`
    insert into cuencada_itinerary_items (cuencada_id, date, title, description, location_name, tags, sort_order)
    values (${edition.id}, '2027-07-12', 'Recorrido-por-Pueblo-Ejemplo-de-los-Cenotes',
            'Reservas en https://reservas.example.test/cuencada-2027/recorrido-pueblo-ejemplo-cenotes-familia',
            'Embarcadero-Principal-del-Cenote-Ejemplo', ${["bloqueador-biodegradable"]}, 2)`;
  await sql`insert into chat_rooms (kind, cuencada_id, title) values ('cuencada', ${edition.id}, ${`Cuencada ${FUTURE_YEAR}`})`;
  return edition.id;
}

/**
 * The fictional announced edition (WP-3.1a): published without dates or place,
 * so its page shows "Por anunciar", no countdown and no RSVP form. It never
 * becomes Home's featured edition while the dated 2027 one is upcoming.
 */
async function seedAnnouncedEdition(sql: Sql): Promise<void> {
  await sql`
    insert into cuencadas (year, slug, title, timezone, country, description, theme_color, is_published, first_published_at)
    values (${ANNOUNCED_YEAR}, ${String(ANNOUNCED_YEAR)}, ${`Cuencada ${ANNOUNCED_YEAR}`}, 'America/Merida', 'México',
            'Edición anunciada de prueba: la fecha y el lugar aún no se definen.', '#0b5e55', true, now())`;
}

/**
 * Tree people per project: the parent of Ana and Beto, a partner (the edge is
 * left for journey 7), a child without an account whom journey 10 invites
 * (WP-4.2), and a deceased grandparent and great-grandparent above the
 * parent (WP-4.3 tree-photo journey).
 */
async function seedFamily(sql: Sql, project: ProjectKey, anaUserId: string, betoUserId: string): Promise<void> {
  const names = familyNames(project);
  const invited = invitedPerson(project);
  const ana = castMember(project, CastRole.Ana);
  const beto = castMember(project, CastRole.Beto);
  const rows = await sql<{ id: string; full_name: string }[]>`
    insert into people (user_id, full_name, family_branch, birth_year)
    values (${anaUserId}, ${ana.displayName}, 'Norte', 1990),
           (${betoUserId}, ${beto.displayName}, 'Norte', 1992),
           (null, ${names.parent}, 'Norte', 1960),
           (null, ${names.partner}, 'Norte', 1962),
           (null, ${invited.fullName}, 'Norte', 1995)
    returning id, full_name`;
  const ancestors = await sql<{ id: string; full_name: string }[]>`
    insert into people (user_id, full_name, family_branch, birth_year, death_year, deceased)
    values (null, ${names.grandparent}, 'Norte', 1935, 2010, true),
           (null, ${names.greatGrandparent}, 'Norte', 1905, 1980, true)
    returning id, full_name`;
  rows.push(...ancestors);
  const id = (fullName: string): string => {
    const found = rows.find((row) => row.full_name === fullName);
    if (found === undefined) throw new Error("e2e seed: person missing");
    return found.id;
  };
  await sql`
    insert into person_relationships (kind, from_person_id, to_person_id)
    values ('parent_of', ${id(names.parent)}, ${id(ana.displayName)}),
           ('parent_of', ${id(names.parent)}, ${id(beto.displayName)}),
           ('parent_of', ${id(names.parent)}, ${id(invited.fullName)}),
           ('parent_of', ${id(names.grandparent)}, ${id(names.parent)}),
           ('parent_of', ${id(names.greatGrandparent)}, ${id(names.grandparent)})`;
}

/**
 * A scrollable history in the family room from one sender, so other members
 * open a log that overflows and holds none of their own (focusable) messages.
 */
async function seedChatHistory(sql: Sql, senderId: string): Promise<void> {
  const [room] = await sql<{ id: string }[]>`select id from chat_rooms where kind = 'global'`;
  if (room === undefined) throw new Error("e2e seed: global chat room missing");
  for (let index = 0; index < 24; index += 1) {
    await sql`
      insert into chat_messages (room_id, sender_user_id, body, created_at)
      values (${room.id}, ${senderId}, ${`Mensaje de bienvenida número ${index + 1}. ¡Nos vemos en la Cuencada!`},
              now() - make_interval(mins => ${120 - index}))`;
  }
}

/** Adapter from a server DB client to the guard's query signature. */
export function guardQuery(db: Database): GuardQuery {
  return (sql, params = []) => db.$client.unsafe(sql, [...params]);
}

/**
 * Reset the e2e database and load the fixtures.
 *
 * @param target - Checked target from `resolveE2eDatabase` (canonical URLs only).
 */
export async function prepareE2eDatabase(target: E2eDatabaseTarget): Promise<void> {
  await recreateDatabase(target);

  // The migrator opens its own connection with the same canonical URL; check where it lands first.
  const probe = createDatabase({ DATABASE_URL: target.url }, { max: 1 });
  try {
    await assertCurrentDatabase(guardQuery(probe), target.database);
  } finally {
    await probe.close();
  }
  await runMigrations(target.url);

  const db = createDatabase({ DATABASE_URL: target.url }, { max: 1 });
  try {
    await assertCurrentDatabase(guardQuery(db), target.database);
    // An explicit allowlist, never process.env: an operator shell may hold vault seed values (Security L1).
    const seedEnv = e2eSeedEnv(target.url);
    if (seedEnv.SEED_ADMIN_TEMP_PASSWORD !== E2E_SEED_ADMIN_TEMP_PASSWORD) throw new Error("e2e seed: unexpected seed env");
    await runSeed(db, resolveSeedOptions(seedEnv));
  } finally {
    await db.close();
  }

  const fixtures = createDatabase({ DATABASE_URL: target.url }, { max: 1 });
  const sql = fixtures.$client;
  try {
    await assertCurrentDatabase(guardQuery(fixtures), target.database);
    const hashes = { member: await hashPassword(MEMBER_PASSWORD), temp: await hashPassword(TEMP_ADMIN_PASSWORD) };
    const editionId = await seedFutureEdition(sql);
    await seedAnnouncedEdition(sql);
    for (const project of PROJECT_KEYS) {
      const ids = new Map<CastRole, string>();
      for (const role of Object.values(CastRole)) ids.set(role, await insertUser(sql, project, role, hashes));
      const anaId = ids.get(CastRole.Ana);
      const betoId = ids.get(CastRole.Beto);
      if (anaId === undefined || betoId === undefined) throw new Error("e2e seed: cast incomplete");
      await seedFamily(sql, project, anaId, betoId);
      // Beto is going, so the attendees block is never empty.
      await sql`insert into cuencada_rsvps (cuencada_id, user_id, status, guest_count) values (${editionId}, ${betoId}, 'yes', 1)`;
      if (project === ProjectKey.Desktop) {
        const adminId = ids.get(CastRole.Admin);
        if (adminId === undefined) throw new Error("e2e seed: cast incomplete");
        await seedChatHistory(sql, adminId);
      }
    }
  } finally {
    await fixtures.close();
  }
}
