# WP-6.3 Memory Box ("Baúl de recuerdos") [SEC]
Owner: Senior full-stack JS (BE + FE) with UI/UX · Branch: `wp/6.3-memory-box` · PR: (not opened)

Based on `origin/main` @ 83dbb88 (WP-6.0 contracts + migration 0010). Implements the WP-6.3 interfaces of `docs/coordination/WP-6.0.md` under ADR 0001 §8 (binding). No migration: 0010 already has `memory_albums`, `media_items.memory_album_id` and the `memories/{uuid}` prefix CHECKs. Owner decision: admins create and manage boxes; **any verified member** adds photos (and, with WP-6.2, tags people).

## Server (`apps/server/src/modules/memories/`, registered in `app.ts`)
| Route | Who | Notes |
|---|---|---|
| `GET /api/memories` | verified member | published boxes only (admins too), `sort_order` then newest; per-caller `mediaCount`; cover URL |
| `GET /api/memories/:id` | member (published), admin (any) | `memoryAlbumDetailSchema`, `canUpload` |
| `GET /api/memories/:id/media` | member (published), admin (any) | keyset page (`listGallery` with the box scope), items carry `memoryAlbum` |
| `POST /api/memories/:id/uploads` | member (published), admin (any) | the gallery's `createPendingUpload` (shared locked daily budget), prefix `memories/{box.id}` from the row, box re-checked under its row lock inside the budget step; 30/min per user (gallery cap) |
| `GET /api/admin/memory-albums` | admin | every status |
| `POST /api/admin/memory-albums` | admin | draft by default; ≤ 200 boxes (advisory-locked count) |
| `PATCH /api/admin/memory-albums/:id` | admin | title, description, status, sort order, `coverMediaId` (must be a live, ready, approved **photo of this box**, else 400 `VALIDATION` on `coverMediaId`; `null` clears) |
| `PUT /api/admin/memory-albums/order` | admin | every box id (409 when the set changed); `sort_order` = index |
| `DELETE /api/admin/memory-albums/:id` | admin | 409 `MEMORY_ALBUM_NOT_EMPTY` while any row is not soft-deleted; otherwise the soft-deleted rows are purged in the transaction (their tags, likes, comments, reports and notifications cascade) and their objects deleted after the commit |

- Admin writes share one limiter (120/h per user). Every box write is audited with ids, statuses, field names and counts only (`memory_album.created|updated|published|hidden|deleted|reordered`; `updated.fields` sorted); never titles or descriptions.
- Errors: `memories/errors.ts` (`MEMORY_ALBUM_NOT_FOUND` / `MEMORY_ALBUM_NOT_EMPTY` on `path: "memoryAlbum"`). A draft, hidden and missing box answer the identical 404.

### Media module changes (scope wiring)
- **`mediaScopeSql`**: the explicit published-box branch `(memory_album_id is not null and exists (… scope_memory.status = 'published'))`; the final deny stays (edition | event album | published box | nothing else). Every by-id route, `viewableSql` (WP-6.2's social routes and WP-6.1's notification filter) and the admin list inherit it.
- **Records**: `selectRecords`/`selectAdminRecords` left-join `memory_albums`; `MediaRecord.memoryAlbum`; `toMediaItem` sets `memoryAlbum: { id, title }` for box rows and `null` otherwise.
- **`listGallery`** takes `memoryAlbumId`; **`listAdmin`** filters `?memoryAlbumId=`.
- **`files.ts`**: `memoryStoragePrefix(box)`; **`uploadIntent.ts`**: the `memoryAlbumId` scope.
- **Confirm** (`routes.ts`): `keysMatchPrefix` re-derives `memories/{box.id}` from the joined box row (stored prefix and original key must match, else `prefix_mismatch`), and for box rows the transaction first locks the box row `for share` and re-checks `published` (admins: any). The upload audit carries `memoryAlbumId`.
- **Jobs, cleanup, orphan sweep**: already prefix-generic since WP-5.3 (`storagePrefixOf`): processing writes `memories/{id}/thumbs|display/…`, the leftover sweep and purge cover `memories/`; now tested on that prefix.

## Web (`apps/web/src/features/memories/`, all lazy)
- **`/recuerdos`** "Baúl de recuerdos": cards (a 4:3 cover on a cream mat like an old print, or a warm placeholder with 🗃️; title as the stretched link; "N fotos y videos"; description, 3 lines). Empty state; admins get "Administrar".
- **`/recuerdos/:id`**: back link, title, count, description, then the gallery's **unchanged** `Uploader`, `MediaGrid`, `GalleryLightbox` and `UploadPanel` on a new gallery scope `{ kind: "memory", memoryAlbumId, label }`. WP-6.2's lightbox features (hearts, tags, comments) arrive with no change here. `?foto={mediaId}` (WP-6.1's notification links go to `/recuerdos/{boxId}?foto={mediaId}`) opens that photo once it is in the loaded list and is dropped from the URL on close; WP-6.2's deep link (lazy per-item fetch) also covers photos beyond the first page. A malformed id, a missing box and a draft/hidden box all show "No encontramos ese baúl" (malformed ids never reach the API).
- **Panel → "Baúl de recuerdos"** (`/admin/recuerdos`, also in the admin sections list): rows with cover, status badge (Borrador / Publicado / Oculto), count and creator; ↑/↓ reorder (optimistic, rolled back on 409); Editar (sheet: Título, Descripción, Estado, Portada: "Automática" or one of the box's ready photos, videos excluded); Publicar (one tap) / Ocultar (confirmed: "ni sus fotos, etiquetas, corazones o comentarios"); Eliminar (confirmed; the 409 is explained).
- **Nav**: Más → "Baúl de recuerdos"; AccountMenu "Baúl de recuerdos" (after Sesiones, before Eventos) at every width; **not** in the TopNav (no room). Home: a lazy, members-only strip (max 3, "Ver todos"), silent while loading, on errors and when there is no published box.
- **Gallery scope wiring** (shared files, minimal): `lib/mediaScope.ts` (`memory` kind, key `memory:{id}`), `api.ts` (`listMemoryMedia`, `memoryMediaHead`, `createMemoryUpload`, `memoryAlbumOf`; caption/delete patch the box list; confirm/delete invalidate the box card and lists), `upload/uploadManager.ts` (intent, discard, poll), `components/ItemDialogs.tsx` (passes the box). `shared/api/baseApi.ts`: the `MemoryAlbum` tag. `test/msw.ts`: the default `GET /memories` handler (Home).

## Decisions
1. **Cover fallback:** with no chosen cover (or a chosen one no longer visible: hidden, deleted, not ready), the card shows the box's newest ready + approved photo, else the placeholder. The contract's "else `null`" now means "no visible photo at all". Visible to everyone means ready + approved + live, never a pending item of someone else.
2. **`mediaCount` per caller:** members get the gallery's member visibility (ready + approved, plus their own processing / pending-review items); admins get every live, confirmed item (what blocks a delete).
3. **`GET /api/memories` is published-only for admins too**; the panel list is the admin route.
4. **Admins may upload to drafts and hidden boxes** (to prepare a box before publishing); members only to published boxes.
5. **A member's own photo in a hidden box is 404 to them too** (every by-id route, delete included), like media in an event they left: the scope check comes before ownership.
6. **Delete = 409 while any row is live, pending uploads included** (mirrors `EVENT_ALBUM_NOT_EMPTY`); the abandoned-upload cleanup soft-deletes stale intents within minutes.
7. **Reorder takes the full id set** under the same advisory lock as create; a stale set is 409 (not 400) so the web can say "the list changed".
8. **Registered in `app.ts`** after `eventsModule`.

## Security (ADR 0001 §8 requirement 5, the web requirements)
- Members see and upload to published boxes only, re-checked at the intent and at confirm under the box row lock; the prefix is derived from the box row and confirm rejects a mismatch; one shared locked budget.
- Hiding a box hides its media and all their social data everywhere: one predicate (`mediaScopeSql` → `viewableSql`) that every social, notification, count and "Fotos de" read goes through. Tested at the predicate (`memoryScope.test.ts`), on every existing route and in the PII scan.
- An invisible box and a missing one look identical in the API (404 + `MEMORY_ALBUM_NOT_FOUND`) and on the web ("No encontramos ese baúl").
- Rollback floor: `docs/deploy/runbook.md` § 5 (never below WP-6.0 once box rows exist; 6.0–6.2 code is safe, it denies box rows) and the WP-6.3 deploy note.

## Tests
- **Server:**
  - `modules/memories/routes.test.ts` (18): list order, published-only, per-caller counts, cover choice and fallback; 404 matrix for draft/hidden/missing on `/:id` and `/media` (admins 200); keyset paging with the box ref; upload → confirm → sharp job → listed, keys under `memories/{id}`; draft/hidden refused (no row), admins upload to drafts; confirm after a hide → 404 and the row stays pending; `prefix_mismatch`; DB refuses another box's prefix; shared budget 429; admin create/edit/publish/hide with audit metadata (no titles); cover validation (other box, video, hidden, deleted → 400); unknown id 404, empty patch 400; delete 409 then purge + objects; reorder and stale 409, duplicate ids 400; admin list order; admin media `?memoryAlbumId=`; the cleanup sweep on `memories/`.
  - `modules/media/memoryScope.test.ts` (6, rewritten from WP-6.0): draft and hidden box photos 404 on GET/PATCH/report/DELETE/confirm for members (uploader included) and untouched; published reachable; hide → 404, republish → 200; one row per scope through `viewableSql` (edition, joined album, published box allowed; foreign album, draft and hidden box denied; admins all); tags, likes, comments and a notification on a box photo reachable through `viewableSql` while published and unreachable once hidden or draft.
  - Authz matrix (`__tests__/security/memoryRouteMatrix.ts`): the 9 routes for every principal; draft and hidden box probes (404, state unchanged) on the four member routes; "own / another member's photo in a draft / hidden box" probes added to `GET|PATCH|DELETE /api/media/:id`, `/report` and `/confirm`. `docs/security/routes.md` regenerated.
  - PII scan (`pii-leak.test.ts`): a hidden box's title, photo id, caption, tag, comment and notification never reach a member through the box routes or `/api/media/:id`, and its by-id URLs are 404.
- **Web** (RTL + MSW): `MemoriesPage.test.tsx` (cards, placeholder, counts, drafts not shown, empty state, admin shortcut; box page grid + lightbox; the identical not-found state for hidden/draft/missing without a media request; malformed id; upload button and the intent to `/memories/:id/uploads`), `AdminMemoriesPage.test.tsx` (statuses, create with validation, publish, confirmed hide, reorder body, edit + cover picker without videos, the 409 explanation, delete; `moveId`), `HomeMemories.test.tsx` (max 3, compact, hidden when empty, not requested for visitors), `lib/format.test.ts`; `AccountMenu.test.tsx` and `MorePage.test.tsx` updated for the new entry.
- **e2e**: `tests/e2e/memories.spec.ts` (a member uploads to the seeded published box and opens it in the lightbox, another member reaches it from Más and sees it, the seeded hidden box and a missing id show the same not-found; desktop: an admin creates and publishes a box from Panel). Gates (`quality.spec.ts`, 320/375 + axe): `/recuerdos`, `/recuerdos/{box}`, the hidden-box not-found, `/admin/recuerdos` and its edit sheet. Seed: one published and one hidden box (`harness/seed.ts`, fictional titles).
- **Screenshots** (`docs/ux/screenshots/recuerdos/`): `lista`, `baul` (375 + 1280), `panel` (1280).

## Verification
On `origin/main` @ 83dbb88 (merged: already up to date):
- `pnpm lint` clean; `pnpm turbo run typecheck --force` 6/6; `pnpm test` 216 files / 2806 tests passed (then the web project again after the `?foto=` change: 111 files / 1158 tests); `pnpm build` ok; `pnpm typecheck:e2e` ok.
- Bundle: initial JS 180.91 kB gzip (budget 190; +0.3 kB for the gallery scope wiring, the nav entries and the lazy Home loader; every Memory Box page and the Home strip are lazy chunks).
- `pnpm e2e` on isolated ports and database (`E2E_API_PORT=4363 E2E_STORAGE_PORT=4364 E2E_WEB_PORT=5363`, `cuencada_w63_e2e`): 87 passed, 2 skipped (the admin journey runs on desktop only); the mobile gates (320/375 + axe) pass on the new routes. Lighthouse failed once on performance (87, 78, 83) at load average 25–35 from parallel agents and passed on a re-run at a lower load (no Memory Box code on those pages for visitors).
- Screenshots refreshed with `E2E_UPDATE_DOCS=1`; only `recuerdos/*` and `nav/account-menu-*` (the new menu entry) are committed, the other re-rendered shots were left as they were.
- After merging `origin/main` @ e048d16 (WP-6.1, PR #57): the conflicts were lines both sides added in the same place (kept both); `docs/security/routes.md` regenerated; the two `pii-leak` cases re-joined. `pnpm lint` clean; `typecheck --force` 6/6; `typecheck:e2e` ok; `pnpm test` 219 files / 2837 tests passed; `pnpm build` ok; initial JS 182.11 kB gzip (budget 190; the bell came with WP-6.1). e2e on the isolated ports and database: `memories`, `events` (where the notifications journey lives), `nav` and the gates: 30 passed, 2 skipped.
