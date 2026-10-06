import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { AppConfig } from "../config.js";
import * as schema from "./schema/index.js";

/** Schema-typed Drizzle client used by the app, seed and tests. */
export type Database = PostgresJsDatabase<typeof schema> & { $client: postgres.Sql };

/** A {@link Database} that owns its connection pool and can release it. */
export type ClosableDatabase = Database & {
  /** End the underlying postgres-js pool (waits for in-flight queries). */
  close(): Promise<void>;
};

/** Options for {@link createDatabase}. */
export interface CreateDatabaseOptions {
  /** Pool size; defaults to 10. CLIs (seed, migrate) should use 1. */
  max?: number;
}

/**
 * Open a postgres-js pool and wrap it in a schema-typed Drizzle client.
 *
 * @param config - Anything carrying `DATABASE_URL` (an `AppConfig` works).
 * @param options - Pool options.
 * @returns The client plus `close()` to end the pool.
 */
export function createDatabase(
  config: Pick<AppConfig, "DATABASE_URL">,
  options: CreateDatabaseOptions = {}
): ClosableDatabase {
  const client = postgres(config.DATABASE_URL, { max: options.max ?? 10, onnotice: () => {} });
  const db = drizzle(client, { schema });
  return Object.assign(db, { close: () => client.end() });
}
