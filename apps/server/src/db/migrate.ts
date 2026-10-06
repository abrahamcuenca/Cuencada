/**
 * Production migrator. Built to `dist/db/migrate.js` and run with plain
 * `node` (no drizzle-kit, which is a devDependency):
 *
 *   MIGRATE_DATABASE_URL=… node dist/db/migrate.js
 *
 * The target is `MIGRATE_DATABASE_URL`, falling back to `DATABASE_URL`. Never
 * prints the URL (it carries the password).
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/**
 * Absolute path of `apps/server/drizzle`. Resolves the same from
 * `src/db/migrate.ts` (tsx, tests) and `dist/db/migrate.js` (production).
 */
export const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

/** Pick the migration target from the environment. */
export function resolveMigrationUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.MIGRATE_DATABASE_URL || env.DATABASE_URL;
  if (!url) throw new Error("Set MIGRATE_DATABASE_URL (or DATABASE_URL) to the database to migrate.");
  return url;
}

/**
 * Apply every pending migration in {@link migrationsFolder} inside the
 * drizzle migrator's transaction, then close the connection.
 *
 * @param databaseUrl - Postgres connection string of the target database.
 */
export async function runMigrations(databaseUrl: string): Promise<void> {
  const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    await client.end();
  }
}

/** Describe the target without credentials, e.g. `127.0.0.1:15432/cuencada`. */
function describeTarget(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    return `${url.host}${url.pathname}`;
  } catch {
    return "(unparseable URL)";
  }
}

async function main(): Promise<void> {
  const url = resolveMigrationUrl();
  process.stdout.write(`migrate: applying migrations from ${migrationsFolder} to ${describeTarget(url)}\n`);
  await runMigrations(url);
  process.stdout.write("migrate: done\n");
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`migrate: failed: ${message}\n`);
    process.exitCode = 1;
  });
}
