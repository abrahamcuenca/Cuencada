import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import {
  quoteIdent,
  TEMPLATE_DATABASE_NAME,
  TEST_DATABASE_URL,
  WORKER_DATABASE_PATTERN,
  withDatabase
} from "./env.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

type AdminClient = postgres.Sql;

function connectAdmin(): AdminClient {
  return postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
}

/** Drop the template and every per-worker database left over from earlier runs. */
async function dropHarnessDatabases(admin: AdminClient): Promise<void> {
  const rows = await admin<{ datname: string }[]>`select datname from pg_database`;
  const names = rows
    .map((row) => row.datname)
    .filter((name) => name === TEMPLATE_DATABASE_NAME || WORKER_DATABASE_PATTERN.test(name));

  for (const name of names) {
    // A template cannot be dropped while flagged as one.
    await admin.unsafe(`alter database ${quoteIdent(name)} with is_template false`);
    await admin.unsafe(`drop database if exists ${quoteIdent(name)} with (force)`);
  }
}

/** Create the template database and apply every Drizzle migration to it. */
async function buildTemplate(admin: AdminClient): Promise<void> {
  await admin.unsafe(`create database ${quoteIdent(TEMPLATE_DATABASE_NAME)}`);

  const templateClient = postgres(withDatabase(TEST_DATABASE_URL, TEMPLATE_DATABASE_NAME), {
    max: 1,
    onnotice: () => {}
  });
  try {
    await migrate(drizzle(templateClient), { migrationsFolder });
  } finally {
    // Cloning fails while anyone is connected to the template.
    await templateClient.end();
  }

  await admin.unsafe(`alter database ${quoteIdent(TEMPLATE_DATABASE_NAME)} with is_template true`);
}

/**
 * Vitest global setup for the server project: build a migrated template
 * database once per run. Workers clone it lazily (see `setup.ts`).
 *
 * @returns Teardown that drops the template and all worker databases.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const admin = connectAdmin();
  try {
    await admin`select 1`;
  } catch (error) {
    await admin.end();
    throw new Error(
      `Cannot reach the test database at ${new URL(TEST_DATABASE_URL).host}. Run "scripts/test-db.sh up" first.`,
      { cause: error }
    );
  }

  try {
    await dropHarnessDatabases(admin);
    await buildTemplate(admin);
  } finally {
    await admin.end();
  }

  return async () => {
    const teardownAdmin = connectAdmin();
    try {
      await dropHarnessDatabases(teardownAdmin);
    } finally {
      await teardownAdmin.end();
    }
  };
}
