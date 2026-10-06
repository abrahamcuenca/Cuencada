# WP-T2-BE Cuencadas content (backend)
Owner: Backend · Reviewers: TL (+ Security for the privacy split) · Branch: wp/t2-be-cuencadas · PR: # (not opened)

Based on `origin/main` (2363af2, WP-0.4 merged). T2-FE is built in parallel against the same contract.

## Scope
- `apps/server/src/modules/cuencadas/**`:
  - `status.ts`: pure `localDateInZone`, `computeCuencadaStatus`, `selectHome` (+ `status.test.ts`)
  - `mappers.ts`: row → contract mappers
  - `repository.ts`: batched loaders, `hasMedia` EXISTS, chat-room creation, draft-delete guard, `sort_order` rewrite
  - `public-routes.ts`: `GET /cuencadas`, `/cuencadas/home`, `/cuencadas/:year`, `/cuencadas/:year/members`
  - `admin-routes.ts`: Cuencada CRUD, publish/unpublish
  - `content-routes.ts`: itinerary and locations CRUD + reorder
  - `daily-messages-routes.ts`: list, upsert/delete one date, bulk import
  - `db-errors.ts`: unique-violation detection
  - `data.ts` (hardcoded 2026 edition) and its stub routes (including the retired `PATCH …/publish`) are **deleted**
- `apps/server/src/modules/announcements/**`: `GET /announcements` (members, keyset-paginated), admin CRUD; `repository.ts` is shared with the cuencadas module.
- `packages/types/src/cuencadas.ts`: contract amendments (below) + tests.
- Tests: `public-routes.test.ts`, `admin-routes.test.ts`, `status.test.ts`, `announcements.test.ts`, and the fixtures in `apps/server/test/helpers/cuencadas.ts` (new file, not frozen).
- Outside my folders (minimal, needed for green builds):
  - `apps/server/src/seed-data.ts`: `SeedAnnouncement` also omits `publishedAt`/`expiresAt` (the seed keeps using the DB default publish time and no expiry).
  - `apps/server/src/app.test.ts`: removed the two scaffold tests that asserted the old `data.ts` response shape and the legacy create payload; the same behaviour is covered, against the DB, in the module tests.

## Interfaces exposed
Every route in the WP-0.2 T2 tables, with params/query/body **and response** schemas, `config.auth`, and `recordAudit` on every admin mutation.

| Route | Auth | Notes |
|---|---|---|
| `GET /api/cuencadas` | P | Published only, newest year first, `CuencadaSummary` with `timezone` + `hasMedia` |
| `GET /api/cuencadas/home` | P | `featured` = active edition (earliest start), else the soonest upcoming; `memories` mode otherwise. `latestPast` = most recently ended past edition. Portal-wide **public** live announcements |
| `GET /api/cuencadas/:year` | P | Drafts/unknown → 404. Public items, live public announcements, today's message in the edition's timezone |
| `GET /api/cuencadas/:year/members` | U | WhatsApp, external album, every item, live announcements of any visibility (includes the seeded pinned link announcements) |
| `GET /api/announcements` | U | Live portal-wide announcements of any visibility; keyset cursor on `(pinned, publish_at, id)` (microsecond-exact) |
| `/api/admin/cuencadas*`, `/api/admin/itinerary/:id`, `/api/admin/locations/:id`, `…/daily-messages*`, `/api/admin/announcements*` | A | As in the WP-0.2 table |

### Behaviour
- **Status** (`computeCuencadaStatus`): `draft` when unpublished; otherwise by **calendar day in the edition's timezone**: before the start day → `upcoming`, start day through end day inclusive → `active`, after → `past`. The whole first and last days count as active, regardless of the hour in `startsAt`/`endsAt`. Time comes from `app.clock`.
- **Privacy:** anonymous responses are built only from `visibility = public` rows and go through `publicCuencadaSchema`/`cuencadaSummarySchema`/`cuencadaHomeSchema`, which have no member-only fields. Tests assert that `whatsappUrl`/`externalAlbumUrl`/`isPublished` are absent and that the link values do not appear anywhere in the body.
- **Announcements shown** = `publish_at <= now and (expires_at is null or expires_at > now)`, ordered pinned first, then newest. Admin lists and the admin edit screen show every row, including scheduled and expired ones.
- **Publish** (`PATCH { isPublished: true }` or create with `isPublished: true`): audits `cuencada.published` (`metadata.chatRoomCreated`), and inserts the edition's chat room `Cuencada <year>` with `ON CONFLICT DO NOTHING` on the partial unique index, so it is idempotent. Unpublish audits `cuencada.unpublished`. Other changed fields audit `cuencada.updated` with sorted field **names only**: WhatsApp and album links are credential-like and are never copied into audit metadata.
- **Delete** (409 otherwise): only when `is_published = false`, **no chat room exists** (the room is created on first publish, so this means "never published") and **no `media_items` row of any status** exists (avoids orphaning bucket objects). The row is locked `FOR UPDATE` first.
- **Same-Cuencada integrity:** itinerary `locationId` from another edition (or unknown) → 400 `VALIDATION` at `locationId`, on create and on PATCH. Deleting a location unlinks its itinerary items in the same transaction (the FK would too) and audits the count.
- **Merged-row re-validation on PATCH:** Cuencada `endsAt > startsAt`; itinerary `endTime > startTime` (DB `HH:MM:SS` normalized to `HH:MM`); location lat/lng pair; announcement `expiresAt > publishedAt`. All → 400 with the field path.
- **Reorder** (`PUT …/order`): the edition row and its items are locked; `ids` must be exactly the edition's set (missing, foreign or duplicate → 400); `sort_order` is rewritten in **one** `UPDATE … FROM unnest($ids) WITH ORDINALITY` statement, which also sets `updated_at`.
- **New items** are appended: `sort_order = max + 1` for the edition.
- **Daily messages import** (`POST …/daily-messages/import`): accepts `text` (run through `parseDailyMessagesText`) and/or parsed `entries` (amendment). Any bad line or a repeated date → 400 `VALIDATION`, nothing is written, details are `lines.N` / `entries.N`, capped at 100 with a summary. A file with only comments/blank lines → 400. `merge` upserts; `replace` deletes the edition's dates that are not in the import, then upserts. The result is `{ created, updated, deleted }`; the edition row is locked so imports cannot interleave; inserts are chunked (1000 rows). Audited as `daily_message.imported` with the counts.
- **Audit actions:**
  - `cuencada.created|updated|published|unpublished|deleted`
  - `itinerary_item.created|updated|deleted|reordered`
  - `location.created|updated|deleted|reordered`
  - `daily_message.saved|deleted|imported`
  - `announcement.created|updated|deleted`
- **No N+1:** content for N editions = one query per table (`cuencada_id = any(...)`); home = editions (+ `hasMedia` EXISTS) + portal announcements + 3 content queries + today's message for the featured edition only.
- **Cross-module read:** `hasMedia` is an EXISTS on `media_items` (`deleted_at is null`, `upload_status = 'ready'`, `moderation_status = 'approved'`), served by `media_items_gallery_keyset_idx`. It is read-only; T4 owns the table. The draft-delete guard also reads `media_items` and `chat_rooms` (T7) read-only and inserts the edition room on publish, as WP-0.3 assigned to T2.

## Contract amendments (`packages/types/src/cuencadas.ts`) [flagged]
1. **`CuencadaSummary` + `timezone: string` and `hasMedia: boolean`** (T4-FE request; R3 from T2-FE).
2. **`Announcement` + `expiresAt: string | null`**, so the admin console can show and edit the window.
3. **`createAnnouncementInputSchema` + `publishedAt?` (default: server now) and `expiresAt` (default `null`)**; `updateAnnouncementInputSchema` + both (partial) with an `expiresAt > publishedAt` refine. The create schema stays refinement-free so `.omit()` keeps working (the seed uses it); the server checks the window after applying the default.
4. **`adminAnnouncementQuerySchema` + `scope: "portal" | "cuencada"`** (new `AnnouncementScope` as-const union; T2-FE R7). `scope=portal` together with `cuencadaId` → 400.
5. **`dailyMessagesImportInputSchema`**: `text` is now optional and `entries: DailyMessageEntry[]` (1–1000, new `DAILY_MESSAGES_IMPORT_MAX_ENTRIES`) was added; at least one of the two is required. Existing `{ text, mode }` callers are unchanged.

No breaking change for request senders. Response consumers gain fields (`timezone`, `hasMedia`, `expiresAt`), so typed fixtures in the web need them.

## Decisions
- The members endpoint is `/api/cuencadas/:year/members` per the contract (orchestrator correction; the brief said `/details`). `MemberCuencadaDetails` has no chat room id, so none is returned (see Requests).
- Members get 404 for drafts on `/members` too. Admins preview drafts through `GET /api/admin/cuencadas/:id`.
- "Ever published" is derived from the existence of the edition's chat room, because there is no `published_at` column.
- `GET /api/announcements` is portal-wide only (contract). Edition announcements come with `/cuencadas/:year` and `/members`.
- 204 routes declare `204: z.null()` and send `null`, so the body is empty.

## Requests (→ orchestrator)
1. **Migration 0002 (WP-2.1): `cuencada_itinerary_items.tags text[]`** (max 6, each ≤ 24 chars, CHECK) for T2-FE's R1 `ItineraryItem.tags`. The schema is frozen in Phase 1, so it is skipped here.
2. **Migration 0002: same-Cuencada FKs.** `unique (cuencada_id, id)` on `cuencada_locations` plus a composite FK `(cuencada_id, location_id)` with `ON DELETE SET NULL (location_id)` (PG15+), as WP-0.3 proposed. This moves the service-level check into the DB.
3. **Migration 0002: `cuencadas.first_published_at timestamptz`.** It would make the "never published" delete guard explicit instead of inferring it from the chat room.
4. **Contract (optional):** `MemberCuencadaDetails.chatRoomId: string | null`, if T2-FE/T7 want to deep-link from an edition to its chat room. It is cheap to add here once agreed.
5. **T4 (media):** keep `hasMedia`'s definition (`ready` + `approved` + not deleted) aligned with what the gallery shows to members. If the gallery rule changes, update `hasMediaSql` in `modules/cuencadas/repository.ts`.

## Verification (2026-10-06)
- `pnpm lint && pnpm typecheck && pnpm test && pnpm build`: all green (53 files, 524 tests).
- New tests:
  - `status.test.ts`: 13 unit tests, including the local-midnight boundaries in Mérida (UTC-6), Tokyo (UTC+9) and a New York DST day
  - `public-routes.test.ts`: 10 tests
  - `admin-routes.test.ts`: 16 tests
  - `announcements.test.ts`: 7 tests
  - 3 contract tests in `packages/types`

## Open questions (→ orchestrator)
- None blocking.

## Review log
- 2026-10-06: The orchestrator merged `origin/main` (T2-FE, PR #11) into this branch. With the orchestrator's approval, the web fixtures (`apps/web/src/features/cuencadas/testing/fixtures.ts`) gained `expiresAt: null` on `makeAnnouncement` and `timezone`/`hasMedia: false` on `makeSummary` for the contract amendments. Web behaviour is unchanged. `pnpm lint && pnpm typecheck && pnpm test && pnpm build`: green (59 files, 579 tests).
