import { describe, expect, it } from "vitest";
import { allowedOrigins, ConfigError, loadConfig } from "./config.js";

const DEV_ENV = {
  DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/db",
  JWT_SECRET: "dev-secret-sixteen+"
};

const STRONG_SECRET = "a-production-secret-with-at-least-32-chars";

const PROD_ENV = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/db",
  JWT_SECRET: STRONG_SECRET,
  APP_BASE_URL: "https://cuencada.com",
  RESEND_API_KEY: "re_test_key",
  MAIL_FROM: "Cuencada <no-reply@cuencada.com>"
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
