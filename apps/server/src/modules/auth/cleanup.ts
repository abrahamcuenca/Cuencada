/**
 * Periodic purge of spent auth rows (TL review, PR #14). Batched and
 * idempotent; safe to run from several processes at once.
 *
 * - `magic_links` used or expired more than {@link SPENT_TOKEN_RETENTION_DAYS} ago.
 * - `refresh_tokens` older than {@link SPENT_TOKEN_RETENTION_DAYS} whose
 *   **session is dead** (revoked or expired). Used tokens of live sessions are
 *   kept on purpose: presenting an old rotated token must still trigger reuse
 *   detection and revoke the session (a thief's chain), however old it is.
 *   They are bounded by the session's 90-day lifetime and go with it.
 * - `sessions` revoked or expired more than {@link DEAD_SESSION_RETENTION_DAYS}
 *   ago (their refresh tokens cascade).
 */
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Database } from "../../db/client.js";

/** Keep used/expired email and refresh tokens this long (future config). */
export const SPENT_TOKEN_RETENTION_DAYS = 7;
/** Keep revoked/expired sessions this long, for the session list and audits (future config). */
export const DEAD_SESSION_RETENTION_DAYS = 30;
/** How often the purge runs (future config). */
export const AUTH_CLEANUP_INTERVAL_MS = 6 * 60 * 60_000;
/** Rows deleted per statement. */
export const AUTH_CLEANUP_BATCH = 1000;

const DAY_MS = 24 * 60 * 60_000;

/** Rows removed by one {@link purgeSpentAuthRows} run. */
export interface AuthCleanupResult {
  magicLinks: number;
  refreshTokens: number;
  sessions: number;
}

async function deleteInBatches(run: () => Promise<number>): Promise<number> {
  let total = 0;
  for (;;) {
    const deleted = await run();
    total += deleted;
    if (deleted < AUTH_CLEANUP_BATCH) return total;
  }
}

/**
 * Delete spent auth rows as of `now`.
 *
 * @param db - Root client.
 * @param now - Current time (`app.clock`).
 */
export async function purgeSpentAuthRows(db: Database, now: Date): Promise<AuthCleanupResult> {
  const tokenCutoff = new Date(now.getTime() - SPENT_TOKEN_RETENTION_DAYS * DAY_MS).toISOString();
  const sessionCutoff = new Date(now.getTime() - DEAD_SESSION_RETENTION_DAYS * DAY_MS).toISOString();
  const nowIso = now.toISOString();

  const magicLinks = await deleteInBatches(async () => {
    const rows = await db.execute(sql`
      delete from magic_links where id in (
        select id from magic_links
        where used_at < ${tokenCutoff}::timestamptz or expires_at < ${tokenCutoff}::timestamptz
        limit ${AUTH_CLEANUP_BATCH}
      ) returning id`);
    return rows.length;
  });

  const sessions = await deleteInBatches(async () => {
    const rows = await db.execute(sql`
      delete from sessions where id in (
        select id from sessions
        where revoked_at < ${sessionCutoff}::timestamptz
           or idle_expires_at < ${sessionCutoff}::timestamptz
           or absolute_expires_at < ${sessionCutoff}::timestamptz
        limit ${AUTH_CLEANUP_BATCH}
      ) returning id`);
    return rows.length;
  });

  const refreshTokens = await deleteInBatches(async () => {
    const rows = await db.execute(sql`
      delete from refresh_tokens where id in (
        select t.id from refresh_tokens t
        join sessions s on s.id = t.session_id
        where t.created_at < ${tokenCutoff}::timestamptz
          and (s.revoked_at is not null
               or s.idle_expires_at <= ${nowIso}::timestamptz
               or s.absolute_expires_at <= ${nowIso}::timestamptz)
        limit ${AUTH_CLEANUP_BATCH}
      ) returning id`);
    return rows.length;
  });

  return { magicLinks, refreshTokens, sessions };
}

/**
 * Run {@link purgeSpentAuthRows} every {@link AUTH_CLEANUP_INTERVAL_MS}. The
 * timer is unref'd (never keeps the process alive) and cleared on close.
 *
 * @param app - The auth module's instance (db, clock, log).
 */
export function registerAuthCleanup(app: FastifyInstance): void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    purgeSpentAuthRows(app.db, app.clock.now())
      .then((result) => app.log.info({ event: "auth.cleanup", ...result }, "purged spent auth rows"))
      .catch((error: unknown) => app.log.error({ err: error }, "auth cleanup failed"))
      .finally(() => {
        running = false;
      });
  }, AUTH_CLEANUP_INTERVAL_MS);
  timer.unref();
  app.addHook("onClose", async () => {
    clearInterval(timer);
  });
}
