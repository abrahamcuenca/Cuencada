import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotEnv } from "dotenv";
import { z } from "zod";

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(serverRoot, "../..");

loadDotEnv({ path: [resolve(repoRoot, ".env"), resolve(serverRoot, ".env")], quiet: true });

/** Minimum `JWT_SECRET` length in production (HS256 wants >= 256 bits of key material). */
export const PRODUCTION_JWT_SECRET_MIN_LENGTH = 32;

/** The Vite dev server origin, allowed for CORS/CSRF outside production. */
export const VITE_DEV_ORIGIN = "http://localhost:5173";

/** Boolean env flag: `true`/`false`/`1`/`0` (case-insensitive). Anything else is a config error. */
const envBoolean = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.enum(["true", "false", "1", "0"]))
  .transform((value) => value === "true" || value === "1");

/** Treat an empty env var (`FOO=`) as unset so defaults apply. */
function blankAsUndefined(value: unknown): unknown {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

/** `true` when `value` is exactly a URL origin (`scheme://host[:port]`, no path, no trailing slash). */
function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value;
  } catch {
    return false;
  }
}

/** Comma-separated list of exact origins, e.g. `https://cuencada.com,https://www.cuencada.com`. */
const originList = z
  .string()
  .transform((value) =>
    value
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0)
  )
  .refine((origins) => origins.every(isOrigin), {
    error: "must be a comma-separated list of exact origins (scheme://host[:port], no path)"
  });

/**
 * Fastify `trustProxy`: `true`/`false`, a hop count, or a comma-separated list
 * of addresses/CIDRs/keywords understood by `proxy-addr` (e.g. `loopback`).
 */
export type TrustProxySetting = boolean | number | string[];

const trustProxy = z
  .string()
  .trim()
  .transform((value): TrustProxySetting => {
    const lower = value.toLowerCase();
    if (lower === "true") return true;
    if (lower === "false" || lower === "") return false;
    if (/^\d+$/.test(lower)) return Number(lower);
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  });

/** Every environment variable the server reads, before production rules and defaults. */
const configObject = z.object({
  /** Required, no default: a missing value must not fail open into development behaviour. */
  NODE_ENV: z.enum(["development", "test", "production"], {
    error: "is required: development, test or production"
  }),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(3006),
  LOG_LEVEL: z
    .preprocess(blankAsUndefined, z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).optional())
    .default("info"),
  /**
   * Public base URL of the SPA (links in emails, CSP `connect-src` for
   * `wss:`). Defaults to the Vite dev origin outside production.
   */
  APP_BASE_URL: z.preprocess(blankAsUndefined, z.url().optional()),
  /** Exact origins allowed for CORS and the CSRF `Origin` check. Defaults to `APP_BASE_URL`'s origin. */
  CORS_ORIGIN: z.preprocess(blankAsUndefined, originList.optional()),
  /** Extra origins allowed **only outside production** (the Vite dev server). */
  DEV_ALLOWED_ORIGINS: z.preprocess(blankAsUndefined, originList.optional()).default([VITE_DEV_ORIGIN]),
  /** Defaults to `loopback` in production (nginx on the same host), otherwise `false`. */
  TRUST_PROXY: z.preprocess(blankAsUndefined, trustProxy.optional()),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_IDLE_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  REFRESH_ABSOLUTE_DAYS: z.coerce.number().int().min(1).max(365).default(90),
  /** Defaults to `true` in production, `false` otherwise (plain-http localhost). */
  COOKIE_SECURE: z.preprocess(blankAsUndefined, envBoolean.optional()),
  RESEND_API_KEY: z.preprocess(blankAsUndefined, z.string().min(1).optional()),
  /** Sender, e.g. `Cuencada <no-reply@cuencada.com>`. */
  MAIL_FROM: z.preprocess(blankAsUndefined, z.string().min(3).max(200).optional()),
  SUPPORT_EMAIL: z.preprocess(blankAsUndefined, z.email().optional()).default("admin@cuencada.com"),
  /** When true, new gallery uploads start as `pending_review` instead of `approved`. */
  MEDIA_REQUIRE_APPROVAL: z.preprocess(blankAsUndefined, envBoolean.optional()).default(false),
  /**
   * Breached-password check (HIBP k-anonymity, `lib/breachedPasswords.ts`):
   * `on` or `off`. Defaults to `off` under `NODE_ENV=test` (tests inject a
   * fake fetcher and turn it on explicitly) and `on` everywhere else.
   */
  PASSWORD_BREACH_CHECK: z.preprocess(
    blankAsUndefined,
    z.string().trim().toLowerCase().pipe(z.enum(["on", "off"])).optional()
  ),
  /** Reject a password seen in at least this many breaches (ASVS 2.1.7 default: 1). */
  PASSWORD_BREACH_MIN_COUNT: z.preprocess(blankAsUndefined, z.coerce.number().int().min(1).max(1_000_000).optional()).default(1),
  S3_ENDPOINT: z.string().optional().default(""),
  S3_REGION: z.string().optional().default("us-east-1"),
  S3_BUCKET: z.string().optional().default(""),
  S3_ACCESS_KEY_ID: z.string().optional().default(""),
  S3_SECRET_ACCESS_KEY: z.string().optional().default(""),
  S3_PUBLIC_BASE_URL: z.string().optional().default("")
});

/**
 * Names of every environment variable {@link loadConfig} reads. The deploy
 * preflight (`apps/server/deploy/preflight.ts`) checks that each one is mapped
 * in `infra/project.yml`, so a new key can't ship with only its dev default.
 */
export const CONFIG_ENV_KEYS: readonly string[] = Object.keys(configObject.shape);

const configSchema = configObject
  .superRefine((env, ctx) => {
    if (env.REFRESH_IDLE_DAYS > env.REFRESH_ABSOLUTE_DAYS) {
      ctx.addIssue({
        code: "custom",
        path: ["REFRESH_IDLE_DAYS"],
        message: "must not exceed REFRESH_ABSOLUTE_DAYS"
      });
    }
    if (env.NODE_ENV !== "production") return;

    if (env.JWT_SECRET.length < PRODUCTION_JWT_SECRET_MIN_LENGTH) {
      ctx.addIssue({
        code: "custom",
        path: ["JWT_SECRET"],
        message: `must be at least ${PRODUCTION_JWT_SECRET_MIN_LENGTH} characters in production`
      });
    }
    for (const key of ["RESEND_API_KEY", "MAIL_FROM", "APP_BASE_URL"] as const) {
      if (env[key] === undefined) {
        ctx.addIssue({ code: "custom", path: [key], message: "is required in production" });
      }
    }
    if (env.APP_BASE_URL !== undefined && !env.APP_BASE_URL.startsWith("https://")) {
      ctx.addIssue({ code: "custom", path: ["APP_BASE_URL"], message: "must be https:// in production" });
    }
    for (const origin of env.CORS_ORIGIN ?? []) {
      if (!origin.startsWith("https://")) {
        ctx.addIssue({ code: "custom", path: ["CORS_ORIGIN"], message: "origins must be https:// in production" });
        break;
      }
    }
  })
  .transform((env) => {
    const production = env.NODE_ENV === "production";
    const appBaseUrl = env.APP_BASE_URL ?? VITE_DEV_ORIGIN;
    const corsOrigins = env.CORS_ORIGIN ?? [new URL(appBaseUrl).origin];
    return {
      ...env,
      APP_BASE_URL: appBaseUrl,
      CORS_ORIGIN: corsOrigins,
      DEV_ALLOWED_ORIGINS: production ? [] : env.DEV_ALLOWED_ORIGINS,
      TRUST_PROXY: env.TRUST_PROXY ?? (production ? ["loopback"] : false),
      COOKIE_SECURE: env.COOKIE_SECURE ?? production,
      PASSWORD_BREACH_CHECK: env.PASSWORD_BREACH_CHECK ?? (env.NODE_ENV === "test" ? "off" : "on")
    };
  });

/** Validated server configuration. Never log it: it carries secrets. */
export type AppConfig = z.infer<typeof configSchema>;

/** Raised when the environment fails validation. The message names keys only, never values. */
export class ConfigError extends Error {
  /** `KEY: problem` lines, safe to print. */
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Invalid server configuration:\n  ${problems.join("\n  ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

/**
 * Read systemd credentials (`LoadCredential=`, WP-2.4). In production the
 * secrets are not `Environment=` lines, which any local user can read through
 * `systemctl show`. They are files in `$CREDENTIALS_DIRECTORY`, one per config
 * key, named after the key. One trailing newline is dropped.
 *
 * @param directory - `CREDENTIALS_DIRECTORY`; unset or empty means no credentials (development).
 * @returns Config values keyed by name.
 * @throws ConfigError when the directory can't be read, or holds a file that
 *   is not a config key (names only, never values).
 */
export function readCredentials(directory: string | undefined): Record<string, string> {
  if (directory === undefined || directory.trim() === "") return {};
  let names: string[];
  try {
    names = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    throw new ConfigError(["CREDENTIALS_DIRECTORY: cannot be read"]);
  }
  const unknown = names.filter((name) => !CONFIG_ENV_KEYS.includes(name));
  if (unknown.length > 0) {
    throw new ConfigError(unknown.map((name) => `CREDENTIALS_DIRECTORY/${name}: not a configuration key`));
  }
  const values: Record<string, string> = {};
  for (const name of names) {
    values[name] = readFileSync(join(directory, name), "utf8").replace(/\r?\n$/, "");
  }
  return values;
}

/**
 * Parse and validate the server configuration. Values come from the
 * environment, plus the credential files in `CREDENTIALS_DIRECTORY` when it is
 * set (systemd `LoadCredential=`). Each key may come from only one of the two.
 *
 * @param env - Environment to read; defaults to `process.env` (after `.env` files are loaded).
 * @returns The validated config with production defaults applied.
 * @throws ConfigError naming the offending keys (never their values).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const credentials = readCredentials(env.CREDENTIALS_DIRECTORY);
  const duplicated = Object.keys(credentials).filter((key) => env[key] !== undefined && env[key] !== "");
  if (duplicated.length > 0) {
    throw new ConfigError(duplicated.map((key) => `${key}: set both as an environment variable and as a credential`));
  }
  const result = configSchema.safeParse({ ...env, ...credentials });
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    );
  }
  return result.data;
}

/**
 * Every origin allowed to call the API with credentials: the configured
 * origins plus, outside production, the dev origins.
 *
 * @param config - Validated config.
 */
export function allowedOrigins(config: Pick<AppConfig, "CORS_ORIGIN" | "DEV_ALLOWED_ORIGINS">): string[] {
  return [...new Set([...config.CORS_ORIGIN, ...config.DEV_ALLOWED_ORIGINS])];
}
