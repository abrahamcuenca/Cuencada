import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotEnv } from "dotenv";
import { defineConfig } from "drizzle-kit";

const serverRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(serverRoot, "../..");

loadDotEnv({ path: [resolve(repoRoot, ".env"), resolve(serverRoot, ".env")], quiet: true });

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL ?? ""
  }
});
