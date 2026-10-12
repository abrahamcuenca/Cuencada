/**
 * TOTP codes for the e2e journeys (WP-7), computed with the server's own
 * otplib wrapper (SHA-1, 6 digits, 30 s).
 *
 * The API refuses a step it already accepted for that account (replay
 * prevention), and several Playwright workers may log the same admin in
 * within one 30-second step. A tiny file-based tracker in the run directory
 * (shared by every worker, wiped by the harness at start) hands out each
 * step at most once per account: the current step, else the next one (the
 * server accepts ±1 step), else it waits for the clock to move on.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { totpCodeAt } from "../../../apps/server/dist/lib/totp.js";
import { E2E_RUN_DIR } from "../harness/settings.js";

const STEP_MS = 30_000;
const LOCK_STALE_MS = 30_000;
const TRACKER_DIR = join(E2E_RUN_DIR, "totp");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run `task` holding a per-account lock (a directory: `mkdir` is atomic). */
async function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  mkdirSync(TRACKER_DIR, { recursive: true });
  const lock = join(TRACKER_DIR, `${key}.lock`);
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
      if (Date.now() > deadline) throw new Error("nextTotpCode: lock timeout");
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
 * The code of the next step the API has not accepted yet for `account`.
 *
 * @param account - Tracker key (the email).
 * @param secret - Base32 test-only secret.
 */
export async function nextTotpCode(account: string, secret: string): Promise<string> {
  const key = createHash("sha256").update(account).digest("hex").slice(0, 16);
  return withLock(key, async () => {
    const file = join(TRACKER_DIR, `${key}.step`);
    let last = -1;
    try {
      last = Number(readFileSync(file, "utf8"));
    } catch {
      last = -1;
    }
    for (;;) {
      const current = Math.floor(Date.now() / STEP_MS);
      const step = current > last ? current : current + 1 > last ? current + 1 : null;
      if (step !== null) {
        writeFileSync(file, String(step));
        return totpCodeAt(secret, new Date(step * STEP_MS));
      }
      await sleep(1000);
    }
  });
}

/**
 * The code of `secret` right now (for a secret only this journey uses, e.g.
 * one read from the enrollment screen). Still goes through the tracker.
 *
 * @param account - Tracker key.
 * @param secret - Base32 secret.
 */
export function codeFor(account: string, secret: string): Promise<string> {
  return nextTotpCode(account, secret);
}
