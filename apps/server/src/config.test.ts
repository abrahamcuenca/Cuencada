import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  allowedOrigins,
  CONFIG_ENV_KEYS,
  ConfigError,
  DEV_TOTP_ENCRYPTION_KEY,
  decodeTotpKey,
  loadConfig,
  readCredentials
} from "./config.js";

const DEV_ENV = {
  NODE_ENV: "development",
  DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/db",
  JWT_SECRET: "dev-secret-sixteen+"
};

const STRONG_SECRET = "a-production-secret-with-at-least-32-chars";
/** Fictional test-only TOTP key: bytes 0x00..0x1f as hex (32 distinct bytes). */
const TEST_TOTP_KEY = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

const PROD_ENV = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/db",
  JWT_SECRET: STRONG_SECRET,
  APP_BASE_URL: "https://cuencada.com",
  RESEND_API_KEY: "re_test_key",
  MAIL_FROM: "Cuencada <no-reply@cuencada.com>",
  TOTP_ENCRYPTION_KEY: TEST_TOTP_KEY
};

function problemsOf(env: NodeJS.ProcessEnv): string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  return [];
}

describe("loadConfig", () => {
  it("requires NODE_ENV instead of defaulting to development", () => {
    const { NODE_ENV: _omitted, ...withoutNodeEnv } = DEV_ENV;

    expect(problemsOf(withoutNodeEnv)).toEqual(["NODE_ENV: is required: development, test or production"]);
    expect(problemsOf({ ...DEV_ENV, NODE_ENV: "staging" })).toEqual([
      "NODE_ENV: is required: development, test or production"
    ]);
  });

  it("applies development defaults", () => {
    const config = loadConfig(DEV_ENV);

    expect(config.NODE_ENV).toBe("development");
    expect(config.APP_BASE_URL).toBe("http://localhost:5173");
    expect(config.CORS_ORIGIN).toEqual(["http://localhost:5173"]);
    expect(config.DEV_ALLOWED_ORIGINS).toEqual(["http://localhost:5173"]);
    expect(config.COOKIE_SECURE).toBe(false);
    expect(config.TRUST_PROXY).toBe(false);
    expect(config.ACCESS_TOKEN_TTL_SECONDS).toBe(900);
    expect(config.REFRESH_IDLE_DAYS).toBe(30);
    expect(config.REFRESH_ABSOLUTE_DAYS).toBe(90);
    expect(config.SUPPORT_EMAIL).toBe("admin@cuencada.com");
    expect(config.MEDIA_REQUIRE_APPROVAL).toBe(false);
  });

  it("does not carry any seed password (the seed reads its own env)", () => {
    const config = loadConfig({ ...DEV_ENV, SEED_ADMIN_TEMP_PASSWORD: "whatever" });

    expect(Object.keys(config)).not.toContain("SEED_ADMIN_TEMP_PASSWORD");
  });

  it("accepts a valid production environment with secure defaults", () => {
    const config = loadConfig(PROD_ENV);

    expect(config.COOKIE_SECURE).toBe(true);
    expect(config.TRUST_PROXY).toEqual(["loopback"]);
    expect(config.CORS_ORIGIN).toEqual(["https://cuencada.com"]);
    expect(config.DEV_ALLOWED_ORIGINS).toEqual([]);
    expect(allowedOrigins(config)).toEqual(["https://cuencada.com"]);
  });

  it("requires a JWT secret of at least 32 characters in production", () => {
    expect(problemsOf({ ...PROD_ENV, JWT_SECRET: "only-twenty-chars-xx" })).toEqual([
      "JWT_SECRET: must be at least 32 characters in production"
    ]);
  });

  describe("TOTP_ENCRYPTION_KEY (WP-7)", () => {
    it("refuses a missing key in production", () => {
      const { TOTP_ENCRYPTION_KEY: _key, ...withoutKey } = PROD_ENV;
      expect(problemsOf(withoutKey)).toEqual(["TOTP_ENCRYPTION_KEY: is required in production"]);
    });

    it("refuses the public dev placeholder and low-entropy keys in production", () => {
      for (const key of [DEV_TOTP_ENCRYPTION_KEY, "a".repeat(64), Buffer.alloc(32, 7).toString("base64")]) {
        expect(problemsOf({ ...PROD_ENV, TOTP_ENCRYPTION_KEY: key })).toEqual([
          "TOTP_ENCRYPTION_KEY: is too weak for production (use openssl rand -base64 32)"
        ]);
      }
    });

    it("refuses a key that is not 32 bytes in any environment, naming only the key", () => {
      const short = Buffer.alloc(16, 1).toString("base64");
      for (const env of [PROD_ENV, DEV_ENV]) {
        const problems = problemsOf({ ...env, TOTP_ENCRYPTION_KEY: short });
        expect(problems).toEqual([
          "TOTP_ENCRYPTION_KEY: must be 32 bytes, as base64 (openssl rand -base64 32) or 64 hex characters"
        ]);
        expect(problems.join()).not.toContain(short);
      }
    });

    it("accepts base64, base64url and hex keys, and defaults to the placeholder outside production", () => {
      const bytes = decodeTotpKey(TEST_TOTP_KEY);
      expect(bytes?.length).toBe(32);
      expect(decodeTotpKey(bytes?.toString("base64") ?? "")?.equals(bytes ?? Buffer.alloc(0))).toBe(true);
      expect(decodeTotpKey(bytes?.toString("base64url") ?? "")?.equals(bytes ?? Buffer.alloc(0))).toBe(true);
      expect(loadConfig(PROD_ENV).TOTP_ENCRYPTION_KEY).toBe(TEST_TOTP_KEY);
      expect(loadConfig(DEV_ENV).TOTP_ENCRYPTION_KEY).toBe(DEV_TOTP_ENCRYPTION_KEY);
    });
  });

  it("requires RESEND_API_KEY, MAIL_FROM and APP_BASE_URL in production", () => {
    const problems = problemsOf({
      NODE_ENV: "production",
      DATABASE_URL: PROD_ENV.DATABASE_URL,
      JWT_SECRET: STRONG_SECRET,
      RESEND_API_KEY: ""
    });

    expect(problems).toEqual(
      expect.arrayContaining([
        "RESEND_API_KEY: is required in production",
        "MAIL_FROM: is required in production",
        "APP_BASE_URL: is required in production"
      ])
    );
  });

  it("requires https APP_BASE_URL and CORS origins in production", () => {
    const problems = problemsOf({ ...PROD_ENV, APP_BASE_URL: "http://cuencada.com", CORS_ORIGIN: "http://cuencada.com" });

    expect(problems).toEqual(
      expect.arrayContaining([
        "APP_BASE_URL: must be https:// in production",
        "CORS_ORIGIN: origins must be https:// in production"
      ])
    );
  });

  it("parses CORS_ORIGIN as an exact origin list and rejects paths", () => {
    expect(loadConfig({ ...DEV_ENV, CORS_ORIGIN: "https://a.example, https://b.example" }).CORS_ORIGIN).toEqual([
      "https://a.example",
      "https://b.example"
    ]);
    expect(problemsOf({ ...DEV_ENV, CORS_ORIGIN: "https://a.example/app" })[0]).toMatch(/^CORS_ORIGIN:/);
  });

  it("parses TRUST_PROXY forms", () => {
    expect(loadConfig({ ...DEV_ENV, TRUST_PROXY: "true" }).TRUST_PROXY).toBe(true);
    expect(loadConfig({ ...DEV_ENV, TRUST_PROXY: "2" }).TRUST_PROXY).toBe(2);
    expect(loadConfig({ ...DEV_ENV, TRUST_PROXY: "127.0.0.1, ::1" }).TRUST_PROXY).toEqual(["127.0.0.1", "::1"]);
  });

  it("parses boolean flags strictly", () => {
    expect(loadConfig({ ...DEV_ENV, MEDIA_REQUIRE_APPROVAL: "TRUE", COOKIE_SECURE: "1" })).toMatchObject({
      MEDIA_REQUIRE_APPROVAL: true,
      COOKIE_SECURE: true
    });
    expect(problemsOf({ ...DEV_ENV, MEDIA_REQUIRE_APPROVAL: "yes" })[0]).toMatch(/^MEDIA_REQUIRE_APPROVAL:/);
  });

  it("defaults PASSWORD_BREACH_CHECK to on outside test and off under test", () => {
    expect(loadConfig(PROD_ENV)).toMatchObject({ PASSWORD_BREACH_CHECK: "on", PASSWORD_BREACH_MIN_COUNT: 1 });
    expect(loadConfig(DEV_ENV).PASSWORD_BREACH_CHECK).toBe("on");
    expect(loadConfig({ ...DEV_ENV, NODE_ENV: "test" }).PASSWORD_BREACH_CHECK).toBe("off");
    expect(loadConfig({ ...PROD_ENV, PASSWORD_BREACH_CHECK: " OFF " }).PASSWORD_BREACH_CHECK).toBe("off");
    expect(loadConfig({ ...PROD_ENV, PASSWORD_BREACH_CHECK: "" }).PASSWORD_BREACH_CHECK).toBe("on");
  });

  it("rejects an invalid PASSWORD_BREACH_CHECK or threshold", () => {
    expect(problemsOf({ ...PROD_ENV, PASSWORD_BREACH_CHECK: "maybe" })[0]).toMatch(/^PASSWORD_BREACH_CHECK:/);
    expect(problemsOf({ ...PROD_ENV, PASSWORD_BREACH_MIN_COUNT: "0" })[0]).toMatch(/^PASSWORD_BREACH_MIN_COUNT:/);
    expect(loadConfig({ ...PROD_ENV, PASSWORD_BREACH_MIN_COUNT: "5" }).PASSWORD_BREACH_MIN_COUNT).toBe(5);
  });

  it("rejects refresh idle days above the absolute lifetime", () => {
    expect(problemsOf({ ...DEV_ENV, REFRESH_IDLE_DAYS: "100", REFRESH_ABSOLUTE_DAYS: "90" })).toEqual([
      "REFRESH_IDLE_DAYS: must not exceed REFRESH_ABSOLUTE_DAYS"
    ]);
  });

  it("never includes secret values in validation errors", () => {
    const secret = "short-secret";
    const error = (() => {
      try {
        loadConfig({ DATABASE_URL: "", JWT_SECRET: secret, NODE_ENV: "production" });
      } catch (caught) {
        return caught;
      }
      return null;
    })();

    expect(error).toBeInstanceOf(ConfigError);
    expect(String(error)).not.toContain(secret);
  });
});

describe("CONFIG_ENV_KEYS", () => {
  it("lists every key loadConfig returns, so the deploy preflight sees new keys", () => {
    const config = loadConfig(PROD_ENV);
    expect([...CONFIG_ENV_KEYS].sort()).toEqual(Object.keys(config).sort());
    expect(CONFIG_ENV_KEYS).toContain("DATABASE_URL");
    expect(CONFIG_ENV_KEYS).not.toContain("MIGRATE_DATABASE_URL");
  });
});

describe("loadConfig with systemd credentials (CREDENTIALS_DIRECTORY)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A credentials directory holding one file per entry. */
  function credentialDir(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "w24-creds-"));
    dirs.push(dir);
    for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, name), value, { mode: 0o600 });
    return dir;
  }

  const { DATABASE_URL: _db, JWT_SECRET: _jwt, RESEND_API_KEY: _resend, ...PROD_NON_SECRETS } = PROD_ENV;

  it("reads secrets from credential files, dropping one trailing newline", () => {
    const dir = credentialDir({
      DATABASE_URL: "postgresql://app:from-credential@10.0.0.1:5432/db\n",
      JWT_SECRET: `${STRONG_SECRET}\n`,
      RESEND_API_KEY: "re_from_credential"
    });
    const config = loadConfig({ ...PROD_NON_SECRETS, CREDENTIALS_DIRECTORY: dir });
    expect(config.DATABASE_URL).toBe("postgresql://app:from-credential@10.0.0.1:5432/db");
    expect(config.JWT_SECRET).toBe(STRONG_SECRET);
    expect(config.RESEND_API_KEY).toBe("re_from_credential");
  });

  it("reads TOTP_ENCRYPTION_KEY from a credential file (WP-7)", () => {
    const { TOTP_ENCRYPTION_KEY: _key, ...withoutKey } = PROD_ENV;
    const dir = credentialDir({ TOTP_ENCRYPTION_KEY: `${TEST_TOTP_KEY}\n` });
    expect(loadConfig({ ...withoutKey, CREDENTIALS_DIRECTORY: dir }).TOTP_ENCRYPTION_KEY).toBe(TEST_TOTP_KEY);
  });

  it("falls back to the environment when CREDENTIALS_DIRECTORY is unset or empty (development)", () => {
    expect(loadConfig(DEV_ENV).JWT_SECRET).toBe(DEV_ENV.JWT_SECRET);
    expect(loadConfig({ ...DEV_ENV, CREDENTIALS_DIRECTORY: "" }).JWT_SECRET).toBe(DEV_ENV.JWT_SECRET);
  });

  it("refuses a key set both as an environment variable and as a credential, naming only the key", () => {
    const dir = credentialDir({ JWT_SECRET: "credential-secret-value-long-enough-0123" });
    const attempt = () => loadConfig({ ...PROD_ENV, CREDENTIALS_DIRECTORY: dir });
    expect(attempt).toThrow(ConfigError);
    expect(attempt).toThrow(/JWT_SECRET: set both as an environment variable and as a credential/);
    expect(attempt).not.toThrow(/credential-secret-value/);
  });

  it("refuses a credential file that is not a config key, and an unreadable directory", () => {
    const dir = credentialDir({ JWT_SECRETS: "typo" });
    expect(() => readCredentials(dir)).toThrow(/CREDENTIALS_DIRECTORY\/JWT_SECRETS: not a configuration key/);
    expect(() => readCredentials(join(dir, "missing"))).toThrow(/CREDENTIALS_DIRECTORY: cannot be read/);
  });

  it("ignores subdirectories and still applies production validation to credential values", () => {
    const dir = credentialDir({ DATABASE_URL: "postgresql://a:b@h/d", JWT_SECRET: "too-short-but-16+", RESEND_API_KEY: "re" });
    mkdirSync(join(dir, "nested"));
    expect(() => loadConfig({ ...PROD_NON_SECRETS, CREDENTIALS_DIRECTORY: dir })).toThrow(/JWT_SECRET: must be at least 32/);
  });
});
