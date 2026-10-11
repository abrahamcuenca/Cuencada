# WP-5.2 Events: contracts + migration [SEC]
Owner: Software Architect · Reviewers: TL, Security · Branch: wp/5.2-events-contracts · PR: (not opened)

Based on `origin/main` @ 8147363 (WP-4.7). Plan: WP-5 "Past Cuencadas + Eventos". This WP is the schema owner for the events migration and adds **no routes or UI**; WP-5.3 (server) and WP-5.4 (web) build on it in parallel from the interfaces below. Authorization rules: **ADR 0001 §7** (binding).

## Scope
- **Migration `0007_events` → to be renumbered `0008_events`** (expand-only; `drizzle/0007_events.sql`, `meta/0007_snapshot.json`, journal). WP-5.1's `0007_historical_cuencadas` had not merged when this branch was cut. **Whichever lands second renumbers:** if 5.1 merges first, move this file to `0008_events.sql`, change the journal tag/idx to 8th place, and regenerate the snapshot on top of 5.1's (`drizzle-kit generate` must then report "No schema changes"). The SQL touches only the objects listed below, so nothing in it changes. The migration test finds the events migration by tag (`*_events`) and needs no edit.
  - New tables `events`, `event_participants`, `event_albums`, `event_cover_uploads` (`db/schema/events.ts`).
  - `chat_rooms.event_id` + `event` kind; `media_items.cuencada_id` nullable, `album_id`, `storage_prefix`.
- **Contracts** (`packages/types`): new `src/events.ts` and the leaf `src/eventRefs.ts` (re-exported from `cuencadas.ts`, because the barrel is frozen: the WP-4.0 `contacts.ts` precedent). Additive edits to `chat.ts`, `media.ts`, `admin.ts`.
- **Cross-track edits** (to keep the repo typechecking): `modules/media/service.ts` (`countVisibleMediaByCuencada` skips null ids; `toMediaItem` sets `album: null, event: null`), `modules/chat/mappers.ts` (`event: null`), web `features/admin/lib/labels.ts` (Spanish labels for the new audit values), web `features/gallery/api.ts` (caption/delete mutations accept `year: number | null` and skip the per-year cache when null).
- **Docs:** ADR 0001 §7, threat model (assets, §4.9 STRIDE, A14), this file.

## Schema (expand-only)

| Table | Columns | Constraints and indexes |
|---|---|---|
| `events` | `id`, `slug`, `year`, `title`, `summary`, `details`, `starts_at`/`ends_at`, `timezone` (default `America/Merida`), `location_text`, `cover_key`, `cover_updated_at`, `visibility` (default `members`), `status` (default `draft`), `first_published_at`, `created_by_user_id` → users SET NULL, `created_at`, `updated_at` | unique `(year, slug)`; `events_slug_check` (3–60, `^[a-z0-9]+(?:-[a-z0-9]+)*$`); year 1900–2200; dates both-or-neither and `ends_at > starts_at`; **`events_year_check`**: `starts_at is null or year = extract(year from starts_at at time zone timezone)`; title 1–120, summary ≤ 280, details ≤ 4000, location ≤ 160; `events_cover_check` (key ⇔ timestamp, key = `events/{id}/cover/{uuid}-1280.webp`); visibility/status enums; `events_published_check` (`published` ⇒ `first_published_at`). Index `(year, starts_at, id)` (list keyset), `created_by_user_id`. |
| `event_participants` | PK `(event_id, user_id)`, `event_id` → events CASCADE, `user_id` → users CASCADE, `role` (default `participant`), `added_by_user_id` → users SET NULL (null for a self-join), `joined_at` | role enum; indexes on `user_id`, `added_by_user_id`. |
| `event_albums` | `id`, `event_id` → events CASCADE, `title`, `sort_order` (default 0), `created_by_user_id` → users SET NULL, timestamps | title 1–80, sort order 0–1000; index `(event_id, sort_order)`. A default "Fotos" album is created with every event (service). |
| `event_cover_uploads` | mirrors `person_photo_uploads`: `event_id` → events CASCADE, `uploaded_by_user_id` → users SET NULL, `object_key` (unique), `mime_type` (JPEG/PNG/WebP), `byte_size` (≤ 10 MB), `expires_at`, `confirmed_at` | as `person_photo_uploads`. |
| `chat_rooms` | + `event_id` → events **CASCADE** | `chat_rooms_kind_check` gains `event`; `chat_rooms_kind_cuencada_check` (name kept) becomes "each kind sets exactly its own column"; partial unique `chat_rooms_event_unique (event_id) where kind = 'event'`. NOT VALID → VALIDATE. |
| `media_items` | `cuencada_id` nullable; + `album_id` → event_albums **RESTRICT**; + `storage_prefix` | `media_items_scope_check`: `num_nonnulls(cuencada_id, album_id) = 1`; `media_items_storage_prefix_check`: album rows need a prefix, and a prefix is `cuencadas/{yyyy}` or `events/{uuid}/{uuid}`; partial index `media_items_album_keyset_idx (album_id, created_at desc, id desc) where album_id is not null`. NOT VALID → VALIDATE. |

### Why it is expand-only
- New tables only receive rows from new code.
- `chat_rooms`: both CHECKs are strictly wider for what old code writes (`global`/`cuencada` rooms, `event_id` absent ⇒ null). Old reads use `kind = 'global' or exists(published cuencada)`, so event rooms (none exist before WP-5.3) never reach 0007-era code.
- `media_items`: dropping NOT NULL on `cuencada_id` is a widening; old inserts always set it and never `album_id`, so they satisfy the scope and prefix CHECKs. Old reads inner-join `cuencadas`, so album rows never reach them.
- Dropped and re-added CHECKs run in the migration transaction (no window without a CHECK). No data step.

## Decisions
1. **`storage_prefix` is stored, not derived** (nullable for legacy rows, which keep `cuencadas/{year}`). Today's keys are derived from the edition **year**, and an admin can change an edition's year (`updateCuencadaInputSchema.year`), which would orphan derivative keys; album media have no year at all. A stored, server-generated prefix (`events/{eventId}/{albumId}`, CHECKed) makes key derivation scope-independent: `mediaKeys(prefix, id, mime)`. WP-5.3 may also start writing `cuencadas/{year}` on new edition rows; readers use `storage_prefix ?? \`cuencadas/${year}\``.
2. **`album_id` is ON DELETE RESTRICT**, so a cascade can never silently drop media rows whose objects would then leak in the bucket. Deleting an album or an event therefore needs its media rows removed first (soft-deleted ones included): the service collects the object keys, hard-deletes the rows in the same transaction, and deletes the objects after the commit (best effort; the leftover sweep retries). Album delete with **live** media answers 409 `EVENT_ALBUM_NOT_EMPTY`; with only soft-deleted rows it purges them.
3. **`year` follows `starts_at` in the event's timezone** (DB CHECK and `eventDatesIssue`), so "Año Nuevo" starting 23:00 on Dec 31 in Mérida is a 2026 event. Changing `startsAt` across a year boundary changes the URL; the web navigates to the returned `year/slug`.
4. **Slug** generated server-side from the title with `slugifyEventTitle` (exported for the web preview) and suffixed `-2…` on collision with `eventSlugWithSuffix`; an organizer may type one (409 `EVENT_SLUG_TAKEN`). Folding: NFD minus marks plus `ß→ss`, `æ→ae`, `œ→oe`, `ø→o`, `ł→l`, `đ→d`; fallback `evento` when < 3 chars.
5. **Cover** uses the avatar upload intent (JPEG/PNG/WebP ≤ 10 MB) and the WP-4.0 crop rect with `size` = crop **width** (height = `round(size / (16/9))`), clamped by the new `clampAspectCropRect` (same "shift, don't shrink" rule as `clampCropRect`). Derivatives 1280 and 640 px WebP. `cover_key` stores the 1280 key; the 640 key swaps the suffix (the WP-4.3 `photo_key` pattern).
6. **`hidden` is a status**, admin-only both ways; `hidden` without a prior publish is allowed (an admin can hide a draft). `published` requires `first_published_at`.
7. **Organizers survive account deletion only as `null`**: participant rows cascade with the user; an event may be left with no organizer, which admins fix. The "last organizer cannot leave" rule is a service rule (`EVENT_LAST_ORGANIZER`), not a DB constraint (a trigger would hide logic, and user deletes must not fail).
8. **Participant `userId` privacy** (`EventParticipant.userId` absent, not null): present for self, for managers (needed to remove/promote) and for directory-listed active members. The organizers' picker uses the existing directory search (`GET /api/directory`), so no new member-search surface; admins can add any member by id.
9. **Admin views** of `participants` events are audited once per admin per event per hour (`event.admin_viewed`, `metadata.surface` = the first surface in the window). Implementation: an in-memory TTL map keyed `adminId:eventId` is enough on one instance; a DB check (`audit_logs` row in the last hour, index on `action`) survives restarts. 5.3 chooses; the contract only fixes the action and metadata.
10. **Audit entity type** is a single `event` for event, participant, album and cover actions (`metadata.albumId`/`userId`/`uploadId`), so the admin log filters one event's history with one entity id. `AuditEntityType.Event` added; `event.participant_role_changed` added beyond the brief for promotions.
11. **Error codes** use the open detail-code channel (ADR 0001 §4); `ErrorCode` stays closed. Two codes beyond the brief: `EVENT_LAST_ORGANIZER`, `EVENT_MANAGE_NOT_ALLOWED`.

## Interfaces for 5.3/5.4
All routes: `auth: "member"`, `config.requireVerifiedEmail: true`, response schemas from `events.ts` (the PII guard). `:id` = event id (uuid). Invisible event → 404 `NOT_FOUND` + `EVENT_NOT_FOUND`.

| Method + path | Who | Params / query / body | Response |
|---|---|---|---|
| `GET /api/events` | member | `eventListQuerySchema` (`when` upcoming\|past, `year?`, `mine?`, `cursor?`, `limit`) | `Page<EventSummary>` (`eventPageSchema`), cover 640 |
| `POST /api/events` | member (becomes organizer) | `createEventInputSchema` | 201 `EventDetail`; creates the "Fotos" album, and the chat room when `publish` |
| `GET /api/events/:year/:slug` | per visibility | `eventPathParamsSchema` | `EventDetail` (cover 1280); audits `event.admin_viewed` (`detail`) |
| `PATCH /api/events/:id` | organizer, admin (`hidden` admin-only) | `updateEventInputSchema` | `EventDetail`; first publish creates the room; tightening visibility/hiding sends `room_removed` |
| `DELETE /api/events/:id` | admin; organizer for a media-free draft | `emptyEventBodySchema` | 204 |
| `POST /api/events/:id/join` | member, published `members` event | `emptyEventBodySchema` | `EventDetail` (idempotent) |
| `DELETE /api/events/:id/participants/me` | participant (not the last organizer) | — | 204 |
| `POST /api/events/:id/participants` | organizer, admin | `addEventParticipantsInputSchema` | `EventDetail` |
| `PATCH /api/events/:id/participants/:userId` | organizer, admin | `eventParticipantParamsSchema`, `updateEventParticipantInputSchema` | `EventDetail` |
| `DELETE /api/events/:id/participants/:userId` | organizer, admin | `eventParticipantParamsSchema` | `EventDetail`; `room_removed` to that user |
| `POST /api/events/:id/albums` | organizer, admin (≤ 20 albums) | `createEventAlbumInputSchema` | 201 `EventAlbum` |
| `PATCH /api/events/:id/albums/:albumId` | organizer, admin | `eventAlbumParamsSchema`, `updateEventAlbumInputSchema` | `EventAlbum` |
| `DELETE /api/events/:id/albums/:albumId` | organizer, admin | `eventAlbumParamsSchema` | 204; 409 `EVENT_ALBUM_NOT_EMPTY` with live media |
| `GET /api/events/:id/albums/:albumId/media` | participant, admin | `mediaListQuerySchema` | `Page<MediaItem>` (with `album`, `event`); audits `media` |
| `POST /api/events/:id/albums/:albumId/uploads` | participant, admin | `createUploadInputSchema` | `CreateUploadResponse`; confirm/patch/delete/report through the existing `/api/media/:id…` routes (scope-checked) |
| `POST /api/events/:id/cover/uploads` | organizer, admin | `eventCoverUploadInputSchema` | `EventCoverUploadResponse` |
| `POST /api/events/:id/cover/uploads/:uploadId/confirm` | organizer, admin | `eventCoverUploadParamsSchema`, `eventCoverConfirmBodySchema` | `EventDetail` |
| `DELETE /api/events/:id/cover` | organizer, admin | — | `EventDetail` |
| `GET /api/admin/events` | admin | `adminEventListQuerySchema` | `Page<AdminEventSummary>` (`adminEventPageSchema`), hidden and drafts included |
| `GET /api/admin/media?eventId=` | admin | `adminMediaQuerySchema.eventId` | existing |
| `GET /api/chat/rooms` | member | — | event rooms of the caller's events (admins: all) with `event: EventRef`; `title` = the event title |

**Storage keys** (all server-generated):
- Album media: `storage_prefix = events/{eventId}/{albumId}`; keys `{prefix}/originals/{mediaId}.{ext}`, `{prefix}/thumbs/{mediaId}.webp`, `{prefix}/display/{mediaId}.{webp|mp4|mov}` (the gallery layout under a new prefix). The leftover-object sweep must list `events/` too.
- Cover: original `events/{eventId}/cover/{uploadId}.{jpg|png|webp}` (deleted after processing), derivatives `events/{eventId}/cover/{uploadId}-{1280|640}.webp`; `events.cover_key` = the 1280 key. Event delete removes `events/{eventId}/` after the commit.

**WebSocket:** new server frame `room_removed { roomId }` (`wsServerRoomRemovedSchema`). Event rooms reuse every other frame; delivery is filtered per room.

**Helpers exported from `@cuencada/types`:** `foldAccents`, `slugifyEventTitle`, `eventSlugWithSuffix`, `isEventSlug`, `eventYearOf`, `eventDatesIssue` (merged-row check, returns an `ApiErrorDetail`), `isPastEvent` (upcoming/past rule, same as WP-5.1's), `clampAspectCropRect`, constants (`EVENT_*`, `DEFAULT_EVENT_ALBUM_TITLE`, `EVENT_COVER_ASPECT`, `EVENT_COVER_WIDTHS`).

**Rollout order:** the migration ships first and is inert. 5.3 must make the media by-id routes scope-aware **before** any album row can exist (the album upload route lands in the same change), and must switch the media jobs and cleanup from inner to left joins on `cuencadas` with `storage_prefix`.

## Open questions (→ orchestrator)
- Migration number: renumber to 0008 after WP-5.1 (see Scope).
- Should event uploads count against the same per-user daily byte budget as the gallery? Proposed: yes, one budget.

## Verification
- `drizzle-kit generate`: "No schema changes, nothing to migrate".
- Migration test "migration events (WP-5.2, expand-only)" (6 cases) from the migration before it: chat rooms, messages and media (incl. a soft-deleted video) unchanged, new columns null, old-shape room and media inserts still work, the six new/replaced constraints validated; events CHECKs (slug corpus, lengths, enums, published ⇒ date, year in the timezone across New Year, cover key pinned to the event, unique `(year, slug)`); participant role/PK, album title/sort, cover MIME/size/unique; chat kind ↔ column rule and one room per event; media scope and prefix CHECKs and the partial album index; event delete blocked by album media (even soft-deleted), then cascading to participants, albums, cover uploads, room and messages with edition data untouched; user delete removes participations and nulls the user FKs.
- Contract tests `packages/types/src/events.test.ts` (45): accent folding, slug generation/suffix/validation, timezone year, create/update strictness and defaults, text cleaning, merged-row check, past/upcoming rule, participant/album inputs, list query, cover crop clamp, read models (unknown keys stripped, `userId` absent vs. null), old/new `ChatRoom` and `MediaItem` shapes, `room_removed`, audit actions and detail codes, barrel exports.
