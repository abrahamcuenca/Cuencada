import { afterEach, describe, expect, it, vi } from "vitest";
import { E2E_SEED_ADMIN_EMAIL, E2E_SEED_ADMIN_TEMP_PASSWORD, E2E_SEED_ENV_KEYS, e2eSeedEnv } from "./seedEnv.js";

const DB = "postgresql://cuencada:cuencada@127.0.0.1:55432/cuencada_e2e";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("e2eSeedEnv", () => {
  it("returns only the allowlisted keys", () => {
    expect(Object.keys(e2eSeedEnv(DB)).sort()).toEqual([...E2E_SEED_ENV_KEYS].sort());
  });

  it("ignores vault seed values present in the operator's shell", () => {
    vi.stubEnv("SEED_ADMIN_TEMP_PASSWORD", "real-vault-password-do-not-leak");
    vi.stubEnv("SEED_ADMIN_EMAIL", "real-admin@example.com");
    vi.stubEnv("SEED_WHATSAPP_URL", "https://chat.whatsapp.com/real-invite");
    vi.stubEnv("SEED_DAILY_MESSAGES_FILE", "/tmp/real-messages.txt");

    const env = e2eSeedEnv(DB);

    expect(env.SEED_ADMIN_TEMP_PASSWORD).toBe(E2E_SEED_ADMIN_TEMP_PASSWORD);
    expect(env.SEED_ADMIN_EMAIL).toBe(E2E_SEED_ADMIN_EMAIL);
    expect(env.SEED_WHATSAPP_URL).toMatch(/^https:\/\/[a-z]+\.example\.test\//);
    const serialized = JSON.stringify(env);
    expect(serialized).not.toContain("real-vault-password-do-not-leak");
    expect(serialized).not.toContain("real-admin@example.com");
    expect(serialized).not.toContain("chat.whatsapp.com");
    expect(env).not.toHaveProperty("SEED_DAILY_MESSAGES_FILE");
  });

  it("pins NODE_ENV to test and passes the guarded database URL through", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(e2eSeedEnv(DB)).toMatchObject({ NODE_ENV: "test", DATABASE_URL: DB });
  });

  it("only uses fake example.test links for the member-only seed links", () => {
    const env = e2eSeedEnv(DB);
    for (const key of ["SEED_WHATSAPP_URL", "SEED_EXTERNAL_ALBUM_URL", "SEED_LYRICS_URL", "SEED_PROGRAM_URL"] as const) {
      expect(new URL(env[key]).hostname.endsWith(".example.test")).toBe(true);
    }
  });
});
