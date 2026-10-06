import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotEnv } from "dotenv";
import { z } from "zod";

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(serverRoot, "../..");

loadDotEnv({ path: [resolve(repoRoot, ".env"), resolve(serverRoot, ".env")], quiet: true });

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(3006),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16),
  SEED_ADMIN_EMAIL: z.string().email().default("admin@cuencada.com"),
  SEED_ADMIN_TEMP_PASSWORD: z.string().min(12).default("Password123!"),
  S3_ENDPOINT: z.string().optional().default(""),
  S3_REGION: z.string().optional().default("us-southeast-1"),
  S3_BUCKET: z.string().optional().default(""),
  S3_ACCESS_KEY_ID: z.string().optional().default(""),
  S3_SECRET_ACCESS_KEY: z.string().optional().default(""),
  S3_PUBLIC_BASE_URL: z.string().optional().default("")
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return configSchema.parse(env);
}
