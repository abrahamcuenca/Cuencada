/**
 * The exact environment the e2e harness hands to the product seed
 * (`resolveSeedOptions`) [SEC]. An explicit allowlist of e2e-only values,
 * never `process.env`: an operator shell may hold the vault's
 * `SEED_ADMIN_TEMP_PASSWORD`/`SEED_ADMIN_EMAIL` or real `SEED_*_URL` links,
 * which must not reach the e2e database, its screenshots or the traces.
 *
 * Pure (no server imports) so it can be unit-tested.
 */

/** Admin seeded by the product seed in e2e (the public default address, an e2e-only password). */
export const E2E_SEED_ADMIN_EMAIL = "admin@cuencada.com";
/** Temporary password of the product-seeded admin in e2e (fictional, e2e-only). */
export const E2E_SEED_ADMIN_TEMP_PASSWORD = "Temporal-e2e-seed-admin-2027";

/** Fake https links for the seeded edition, so no real (legacy) link reaches the e2e UI or screenshots. */
const FAKE_LINKS = {
  SEED_WHATSAPP_URL: "https://chat.example.test/grupo-e2e",
  SEED_EXTERNAL_ALBUM_URL: "https://album.example.test/e2e",
  SEED_LYRICS_URL: "https://letra.example.test/e2e",
  SEED_PROGRAM_URL: "https://programa.example.test/e2e"
} as const;

/** Every key {@link e2eSeedEnv} may return. */
export const E2E_SEED_ENV_KEYS = [
  "NODE_ENV",
  "DATABASE_URL",
  "SEED_ADMIN_EMAIL",
  "SEED_ADMIN_TEMP_PASSWORD",
  "SEED_WHATSAPP_URL",
  "SEED_EXTERNAL_ALBUM_URL",
  "SEED_LYRICS_URL",
  "SEED_PROGRAM_URL"
] as const satisfies ReadonlyArray<string>;

/**
 * Build the seed environment from constants only (plus the guarded e2e
 * database URL). Nothing is read from `process.env`.
 *
 * @param databaseUrl - The e2e database (already checked by `dbGuard.ts`).
 */
export function e2eSeedEnv(databaseUrl: string): Record<(typeof E2E_SEED_ENV_KEYS)[number], string> {
  return {
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    SEED_ADMIN_EMAIL: E2E_SEED_ADMIN_EMAIL,
    SEED_ADMIN_TEMP_PASSWORD: E2E_SEED_ADMIN_TEMP_PASSWORD,
    ...FAKE_LINKS
  };
}
