/**
 * Shared column builders and CHECK helpers for the Drizzle schema modules.
 * Not a table module: nothing here creates database objects on its own.
 */
import { type SQL, sql } from "drizzle-orm";
import { type CheckBuilder, check, timestamp } from "drizzle-orm/pg-core";

// The column builders below deliberately infer their return types: Drizzle's
// builder types (`NotNull<HasDefault<PgTimestampBuilderInitial<…>>>` plus the
// `$onUpdate` brand) are internal generics, and spelling them out would couple
// the schema to Drizzle's private type layout without adding safety.

/** `created_at timestamptz not null default now()`. */
export function createdAt() {
  return timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
}

/**
 * `updated_at timestamptz not null default now()`, bumped by Drizzle on every
 * `update()` through `$onUpdate`. Raw SQL updates must set it themselves.
 */
export function updatedAt() {
  return timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
}

/** Nullable `timestamptz` column. */
export function timestamptz(name: string) {
  return timestamp(name, { withTimezone: true });
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function quoteIdent(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/**
 * SQL fragment `"column" in ('a', 'b', …)` built from an `as const` union in
 * `@cuencada/types`, so the CHECK constraint always mirrors the contract.
 *
 * @param column - Database column name (snake_case).
 * @param values - Allowed values; must be trusted constants, never user input.
 */
export function inList(column: string, values: readonly string[]): SQL {
  if (values.length === 0) throw new Error(`inList(${column}): empty value list`);
  return sql.raw(`${quoteIdent(column)} in (${values.map(quoteLiteral).join(", ")})`);
}

/**
 * CHECK constraint that restricts a text column to a contract union.
 *
 * @param name - Constraint name.
 * @param column - Database column name.
 * @param union - The `as const` object from `@cuencada/types` (its values are used).
 */
export function checkIn(name: string, column: string, union: Readonly<Record<string, string>>): CheckBuilder {
  return check(name, inList(column, Object.values(union)));
}
