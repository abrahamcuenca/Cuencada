/**
 * Database schema barrel. Ownership: only WP-0.3 (migration 0001) and WP-2.1
 * (migration 0002) change files in this folder; Phase 1 tracks file schema
 * requests instead. Conventions: `text` + CHECK mirrored from the `as const`
 * unions in `@cuencada/types` (no pg enums), deliberate `onDelete` on every FK,
 * an index on every FK used in lookups, `updated_at` via `$onUpdate`.
 */
export * from "./audit.js";
export * from "./auth.js";
export * from "./chat.js";
export * from "./cuencadas.js";
export * from "./media.js";
export * from "./people.js";
export * from "./profiles.js";
export * from "./relations.js";
export * from "./rsvp.js";
