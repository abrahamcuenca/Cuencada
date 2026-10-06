# WP-2.1 Migration 0002 (expand-only)
Owner: Senior JS Backend Engineer (data) · Reviewers: Architect, TL · Branch: wp/2.1-migration-0002 · PR: # (not opened)

Based on `origin/main` (37dd59d: WP-0.4, T1-FE, T2-BE merged).

## Scope
- `apps/server/drizzle/0002_expand_directory_tags_fks.sql`, `meta/0002_snapshot.json`, `meta/_journal.json`.
- Schema: `db/schema/{profiles,cuencadas,rsvp,auth}.ts`.
- Contracts: `packages/types/src/profile.ts`, `packages/types/src/cuencadas.ts` (+ tests).
- Seed: `src/seed.ts` sets `first_published_at` for the seeded (published) 2026 edition (+ assertion in `seed.test.ts`).
- Migration test: `src/db/migrations.test.ts`, new case "migration 0002".
- **Cross-track edits** (needed so the repo typechecks with the amended contract):
  - `apps/server/src/modules/cuencadas/mappers.ts` (T2): `toItineraryItem` maps `tags: row.tags`.
  - `apps/web/src/features/cuencadas/testing/fixtures.ts` (T2-FE, authorized): `makeItinerary` sets `tags: []`.

## Included requests
| # | Change | Source |
|---|---|---|
| 1 | `profiles.listed_in_directory boolean not null default true` ("Aparecer en el directorio") | WP-T3-BE Request 1 (branch `wp/t3-be-rsvp`), also needed by T5 |
| 2 | `cuencadas.first_published_at timestamptz null`, backfilled | WP-T2-BE Request 3 |
| 3 | `cuencada_itinerary_items.tags text[] not null default '{}'`, CHECK `cardinality(tags) <= 6` and no NULL elements | WP-T2-BE Request 1 (for T2-FE R1) |
| 4 | `unique (cuencada_id, id)` on `cuencada_locations`; composite FKs `cuencada_itinerary_items (cuencada_id, location_id)` and `cuencada_rsvps (cuencada_id, hotel_location_id)` → `cuencada_locations (cuencada_id, id)`, `ON DELETE SET NULL (<column>)` | WP-T2-BE Request 2, WP-T3-BE Request 2, WP-0.3 (PG18 answer) |
| 5 | `sessions_revoked_reason_check` gains `logout_all`; `SessionRevokedReason.LogoutAll` in `db/schema/auth.ts` | WP-T1-BE Requests ("0002 migration list") |
| 6 | Directory index on `lower(full_name)`: **not added** (see Decisions) | WP-2.1 brief (optional) |

WP-T4-BE has no 0002 request.

## Why it is expand-only
Production runs the migrator before the new code goes live, so 0001-era code must keep working on a 0002 database:
- **New columns** have constant defaults (`listed_in_directory`, `tags`) or are nullable (`first_published_at`). Old inserts omit them and get the default. With a constant default, `ADD COLUMN` is a metadata-only change on PG11+.
- **New constraints only reject rows the old code never writes.** The services already reject cross-Cuencada locations (T2 and T3 both return 400). Old code never writes `tags`. The `revoked_reason` CHECK is only *widened*: every old value is still allowed.
- **Nothing is dropped, renamed or narrowed.** The old single-column FKs on `location_id` and `hotel_location_id` stay. They are now redundant but harmless; both set the column to null on delete. Dropping them is a contract-phase cleanup for a later migration.
- **Constraints are added `NOT VALID` and then validated** in the same migration (the tables are small). The drizzle migrator runs the whole of 0002 in one transaction, so the `revoked_reason` CHECK drop and re-add has no window without a CHECK, and any failure rolls back to 0001.
- **Data steps:**
  - **`first_published_at` backfill:** set to `created_at` for every edition that is published now **or has its edition chat room**. T2 creates the room on first publish and it survives unpublishing, so this is the "ever published" signal the delete guard used until now. `created_at` stands in because the real publish time was never recorded; it is a stable lower bound. Drafts stay null.
  - **Repair before the composite FKs:** an itinerary item or RSVP whose location belongs to *another* Cuencada is unlinked (column set to null, `updated_at = now()`) instead of failing the migration. Such a reference was already invalid for the services, and none is expected. The migration test covers it.

## Manual-SQL pattern (composite FKs)
Drizzle cannot express `ON DELETE SET NULL (col)`. A plain `SET NULL` on a composite FK would also null `cuencada_id`, which is NOT NULL, so every location delete would fail. The pattern:
- In the schema, declare the FK with `foreignKey({ name, columns, foreignColumns }).onDelete("set null")`, so the snapshot knows about it.
- In the migration, hand-write `ON DELETE SET NULL ("location_id")` / `("hotel_location_id")`. The schema files carry a comment saying so.
- `drizzle-kit generate` diffs the schema against the snapshot, not against the database, so it reports **"No schema changes"**.
- **Do not use `drizzle-kit push` from 0002 on.** Its introspection reports drift that does not exist and would rebuild these constraints wrongly:
  - It lists composite constraint columns in table order, so it reads the unique as `(id, cuencada_id)` and the FK targets as `(id, cuencada_id)`.
  - It misreads the empty-array default as `'{""}'`.
  - It would recreate the FKs with a plain `SET NULL`.

  The database is correct: `pg_get_constraintdef` shows `FOREIGN KEY (cuencada_id, location_id) REFERENCES cuencada_locations(cuencada_id, id) ON DELETE SET NULL (location_id)`. The migrator stays the only way to change the schema (WP-0.3 already deploys this way).
- Future migrations that touch these FKs must hand-edit the generated SQL the same way.

## Contract changes (`packages/types`)
- **`ProfileVisibility.listedInDirectory: boolean`** (also in `profileVisibilitySchema`, so `OwnProfile.visibility` carries it), plus `listedInDirectory` in `updateProfileInputSchema` (optional, as part of the partial patch).
  - `DirectoryEntrySource.visibility` is narrowed to `Pick<ProfileVisibility, "showEmail" | "showPhone" | "showCity">`, so callers that build it from the contact flags only still compile.
  - The `toDirectoryEntry` JSDoc says it ignores the flag: unlisted members must be filtered out by the directory **query**, so they never count in search or pagination.
- **`ItineraryItem.tags: string[]`** (response: ≤ 6, each ≤ 24 chars).
  - New exports: `ITINERARY_TAGS_MAX = 6`, `ITINERARY_TAG_MAX_LENGTH = 24`, `itineraryTagSchema` (trimmed, 1–24 chars), `itineraryTagsSchema` (≤ 6).
  - `createItineraryItemInputSchema.tags` defaults to `[]`; `updateItineraryItemInputSchema.tags` is optional (patch).
  - The DB CHECK uses `ITINERARY_TAGS_MAX`. The per-tag length is a contract rule only, because a CHECK cannot iterate array elements without a helper function.
- Web compatibility: no web code reads `ProfileVisibility`. Itinerary requests built without `tags` still validate (the default is `[]`). Only the `makeItinerary` fixture needed `tags: []`.

## Follow-ups for the tracks
- **T2 (cuencadas):**
  - On publish, set `first_published_at = coalesce(first_published_at, now())`, and never clear it.
  - Switch the delete guard to `first_published_at is null`, keeping the `media_items` check. Until T2 sets the column on publish, an edition first published by 0001-era code after this migration keeps a null `first_published_at`. Keep the chat-room check in the guard (or re-run the backfill `UPDATE`) until T2's publish change has shipped.
  - Tags: create/PATCH already spread the parsed input into the insert/update, so tags are stored. Add route tests, and render/edit them in T2-FE (ProgramaTimeline, ItineraryEditor).
  - The service-level same-Cuencada check can stay for its friendly 400. The DB now answers 23503 if it is bypassed. The manual unlink on location delete is now redundant.
- **T3 (RSVP):**
  - Hide unlisted attendees: `listed_in_directory = false` → "Familiar", `avatarUrl: null`, `userId`/`personId: null`, except on the caller's own row (the plan in WP-T3-BE Decisions).
  - The `hotel_location_id` same-Cuencada rule is now also in the DB; `kind = hotel` stays in the service.
- **T5 (profile/directory):**
  - Expose and persist `listedInDirectory` ("Aparecer en el directorio") on `GET`/`PATCH /api/profile/me`.
  - The directory query must filter `where listed_in_directory`.
  - T6 (family tree) should decide whether the flag applies there too.
- **T1 (auth):** `POST /api/auth/logout-all` revokes with `SessionRevokedReason.LogoutAll` (`logout_all`) instead of `user_revoked`. Deploy it only after 0002 has run; the migrator runs first, as planned.

## Decisions
- **No `lower(full_name)` index on `profiles`.** Directory search is a substring match (`ILIKE '%q%'`), which a btree on `lower(full_name)` cannot serve. It would need `pg_trgm` (an extension, not trivial). `people` already has `people_full_name_lower_idx`, and a family-sized `profiles` table is scanned in microseconds. Revisit with `pg_trgm` if the directory grows.
- **Tags CHECK also forbids NULL elements** (`array_position(tags, null) is null`): it is free and keeps `string[]` honest.
- **No DB rule ties `first_published_at` to `is_published`.** A CHECK such as "published ⇒ set" would break 0001-era publishes during the rollout window, which is not expand-only. A trigger would hide logic from the schema. T2 owns the rule.
- **The seed** sets `first_published_at` when it inserts a published edition, matching what T2 will do on publish.

## Verification (2026-10-06)
- `pnpm lint`, `pnpm turbo run typecheck --force` (6/6), `pnpm test` (77 files, 768 tests) and `pnpm build` (4/4): all green.
- `drizzle-kit generate`: "No schema changes, nothing to migrate".
- Built migrator (`node dist/db/migrate.js`) on a scratch DB (PG16), run twice (the second run was a no-op), then the built seed (`NODE_ENV=test`): the seed inserts everything, and 2026 has `first_published_at` set. `pg_get_constraintdef` confirmed both `ON DELETE SET NULL (<col>)` FKs and the widened CHECK. The scratch DBs (`wp21_scratch*`) were dropped.
- Migration test "migration 0002": 0000 → 0001, then rows in the 0001 shape (published, unpublished-with-room and draft editions; locations in two editions; a valid and a cross-edition itinerary link; an RSVP with a hotel; a session that 0001 refuses to revoke with `logout_all`). Then → 0002, asserting:
  - the backfill (created_at for published and unpublished-with-room, null for the draft)
  - `listed_in_directory` true for old and new profiles
  - tags default `{}`, 6 accepted, 7 → 23514, NULL element → 23514
  - the cross-edition link was unlinked and the valid ones kept
  - another edition's location → 23503 on itinerary insert and on RSVP update
  - deleting a location nulls only `location_id` / `hotel_location_id` (`cuencada_id` intact, RSVP status kept)
  - `logout_all` accepted, old reasons still accepted, unknown reasons → 23514

## Open questions (→ orchestrator)
- None blocking. Confirm that nobody relies on `drizzle-kit push` (see the Manual-SQL pattern).

## Review log
