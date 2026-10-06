/**
 * Postgres error classification for Cuencada writes.
 */

const UNIQUE_VIOLATION = "23505";

function pgCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if ("code" in error && typeof error.code === "string") return error.code;
  return undefined;
}

/**
 * True when `error` (or the error Drizzle wrapped in `cause`) is a Postgres
 * unique violation.
 *
 * @param error - Anything thrown by a query.
 * @param constraint - Optional constraint name to match.
 */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth += 1) {
    if (pgCode(current) === UNIQUE_VIOLATION) {
      if (constraint === undefined) return true;
      return "constraint_name" in current && current.constraint_name === constraint;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}
