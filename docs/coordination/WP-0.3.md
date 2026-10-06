# WP-0.3 Schema split, migration 0001, migrator, seed
Owner: Backend (data) · Reviewers: Architect, TL · Branch: wp/0.3-schema · PR: # (not opened)

Stacked on `origin/wp/0.1-test-infra` (per-run test DBs) and `origin/wp/0.2-contracts` (revised contracts, 4e882d7). Both are merged into the branch, so merge them first.

## Scope
- `apps/server/src/db/schema.ts` is split into `src/db/schema/{auth,profiles,people,cuencadas,rsvp,media,chat,audit,relations,helpers,index}.ts`. `db/client.ts`, `drizzle.config.ts`, routes and the test harness import `db/schema/index.js`.
- Migration `drizzle/0001_schema_foundation.sql`: drizzle-kit generated it, then it was hand-edited for the pre-steps, the data-preserving renames and the `USING` casts. Its end state equals `meta/0001_snapshot.json`: `drizzle-kit generate` reports "No schema changes", and `drizzle-kit push` against a freshly migrated DB reports "No changes detected".
- Production migrator `src/db/migrate.ts` (built to `dist/db/migrate.js`).
- Upgrade test `src/db/migrations.test.ts`.
- Idempotent seed `src/seed.ts` with data in `src/seed-data.ts`, plus `src/seed.test.ts`.

## Conventions (for anyone touching `db/schema/**` in 0002)
- Allowed values use `text` + CHECK. `checkIn(name, column, AsConstObject)` renders the CHECK from the `@cuencada/types` union, so the DB always mirrors the contract. There are no pg enums.
- Every FK has a deliberate `onDelete`. Ownership/content children use `cascade`. Authorship and actor columns use `set null`, so audit and history survive account deletion.
- Every FK used in lookups has an index.
- `updated_at` uses `updatedAt()` (`$onUpdate`). Raw SQL updates must set it themselves.
- Tokens are stored as hashes only, with a unique index on every `token_hash`.
- `packages/types` gained an `exports.default` condition (also in WP-0.2). drizzle-kit loads the schema through `require`, and the schema imports `@cuencada/types`, so `db:generate` needs `packages/types` built (`pnpm build` or `pnpm --filter @cuencada/types build`).

## Tables (after 0001)
| Table | Key columns / constraints |
|---|---|
| `users` | **unique `lower(email)`** (`users_email_unique` dropped), `role` CHECK admin/member, `status` CHECK active/disabled, `email_verified_at`, `password_changed_at`, `invited_by_invite_id` → invites (set null), `must_change_password`, `last_login_at` |
| `sessions` | `user_id` (cascade), `user_agent`, `ip_address`, `last_used_at`, `idle_expires_at`, `absolute_expires_at` (CHECK idle ≤ absolute), `revoked_at` + `revoked_reason` (CHECK both-or-neither; values in `SessionRevokedReason`). `refresh_token_hash`/`expires_at` removed |
| `refresh_tokens` (new) | `session_id` (cascade), **unique `token_hash`**, `expires_at`, `used_at`, `replaced_by_token_id` (self, set null) for rotation/reuse detection |
| `invites` | **unique `token_hash`**, `email`, `display_name`, `role`, `max_uses`/`use_count` CHECK, `status` CHECK, `person_id` → people (set null), `note`, `revoked_at`, `last_sent_at`, `created_by_user_id` (set null). CHECK: an admin invite has an email and `max_uses = 1` |
| `magic_links` | **unique `token_hash`**, `purpose` CHECK `login/password_reset/email_verify` (`MagicLinkPurpose`), `request_ip`, index `(email, created_at)` for rate limiting |
| `profiles` | **`user_id` NOT NULL UNIQUE** (cascade), `avatar_key` (renamed from `photo_url`, data kept), `show_email`/`show_phone`/`show_city` (default false) |
| `avatar_uploads` (new) | `id` = `uploadId`, `user_id` (cascade), unique `object_key`, `mime_type` CHECK jpeg/png/webp, `byte_size` ≤ 10 MB, `expires_at`, `confirmed_at` |
| `people` (new) | `user_id` unique (set null), `full_name`, `nickname`, `family_branch`, `birth_year`/`death_year` (1800–2200, death ≥ birth), `deceased` (CHECK death_year ⇒ deceased), `created_by_user_id`, index `lower(full_name)` |
| `person_relationships` (new, replaces `family_relationships`) | `kind` CHECK parent_of/partner_of, `from_person_id`/`to_person_id` (cascade), **CHECK from ≠ to**, **unique (kind, from, to)**, partial unique on the unordered pair for `partner_of` |
| `cuencadas` | `status` **dropped** (computed). New: `timezone` (default America/Merida), `song_url`, `whatsapp_url`, `weather_widget_url`, `external_album_url`, `rsvp_deadline`. CHECKs: `theme_color ~ '^#[0-9a-f]{6}$'`, `ends_at > starts_at`, year 1900–2200 |
| `cuencada_locations` | `kind` CHECK hotel/venue/attraction/other, `description`, `maps_url`, `lat`/`lng` (ranges + pairing CHECK), `visibility` CHECK, `sort_order` (renamed from `display_order`), timestamps |
| `cuencada_itinerary_items` | `date` (`date`, converted from `item_date` in America/Merida), `start_time` (`time`, converted from `item_time`), `end_time` (CHECK end > start), `location_id` → locations (set null), `price_note`, `visibility` CHECK, `sort_order`, timestamps |
| `daily_messages` (new) | `cuencada_id` (cascade), `date`, `message` (1–1000 chars), **unique (cuencada_id, date)** |
| `announcements` | `pinned`, `publish_at` (contract `publishedAt`), `expires_at` (> publish_at), `updated_at`, `visibility` CHECK, `created_by_user_id` (set null) |
| `cuencada_rsvps` | `status` CHECK yes/maybe/no, `guest_count` 0–20, `arrival_date`/`departure_date` (departure ≥ arrival), `hotel_location_id` → locations (set null), `notes` ≤ 500 |
| `cuencada_attendance` (new) | `(cuencada_id, person_id)` unique, both cascade, `created_by_user_id` |
| `media_items` | `kind` (derived from MIME in the migration), `mime_type` CHECK = `MediaMimeType` (jpeg/png/webp/mp4/quicktime), `byte_size` 1..300 MB, `upload_status` CHECK (default `pending_upload`), `upload_expires_at`, `confirmed_at`, `processed_at`, `processing_error`, `thumb_key`, `display_key`, `width`/`height`/`duration_seconds` (integer), `moderation_status` CHECK default **`approved`** (old `pending` → `pending_review`), `moderated_at`/`moderated_by_user_id`/`moderation_note`, soft delete `deleted_at`/`deleted_by_user_id`, unique `object_key`, keyset index `(cuencada_id, created_at desc, id desc) where deleted_at is null`. The old `visibility` column is dropped (the gallery is member-only) |
| `media_reports` (new) | unique `(media_id, reporter_user_id)`, `reason` CHECK, `details` ≤ 500 |
| `chat_rooms` | `kind` (renamed from `room_type`, values normalized) CHECK global/cuencada, CHECK kind ↔ cuencada_id, **partial unique**: one global room, one room per Cuencada |
| `chat_messages` | `sender_user_id` (set null), `body` 1–2000 chars, `client_message_id` (partial unique per sender), `deleted_by_user_id`, keyset index `(room_id, created_at desc, id desc)` |
| `chat_read_states` (new, replaces `chat_participants`) | PK `(room_id, user_id)`, `last_read_message_id` (set null), `last_read_at` |
| `audit_logs` | `metadata` **jsonb** (`USING` cast; blank → `{}`, non-object JSON wrapped as `{"legacy": …}`; CHECK object), `ip`, `actor_user_id` (set null), indexes on `(created_at desc, id desc)`, `(actor_user_id, created_at desc)`, `(entity_type, entity_id)`, `action`. `entity_type` has no CHECK, because the contract keeps it a free string for legacy rows |

## Migration 0001 pre-steps and data handling
1. It aborts if `family_relationships` has rows. There is no automatic mapping to `people`, so data is never discarded silently.
2. Profiles: rows with a null `user_id` are deleted, and only the newest profile per user is kept.
3. `DELETE FROM sessions`: pre-0001 sessions have no refresh-token rows, so everyone logs in again.
4. `theme_color` is lowercased, and invalid colors become `#0b5e55`.
5. Location `kind` `map` → `attraction`, any other unknown kind → `other`.
6. Media `moderation_status` `pending` → `pending_review`, any other unknown status → `hidden` (fail closed).
7. Renames with casts: `item_date` → `date`, `item_time` → `start_time` (accepts `HH:MM[:SS]` or `h:MM AM/PM`, anything else becomes NULL), `display_order` → `sort_order`, `room_type` → `kind`, `photo_url` → `avatar_key`.
8. Not auto-fixed (the migration fails loudly instead): duplicate emails that differ only by case, and RSVP/user/invite values outside the new CHECKs. Seed-era data never produces them.

## Migrator and deploy
- `pnpm --filter @cuencada/server db:migrate` = `node dist/db/migrate.js`. It needs only drizzle-orm and postgres, no drizzle-kit. Target: `MIGRATE_DATABASE_URL || DATABASE_URL`. Only `host/db` is logged. The pool is closed afterwards. `db:migrate:dev` runs the same thing from source via tsx, loading `.env` if present.
- The migrations folder is resolved as `new URL("../../drizzle", import.meta.url)`, which works from both `src/db/` and `dist/db/`. `test/globalSetup.ts` imports `migrationsFolder` from `src/db/migrate.ts`.
- `infra/project.yml` `migrate_command` (`pnpm --filter @cuencada/server db:migrate`) is unchanged and now runs the built migrator. Acleron's bundle mode runs it **at bundle-build time on the operator's machine** after `build_command`, against `MIGRATE_DATABASE_URL` over the DB tunnel (`scripts/build-bundle.sh`). So `apps/server/drizzle/**` is read from the checkout and **does not need to be in the bundle**. The derived bundle includes only `package.json` files and `dist/`. If we ever want to migrate *on the VPS*, add an explicit `deploy.bundle_include` list with `apps/server/drizzle`.
- `createDatabase(config, { max })` now returns the Drizzle client plus `close()`. The `Database` type is unchanged, so `app.decorate("db", …)` and the harness keep working. WP-0.4 can register `onClose(() => app.db.close())`, but the harness's `app.db.$client.end()` hook still works.

## Seed (`node dist/seed.js`, `pnpm db:seed:dev` from source)
- Env: `DATABASE_URL`, `SEED_ADMIN_EMAIL` (default `admin@cuencada.com`), `SEED_ADMIN_TEMP_PASSWORD`, and optionally `SEED_DAILY_MESSAGES_FILE` (default: repo-root `mensajes.txt`).
- **Production refuses to run** if the password is missing, fails `passwordSchema`, or is a known placeholder (`Password123!` etc.). Outside production, a missing password falls back to `Password123!`.
- **Insert-only, idempotent.** It never overwrites rows that already exist, so a re-run cannot reset the admin's changed password or revert admin edits. Each piece is matched as follows:
  - admin: by `lower(email)`, created with `must_change_password = true`
  - profile: by `user_id`
  - Cuencada: by `year`
  - locations: by `(cuencada, name)`
  - itinerary: by `(cuencada, date, title)`
  - daily messages: `ON CONFLICT (cuencada_id, date) DO NOTHING`
  - global room: partial-unique `ON CONFLICT DO NOTHING`
- The whole seed runs in one transaction.
- 2026 content, ported from legacy `index.html` and `data.ts` and validated with the `create*InputSchema` contracts:
  - published edition, `America/Merida`, 13–18 Sep 2026
  - song `/canciones/Cancion_Oficial.mp3`
  - WhatsApp URL, weather widget `https://forecast7.com/es/20d97n89d59/merida/`
  - OneDrive folder as `external_album_url`
  - 6 locations: Hotel Chariot Mérida, Hotel El Conquistador, Cenote Santa Bárbara, Izamal, Uxmal, Progreso, with the legacy URLs
  - 6 itinerary days. Day 14 runs 07:40–18:00 with `price_note` "$1,000 p/p" and is linked to the cenote. Days 13, 15 and 16 are linked to Chariot, Uxmal and Progreso.
  - 10 daily messages from `mensajes.txt` via `parseDailyMessagesText`
  - global room "Familia Cuenca"
- In production the seed runs like the migrator: from a checkout, `DATABASE_URL=<tunnel URL> NODE_ENV=production SEED_ADMIN_TEMP_PASSWORD=… node apps/server/dist/seed.js`. It reads `mensajes.txt` from the checkout.

## Interfaces exposed
- `src/db/schema/index.ts`: every table and relation, plus `MagicLinkPurpose` and `SessionRevokedReason` (server-only as-const unions), and the `AvatarMimeType` type.
- `db/client.ts`: `Database`, `ClosableDatabase`, `createDatabase(config, { max? })`.
- `db/migrate.ts`: `migrationsFolder`, `resolveMigrationUrl(env)`, `runMigrations(url)`.
- `seed.ts`: `resolveSeedOptions(env)`, `runSeed(db, options)`, `SeedConfigError`, `DEFAULT_DAILY_MESSAGES_FILE`.

## Notes for Phase 1 tracks
- **T1 Auth:**
  - Store sessions with `idle_expires_at`/`absolute_expires_at`; `SessionListItem.expiresAt` = the earlier of the two.
  - Rotate with `refresh_tokens.used_at` + `replaced_by_token_id`. The grace-window race and reuse detection key off `used_at`.
  - Always set `revoked_reason` together with `revoked_at` (enforced by a CHECK).
  - Store emails lowercased (`emailSchema` already does). Uniqueness is on `lower(email)`, so look up with `lower(email) = $1` to hit the index.
  - Password reset and email verification use `magic_links.purpose`.
  - The scaffold's `tokenHashPreview` leak in `auth/routes.ts` is still there; it is T1's to remove.
- **T2 Cuencadas:**
  - `start_time`/`end_time` come back from postgres-js as `HH:MM:SS`; slice to `HH:MM` for the contract.
  - `date` columns come back as `YYYY-MM-DD` strings.
  - Announcements' `publishedAt` = `publish_at`; filter `publish_at <= now() and (expires_at is null or expires_at > now())`.
  - Validate that `location_id` belongs to the same Cuencada; the DB does not enforce that.
  - Create the per-Cuencada chat room on first publish (`ON CONFLICT DO NOTHING` on the partial unique).
  - `modules/cuencadas/data.ts` still exists for the current routes; delete it in T2.
- **T3 RSVP:** validate that `hotel_location_id` is a `hotel` of the same Cuencada (service-level). Attendance is keyed by `person_id`.
- **T4 Media:**
  - Set `moderation_status = 'pending_review'` on insert when `MEDIA_REQUIRE_APPROVAL` is on (the DB default is `approved`).
  - Keep `kind` consistent with `mime_type` (a CHECK enforces it).
  - Use `upload_expires_at` for cleanup of stale `pending_upload` rows.
  - Avatar uploads go in `avatar_uploads`, then `profiles.avatar_key`.
- **T5 Profile:** visibility comes from `show_email/show_phone/show_city`. `profiles.avatar_key` may hold a legacy URL value from `photo_url` (none in practice).
- **T6 Family:**
  - The DB enforces no self-relation, no duplicate triple and no mirrored partner pair. Cycle detection for `parent_of` is service-level.
  - `people.user_id` is unique, so one person per account.
- **T7 Chat:**
  - Keyset: `where room_id = $1 and (created_at, id) < ($2, $3) order by created_at desc, id desc limit n`.
  - Make WS sends idempotent with `client_message_id` (unique per sender).
  - Read state is `chat_read_states`.
- **T8 Admin:** `audit_logs.metadata` is a jsonb object, and `ip` is new. Indexes cover the audit query filters (actor, entity, action, time).

## Decisions
- `audit_logs.entity_type` has no CHECK: the contract keeps `AuditLogEntry.entityType` a free string for legacy rows. `AuditAction` likewise has no CHECK, because it only applies "where one fits".
- `chat_participants` is replaced by `chat_read_states`: every member can read every room, so membership rows are unnecessary.
- `media_items.visibility` is dropped: gallery media are always member-only.
- The server-only unions `MagicLinkPurpose` and `SessionRevokedReason` live in `db/schema/auth.ts` because the types barrel is frozen. They can move to contracts if the web ever needs them.
- The seed is insert-only rather than overwrite-upsert, so admin edits and the changed admin password are never clobbered.

## Verification (2026-10-06)
- `scripts/test-db.sh up && pnpm lint && pnpm typecheck && pnpm test && pnpm build`: all green (13 files, 130 tests + 1 todo).
- `drizzle-kit generate`: "No schema changes".
- Built migrator run twice against a scratch DB, then `drizzle-kit push`: "No changes detected".
- Built seed run twice:
  - first run inserted the admin, profile, Cuencada, 6 locations, 6 itinerary items, 10 messages and the room
  - second run inserted nothing
  - `NODE_ENV=production` with `Password123!` → refused, exit 1

## Open questions (→ orchestrator)
- **Bundle and `drizzle/**`:** not needed with the current Acleron flow, where migrations run at bundle-build time. Confirm that nobody expects to run migrations on the VPS.
- **Seed in deploys:** is it run manually once per environment over the tunnel (as documented above), or should it become a mise task?
- **Location/hotel same-Cuencada integrity:** enforced in services, not the DB. A composite FK with `ON DELETE SET NULL (col)` would need PG15+ and raw SQL that Drizzle cannot express. Is the service-level check acceptable?
- **Production Postgres version:** the migration avoids PG16-only features. Confirm the VPS version for future `IS JSON`/`NULLS NOT DISTINCT` use.

## Review log
- (pending Architect and TL review)
