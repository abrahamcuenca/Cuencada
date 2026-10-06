import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotEnv } from "dotenv";
import { defineConfig } from "drizzle-kit";
import { assertDrizzleCommandAllowed } from "./src/db/drizzle-guard";

const serverRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(serverRoot, "../..");

loadDotEnv({ path: [resolve(repoRoot, ".env"), resolve(serverRoot, ".env")], quiet: true });

const databaseUrl = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL ?? "";

// [SEC] `drizzle-kit push`/`drop` bypass migrations. Refused unless
// ALLOW_DRIZZLE_PUSH=1 and the database is on loopback (see drizzle-guard.ts).
assertDrizzleCommandAllowed(process.argv, process.env, databaseUrl);

export default defineConfig({
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl
  }
});
