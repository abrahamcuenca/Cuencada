import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Database } from "../../src/db/client.js";
import * as schema from "../../src/db/schema.js";
import {
  quoteIdent,
  TEMPLATE_DATABASE_NAME,
  TEST_DATABASE_URL,
  workerDatabaseName,
  workerDatabaseUrl
} from "../env.js";

/** Postgres error codes we expect while several workers clone the template at once. */
const DUPLICATE_DATABASE = "42P04";
const OBJECT_IN_USE = "55006";

let testDb: Database | undefined;
let tableNames: string[] | undefined;

function postgresErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return undefined;
}

/**
 * Create this worker's database from the migrated template if it does not
 * exist yet. Safe to call from every test file: the database survives across
 * files in the same worker and is dropped by the global teardown.
 */
export async function ensureWorkerDatabase(): Promise<void> {
  const name = workerDatabaseName();
  const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    for (let attempt = 1; ; attempt += 1) {
      const existing = await admin`select 1 from pg_database where datname = ${name}`;
      if (existing.length > 0) return;
      try {
        await admin.unsafe(`create database ${quoteIdent(name)} template ${quoteIdent(TEMPLATE_DATABASE_NAME)}`);
        return;
      } catch (error) {
        const code = postgresErrorCode(error);
        if (code === DUPLICATE_DATABASE) return;
        // Another worker may be cloning the template at the same moment.
        if (code === OBJECT_IN_USE && attempt < 20) {
          await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
          continue;
        }
        throw error;
      }
    }
  } finally {
    await admin.end();
  }
}

/**
 * Drizzle client bound to the current worker's database, with the same
 * schema as the application so relational queries work in tests.
 */
export function getTestDb(): Database {
  if (!testDb) {
    const client = postgres(workerDatabaseUrl(), { max: 5, onnotice: () => {} });
    testDb = drizzle(client, { schema });
  }
  return testDb;
}

/** Close the worker's shared test client. Called by the per-file setup. */
export async function closeTestDb(): Promise<void> {
  if (!testDb) return;
  const db = testDb;
  testDb = undefined;
  tableNames = undefined;
  await db.$client.end();
}

async function listTables(db: Database): Promise<string[]> {
  if (!tableNames) {
    const rows = await db.$client<{ tablename: string }[]>`
      select tablename from pg_tables
      where schemaname = 'public' and tablename <> '__drizzle_migrations'
      order by tablename
    `;
    tableNames = rows.map((row) => row.tablename);
  }
  return tableNames;
}

/**
 * Empty every application table (keeping the migrations journal) and reset
 * identity sequences, so each test starts from a migrated but empty schema.
 */
export async function resetDb(): Promise<void> {
  const db = getTestDb();
  const tables = await listTables(db);
  if (tables.length === 0) return;
  const list = tables.map((table) => `public.${quoteIdent(table)}`).join(", ");
  await db.$client.unsafe(`truncate table ${list} restart identity cascade`);
}
