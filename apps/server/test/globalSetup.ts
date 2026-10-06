import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type { TestProject } from "vitest/node";
import { migrationsFolder } from "../src/db/migrate.js";
import {
  createRunId,
  parseHarnessDatabaseName,
  quoteIdent,
  RUN_ID_KEY,
  TEST_DATABASE_URL,
  templateDatabaseName,
  withDatabase
} from "./env.js";

/** Harness databases from other runs are only reclaimed after this long. */
const STALE_AFTER_SECONDS = 60 * 60;

type AdminClient = postgres.Sql;

function connectAdmin(): AdminClient {
  return postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
}

/** Names of all harness databases currently on the cluster, with their run id and creation time. */
async function listHarnessDatabases(
  admin: AdminClient
): Promise<Array<{ name: string; runId: string; createdAtSeconds: number }>> {
  const rows = await admin<{ datname: string }[]>`select datname from pg_database`;
  const result: Array<{ name: string; runId: string; createdAtSeconds: number }> = [];
  for (const { datname } of rows) {
    const parsed = parseHarnessDatabaseName(datname);
    if (parsed) result.push({ name: datname, ...parsed });
  }
  return result;
}

/**
 * Reclaim databases abandoned by crashed or killed runs: older than
 * {@link STALE_AFTER_SECONDS} and with no open connection. Never uses
 * `WITH (FORCE)`; a database someone reconnects to in the meantime is skipped.
 */
async function dropStaleDatabases(admin: AdminClient): Promise<void> {
  const cutoff = Math.floor(Date.now() / 1000) - STALE_AFTER_SECONDS;
  const candidates = (await listHarnessDatabases(admin)).filter((db) => db.createdAtSeconds < cutoff);

  for (const { name } of candidates) {
    const active = await admin`select 1 from pg_stat_activity where datname = ${name} limit 1`;
    if (active.length > 0) continue;
    try {
      await admin.unsafe(`drop database if exists ${quoteIdent(name)}`);
    } catch {
      // Someone connected between the check and the drop; leave it for later.
    }
  }
}

/** Drop every database belonging to `runId`. Only this run's workers can be connected. */
async function dropRunDatabases(admin: AdminClient, runId: string): Promise<void> {
  const own = (await listHarnessDatabases(admin)).filter((db) => db.runId === runId);
  for (const { name } of own) {
    await admin.unsafe(`drop database if exists ${quoteIdent(name)} with (force)`);
  }
}

/** Create this run's template database and apply every Drizzle migration to it. */
async function buildTemplate(admin: AdminClient, runId: string): Promise<void> {
  const name = templateDatabaseName(runId);
  await admin.unsafe(`create database ${quoteIdent(name)}`);

  const templateClient = postgres(withDatabase(TEST_DATABASE_URL, name), { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(templateClient), { migrationsFolder });
  } finally {
    // Cloning fails while anyone is connected to the template.
    await templateClient.end();
  }
}

/**
 * Vitest global setup for the server project: build a migrated template
 * database for this run and hand the run id to workers, which clone it
 * lazily (see `setup.ts`). Safe to run concurrently with other test runs
 * against the same cluster.
 *
 * @param project - The server test project; used to `provide` the run id.
 * @returns Teardown that drops only this run's databases.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const runId = createRunId();
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
    await dropStaleDatabases(admin);
    await buildTemplate(admin, runId);
  } catch (error) {
    await dropRunDatabases(admin, runId);
    throw error;
  } finally {
    await admin.end();
  }

  project.provide(RUN_ID_KEY, runId);

  return async () => {
    const teardownAdmin = connectAdmin();
    try {
      await dropRunDatabases(teardownAdmin, runId);
    } finally {
      await teardownAdmin.end();
    }
  };
}
