/**
 * Guard for `drizzle.config.ts` [SEC]: `drizzle-kit push` and `drizzle-kit
 * drop` change a database without a reviewed migration (push can drop
 * columns and data). The schema is applied only through migrations
 * (`db:migrate`). The guard lets them run only with an explicit opt-in
 * (`ALLOW_DRIZZLE_PUSH=1`) against a loopback database, so a production or
 * shared `DATABASE_URL` can never be pushed to by accident.
 */

/** drizzle-kit subcommands that bypass migrations. */
const DANGEROUS_COMMANDS: ReadonlySet<string> = new Set(["push", "drop"]);

const PUSH_REFUSED_HELP =
  "apply schema changes only through migrations (pnpm --filter @cuencada/server db:generate, then db:migrate). " +
  "For a throwaway local database only, set ALLOW_DRIZZLE_PUSH=1 with a localhost/127.0.0.1/::1 DATABASE_URL.";

/** Hostnames that point at the local machine. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "::1", "[::1]"]);

/**
 * Whether a database URL points at the local machine (`localhost`,
 * `127.0.0.0/8`, `::1`). Unparseable URLs are not loopback.
 *
 * @param databaseUrl - A `postgres://` connection string.
 */
export function isLoopbackDatabaseUrl(databaseUrl: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(databaseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (LOOPBACK_HOSTS.has(hostname)) return true;
  return /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

/**
 * The dangerous drizzle-kit subcommand in `argv`, if any. drizzle-kit is
 * invoked as `node <bin> <command> …`, so the command is any argument after
 * the script path that is not a flag.
 *
 * @param argv - `process.argv`.
 */
export function dangerousDrizzleCommand(argv: readonly string[]): string | undefined {
  return argv.slice(2).find((arg) => DANGEROUS_COMMANDS.has(arg));
}

/**
 * Throw when drizzle-kit was invoked for `push`/`drop` without
 * `ALLOW_DRIZZLE_PUSH=1` or against a non-loopback database.
 *
 * @param argv - `process.argv`.
 * @param env - `process.env` (reads `ALLOW_DRIZZLE_PUSH`).
 * @param databaseUrl - The URL drizzle-kit would connect to.
 * @throws Error naming the command; the message never includes the URL (it holds a password).
 */
export function assertDrizzleCommandAllowed(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  databaseUrl: string
): void {
  const command = dangerousDrizzleCommand(argv);
  if (command === undefined) return;
  if (env.ALLOW_DRIZZLE_PUSH === "1" && isLoopbackDatabaseUrl(databaseUrl)) return;
  throw new Error(`drizzle-kit ${command} is disabled: ${PUSH_REFUSED_HELP}`);
}
