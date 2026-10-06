/**
 * Postgres error classification for family-tree writes. Drizzle wraps the
 * driver error in `cause`, so the walk looks a few levels deep.
 */

/** SQLSTATE codes the family module maps to client errors. */
export const PgErrorCode = {
  UniqueViolation: "23505",
  ForeignKeyViolation: "23503",
  CheckViolation: "23514"
} as const;
export type PgErrorCode = (typeof PgErrorCode)[keyof typeof PgErrorCode];

/** The parts of a Postgres error the module branches on. */
export interface PgErrorInfo {
  code: string;
  constraint: string | undefined;
}

/**
 * Extract the SQLSTATE and constraint name from `error` or its `cause` chain.
 *
 * @param error - Anything thrown by a query.
 * @returns The code and constraint, or `undefined` when no Postgres error is found.
 */
export function pgErrorInfo(error: unknown): PgErrorInfo | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth += 1) {
    if ("code" in current && typeof current.code === "string" && /^[0-9A-Z]{5}$/.test(current.code)) {
      const constraint =
        "constraint_name" in current && typeof current.constraint_name === "string" ? current.constraint_name : undefined;
      return { code: current.code, constraint };
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}
