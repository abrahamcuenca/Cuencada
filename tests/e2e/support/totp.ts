/**
 * TOTP codes for the e2e journeys (WP-7), computed with the server's own
 * otplib wrapper (SHA-1, 6 digits, 30 s).
 *
 * The API refuses a step it already accepted for an account (replay
 * prevention, covered by the server tests), and several Playwright workers
 * log the same admin in within one 30-second step. So a code is answered
 * under a per-account lock shared by every worker (a directory in the run
 * directory, which the harness wipes at start), and, test-only, the
 * account's replay marker (`user_totp.last_used_step`) is cleared in the
 * isolated `*_e2e` database first (reached only through the harness guard:
 * `resolveE2eDatabase`'s canonical URL, the test-cluster catalog marker and
 * `current_database()`), like the server tests' `freshTotpCode`.
 * The lock is held until the API answered, so no two answers of one account
 * ever race.
 */
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { totpCodeAt } from "../../../apps/server/dist/lib/totp.js";
import { assertCurrentDatabase, assertTestClusterMarker, type GuardQuery, resolveE2eDatabase } from "../harness/dbGuard.js";
import { E2E_DATABASE_URL, E2E_RUN_DIR } from "../harness/settings.js";

const LOCK_STALE_MS = 60_000;
const LOCK_DIR = join(E2E_RUN_DIR, "totp-locks");

let checked: Promise<postgres.Sql> | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The e2e database, through the same guard as the harness: the canonical URL
 * from `resolveE2eDatabase` (loopback, the test container's port, a `*_e2e`
 * name, no query string), then the test-cluster catalog marker and
 * `current_database()`, checked once before any write.
 */
function database(): Promise<postgres.Sql> {
  checked ??= (async () => {
    const target = resolveE2eDatabase(E2E_DATABASE_URL);
    // Short idle timeout: the connection closes between logins, so a worker can always exit.
    const sql = postgres(target.url, { max: 1, idle_timeout: 2, onnotice: () => {} });
    const query: GuardQuery = (text, params = []) => sql.unsafe(text, [...params]);
    await assertTestClusterMarker(query);
    await assertCurrentDatabase(query, target.database);
    return sql;
  })();
  return checked;
}

/**
 * Run `task` holding the account's lock (a directory: `mkdir` is atomic
 * across processes). A lock older than a minute is treated as abandoned.
 *
 * @param account - The email.
 * @param task - Generate and submit the code.
 */
export async function withAccountLock<T>(account: string, task: () => Promise<T>): Promise<T> {
  mkdirSync(LOCK_DIR, { recursive: true });
  const lock = join(LOCK_DIR, createHash("sha256").update(account).digest("hex").slice(0, 16));
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true });
      } catch {
        // Released meanwhile.
      }
      if (Date.now() > deadline) throw new Error("totp helper: lock timeout");
      await sleep(100);
    }
  }
  try {
    return await task();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * The current code of `secret`, after clearing the account's replay marker
 * (test-only; call it inside {@link withAccountLock} and submit before releasing).
 *
 * @param account - The email.
 * @param secret - Base32 test-only secret.
 */
export async function freshCode(account: string, secret: string): Promise<string> {
  const sql = await database();
  await sql`
    update user_totp set last_used_step = null
    where user_id = (select id from users where lower(email) = ${account.toLowerCase()})`;
  return totpCodeAt(secret, new Date());
}
