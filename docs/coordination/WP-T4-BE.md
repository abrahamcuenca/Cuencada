# WP-T4-BE Media pipeline [SEC]
Owner: Backend · Reviewers: TL, Security · Branch: wp/t4-be-media · PR: # (not opened)

Built on `origin/main` (2363af2, WP-0.4 merged) against the WP-0.2 media contracts and the WP-0.3 schema. Implements the "Media pipeline [SEC]" section of `docs/plan.md`.

## Scope
All code is in `apps/server/src/modules/media/`:

| File | What |
|---|---|
| `index.ts` | Module plugin: registers the member and admin routes; `onReady` re-queues items stuck in `processing` (in the background, so a down DB never blocks boot) and starts the cleanup timer; `onClose` clears it and waits for a running pass. Re-exports `countVisibleMediaByCuencada` for T2. |
| `routes.ts` | Upload intent, confirm, gallery list, read, caption edit, delete (incl. cancel), report |
| `adminRoutes.ts` | Moderation queue, reports per item, moderate (approve / hide / delete) |
| `service.ts` | Visibility SQL, keyset queries, contract mapping with presigned GETs, `allObjectKeys` |
| `files.ts` | File-name sanitizer, server-side keys, magic-byte sniffer, MP4 `mvhd` duration reader |
| `cursor.ts` | Opaque keyset cursor (epoch **microseconds** + id, base64url) |
| `constants.ts` | Every tunable (expiries, limits, sizes, cache header) |
| `jobs/mediaProcess.ts` | sharp job, failure codes, re-queue on start |
| `jobs/mediaCleanup.ts` | Cleanup pass: abandon stale uploads, sweep leftover objects, purge |
| `objects.ts` | Shared best-effort object delete (logs id + error name only) |
| `*.test.ts`, `jobs/*.test.ts` | Route, job and unit tests |

Outside the module (flagged): `packages/types/src/media.ts` (two contract amendments, below), `packages/types/src/admin.ts` (five media `AuditAction` values; not the barrel), `packages/types/src/media.test.ts` (one assertion), and a new test helper `apps/server/test/helpers/media.ts` (fixtures; no frozen helper was edited).

## Endpoints
| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/cuencadas/:year/media/uploads` | U | 201 `CreateUploadResponse`. The edition must exist **and be published** (else 404). **30/min per user** (`preHandler`, keyed on the user id), at most **50 open `pending_upload` intents per user** and a **2 GiB rolling-24 h byte budget per user** (sum of `byte_size` of the user's non-failed items created in the window, deleted ones included; constant `DAILY_UPLOAD_BYTES`, future config `MEDIA_DAILY_UPLOAD_BYTES`), all 429 `RATE_LIMITED` with a Spanish message. Both caps are checked and the row inserted under `pg_advisory_xact_lock(hashtext('media-intent:' || user_id))`, so concurrent intents cannot overshoot (TL 7). The server picks the key `cuencadas/{year}/originals/{mediaId}.{ext}`; the file name is stored sanitized, as display metadata only. The presigned PUT (5 min) signs `content-type;content-length;host`. |
| POST | `/api/media/:id/confirm` | U (uploader, else 404); **60/min per user** | HEAD: size and Content-Type must equal the intent. Ranged GET of the first 32 bytes: JPEG `FFD8FF`, PNG `89504E470D0A1A0A`, WebP `RIFF????WEBP`, MP4/QuickTime `ftyp` at offset 4 with an allowed major brand. A mismatch → row `failed` (`size_mismatch` / `content_type_mismatch` / `signature_mismatch`), object deleted, audit `media.upload_rejected`, 400 `UPLOAD_INVALID`. Object not there yet → 400 `UPLOAD_INVALID` with `details: [{ path: "upload", message: "not_received" }]`, row stays `pending_upload` (retryable). Every final rejection carries `details: [{ path: "upload", message: "rejected" }]` (TL 6; no new `ErrorCode`, the FE branches on `details[0].message`). Accepted → `processing`, audit `media.uploaded`, job queued, 200 `MediaItem`. Idempotent: a repeat returns the current item; a `failed` item answers 400. |
| GET | `/api/cuencadas/:year/media` | U | `Page<MediaItem>`, `created_at desc, id desc`. See visibility below. `?kind=` supported. |
| GET | `/api/media/:id` | U | 404 unless visible |
| PATCH | `/api/media/:id` | U (uploader) / A | Caption; 404 for others. Audit `media.updated` (`byAdmin`). |
| DELETE | `/api/media/:id` | U (uploader) / A | 204. Uploader may delete **any status** (`pending_upload` = cancel, `processing`, `failed`, `ready`, even their own hidden item). Soft delete (`deleted_at`, `deleted_by_user_id`) + delete original and both derivative keys. Audit `media.deleted` once. **Idempotent:** repeating it answers 204 and retries the object deletes. Others: 404. |
| POST | `/api/media/:id/report` | U | 204; 409 `CONFLICT` on a repeat (unique `(media_id, reporter_user_id)`, `ON CONFLICT DO NOTHING`); 403 for your own item; 404 if not visible. 30/min per user. Audit `media.reported` with `{ reportId, reason }` only (the free-text `details` is stored in `media_reports` and never logged or audited). |
| GET | `/api/admin/media` | A | `Page<AdminMediaItem>`; filters `moderationStatus`, `uploadStatus`, `cuencadaId`, `reported`. Excludes deleted rows and, unless asked, `pending_upload`. `reportCount` is computed from `media_reports`. |
| GET | `/api/admin/media/:id/reports` | A | `MediaReport[]`, newest first, capped at 500 |
| POST | `/api/admin/media/:id/moderate` | A | `approve` / `hide` / `delete` (soft + objects). Sets `moderated_at`, `moderated_by_user_id`, `moderation_note`. Audit `media.moderated` with `{ action, previousStatus, hasNote }`. |

Every route has params/query/body **and response** schemas (errors use `apiErrorSchema`, 204s `z.void()`), so unknown keys (object keys, bucket, file name for members, `processing_error`) are stripped even if a mapper slipped.

### Visibility rule (FE Request 6: confirmed)
A member sees a non-deleted item when it is `ready` + `approved`, **or** it is their own upload in any status except `pending_upload` and `hidden`. So the uploader's list includes their own `processing`, `failed` and `pending_review` items (with `uploadStatus`/`moderationStatus`); other members never see them (404 by id). Hidden items disappear for everyone, including the uploader (they can still `DELETE` them). Admins get the same member view in the gallery list; by id and in the admin queue they see every live, confirmed row. The list is newest first.

### Processing job
- Serial (`app.jobs`, concurrency 1), with `sharp.concurrency(1)` and `sharp.cache(false)` so a burst of uploads does not starve argon2 (logins) on the shared libuv pool. The media id is logged **before** decoding.
- **Both kinds re-validate the bytes they process** (Security L1 / TL 3): the job reads the whole original, re-checks its size (body length and HEAD) and its magic bytes for the declared type, so content swapped through a still-valid presigned PUT after confirm fails as `signature_mismatch`/`size_mismatch` and is never served.
- **Only sanitized copies are served, and the original is deleted after a successful run** (it still holds GPS/camera metadata). `object_key` keeps pointing at the (now deleted) original; it is never presigned.
- **Images:** `sharp(input, { limitInputPixels: 50_000_000, failOn: "error" })`, format cross-checked with `metadata()`, then **one** full decode: `.rotate()` → 1600px WebP display copy; the 400px thumbnail is derived from that WebP (TL 4). sharp writes **no metadata**, so EXIF (incl. GPS), XMP, IPTC and orientation tags are gone (tested by decoding the outputs). Keys `cuencadas/{year}/display/{id}.webp` and `…/thumbs/{id}.webp`, `Content-Type: image/webp`, `Cache-Control: private, max-age=31536000, immutable`. `width`/`height` are the auto-oriented original dimensions.
- **Videos (Security M1, orchestrator decision: pure JS, no ffmpeg):** the job walks the ISO-BMFF box tree (`neutralizeVideoMetadata` in `files.ts`; containers `moov`, `trak`, `mdia`, `minf`, `dinf`, `stbl`, `edts`, `mvex`, `moof`, `traf`, `tref`; never into `mdat`) and rewrites every `udta` (`©xyz`, `©day`, `©mak`, `©mod`, `©swr`, `loci`, …), `meta` (QuickTime keys incl. `com.apple.quicktime.location.ISO6709`, make, model, software, creation date; iTunes `ilst`) and `uuid`/`XMP_` (XMP) box **in place** into a `free` box of the **same size** with a zeroed payload. Padding boxes (`free`/`skip`/`wide`) are zeroed too (editors leave stale metadata there). No byte moves, so `stco`/`co64` chunk offsets stay valid and nothing is remuxed. Malformed box sizes fail the item (`video_structure_invalid`). The result is uploaded to **`cuencadas/{year}/display/{id}.mp4|.mov`** with the declared Content-Type and the private immutable cache header; `display_key` points there, `thumb_key` stays `null`, and `duration_seconds` comes from `moov/mvhd` anywhere in the file.
  - **Memory:** `StorageService` has no streaming read/write, so a video is buffered whole (≤ 300 MB, one at a time on the serial queue): peak ≈ one copy of the file. Request 1 asks for `getStream`/`putStream` (or a multipart copy-with-patch) to remove this.
  - Not stripped (by design): `mvhd`/`tkhd`/`mdhd` creation/modification times (needed structure; no location). Location can only live in the boxes above per the QuickTime/ISO specs.
- Moderation: `MEDIA_REQUIRE_APPROVAL` is applied **at insert** (WP-0.3 note): `pending_review` for members, `approved` otherwise. Admin uploads are always `approved`. The job does not change moderation.
- Failures → `failed` with a short code in `processing_error` (`storage_read_failed`, `storage_write_failed`, `size_mismatch`, `signature_mismatch`, `pixel_limit_exceeded`, `format_mismatch`, `decode_failed`, `video_structure_invalid`, `interrupted`, `processing_failed`). **The original and any partial output are deleted** (Security L3). Logs carry only `mediaId` and the code.
- Deleted mid-processing: the final update is guarded by `upload_status = 'processing' and deleted_at is null`; if it matches nothing the job deletes what it wrote plus the original. `DELETE` also deletes the deterministic derivative keys, so either order leaves no objects behind (tested both through the DB and through `DELETE /api/media/:id`).
- **Startup (Security L2):** items still in `processing` at start were interrupted (shutdown, native crash or OOM). They are **not re-queued**: they are marked `failed` with `interrupted` and their objects are deleted, so a poison input cannot crash-loop the server. The uploader sees the failed tile and uploads again. This runs in the background so a down DB never blocks boot.

### Cleanup
Every 15 min (unref'd interval, cleared on close; a pass never overlaps another). One pass = three bounded, idempotent steps (`jobs/mediaCleanup.ts`, tested with an injected clock):
1. **Abandon:** `pending_upload` rows with `upload_expires_at IS NOT NULL AND upload_expires_at < now − 6 h` are claimed by a **soft delete** with the status re-checked (batches of 200, max 20), then their objects are deleted. **NULL expiry is never stale.** A confirm that already moved the row to `processing` is skipped; a confirm that comes after the claim gets 404 (both orders tested). The 6 h grace covers a 300 MB PUT that started before the 5-minute URL expired.
2. **Sweep leftovers (TL 2):** for rows soft-deleted, `failed`, or processed (`ready`) between 25 h and 1 h ago, the object deletes are re-issued (idempotent): every key of deleted/failed rows, and the original of ready rows (never a key the row still serves). This retries transient `storage.delete` failures (route deletes, rejections, job failures, abandoned uploads) and removes bytes a client re-PUT with a still-valid URL after rejection or processing. No schema change: the time window is the tracking; each row is swept on ~96 passes. Capped at 200 rows per category per pass.
3. **Purge:** abandoned/cancelled `pending_upload` rows soft-deleted more than 25 h ago are hard-deleted (their objects were swept already; NULL-expiry rows are never purged).

### FE requests answered
1. **Years with media (Request 1, orchestrator: accepted):** no `/api/media/years`. T2 adds `hasMedia` to `CuencadaSummary`. **The rule is: an edition has media when at least one `media_items` row has `upload_status = 'ready' AND moderation_status = 'approved' AND deleted_at IS NULL`.** `countVisibleMediaByCuencada(db, ids)` (exported from `modules/media/index.ts`, built on `publicVisibleSql()` in `service.ts`) implements exactly that. T2-BE (PR #12) uses its own `EXISTS`; it must use the same three predicates (the orchestrator reconciles after both merge, ideally by switching T2 to the shared helper). Own `processing`/`pending_review` items deliberately do not count.
2. **Signed headers (Request 3):** the contract field is `headers` (not `requiredHeaders`); the contract is authoritative. It is exactly `{ "Content-Type": <mimeType> }` (plus any `x-amz-*` the signer adds, none today). `Content-Length` is signed from `byteSize` but never listed. JSDoc amended.
3. **Bucket CORS (Request 4):** see the WP-2.4 note below.
4. **Cancel (Request 5 + orchestrator note 1):** the uploader may `DELETE` their own item in any status; it is idempotent.
5. **List semantics (Request 6):** confirmed above; own `pending_review` items **are** listed.
6. **Approval-first flag (Request 7):** config `MEDIA_REQUIRE_APPROVAL` (WP-0.4), applied at insert.

### Upload origin (orchestrator note 3)
`S3Storage` uses virtual-hosted addressing (`forcePathStyle: false`), so the presigned PUT/GET origin is `https://<S3_BUCKET>.<host of S3_ENDPOINT>`. For production (`S3_ENDPOINT=https://us-southeast-1.linodeobjects.com`, bucket from `vault_cuencada_s3_bucket`) set **`VITE_MEDIA_UPLOAD_ORIGIN=https://<bucket>.us-southeast-1.linodeobjects.com`** (no path, no trailing slash). This is the same bucket-specific origin WP-0.4 puts in the CSP `connect-src`/`img-src`/`media-src`. A test presigns with real `S3Storage` settings and asserts that origin.

## WP-2.4 items (bucket)
- **CORS** on the bucket (`s3cmd setcors` / Linode console):
  ```xml
  <CORSConfiguration>
    <CORSRule>
      <AllowedOrigin>https://cuencada.com</AllowedOrigin>
      <AllowedMethod>PUT</AllowedMethod>
      <AllowedMethod>GET</AllowedMethod>
      <AllowedMethod>HEAD</AllowedMethod>
      <AllowedHeader>content-type</AllowedHeader>
      <ExposeHeader>ETag</ExposeHeader>
      <MaxAgeSeconds>3600</MaxAgeSeconds>
    </CORSRule>
  </CORSConfiguration>
  ```
  No credentials (the FE PUTs with `withCredentials = false`); add `http://localhost:5173` only on a dev bucket. If the signer ever adds `x-amz-*` headers, add them to `AllowedHeader`.
- **Bucket stays private** (no public-read ACL/policy). Objects are only reachable through presigned URLs.
- **Lifecycle:** add `AbortIncompleteMultipartUpload` after 1 day. A prefix-wide expiration on `cuencadas/*/originals/` is **not** safe: originals of accepted media live there too. Orphaned originals are handled by the cleanup job (stale `pending_upload` rows, including cancelled ones, are purged with their objects). If ops want a bucket-level backstop, see Request 2.
- Optionally restrict the access key to this bucket (Linode limited access key, read/write on the media bucket only).

## Contract amendments (`packages/types/src/media.ts`) [flagged]
1. **`MediaItem.canEdit` / `canDelete`** (required booleans, server-computed: uploader or admin). Also on `AdminMediaItem` via `extend`. **FE impact:** fixtures typed as `MediaItem` (`makeMedia` in `features/gallery/testUtils.ts`) need the two fields; the FE may switch its `isMine || isAdmin` checks to them.
2. **`confirmUploadInputSchema` is `.nullish()`** (was `.optional()`): Fastify validates a missing body as `null`, so a body-less confirm failed with 400 `VALIDATION`. JSDoc corrected. `media.test.ts` asserts `null` is accepted.
3. JSDoc only: `CreateUploadResponse.headers` never contains `Content-Length`.

Not amended (contract kept authoritative over the brief): admin moderation stays `POST /api/admin/media/:id/moderate` (the brief said `PATCH /api/admin/media/:id`), and the queue filters stay `moderationStatus` / `reported` (the brief's `status=pending_review|reported|hidden` maps to `?moderationStatus=pending_review`, `?reported=true`, `?moderationStatus=hidden`).

## Decisions
- **IDOR:** every owner-only action (confirm, caption, delete) answers 404 to non-owners, including visible items; reads 404 unless visible. Reporting your own visible item is 403 (you can see it, so 404 would be misleading).
- Presigning the PUT runs inside the insert transaction, so a storage outage (503) leaves no orphan row.
- Upload intents are not audited (high volume, no content yet); confirm, rejection, caption, delete, report and moderation are.
- The keyset cursor carries epoch **microseconds**: a JS `Date` cursor would truncate Postgres timestamps and skip rows with the same millisecond.
- `GET /api/cuencadas/:year/media` requires a published edition for everyone (consistent with the upload rule).
- Presigned GETs are 1 h; nothing is proxied through the API.
- File names: the contract rejects path separators, control and bidi characters (400); `sanitizeFileName` still strips them, keeps the last path segment and caps at 255 code points before storing (defence in depth).

## Requests (→ orchestrator)
1. **Streaming I/O in `StorageService` (lib, frozen):** the job buffers the whole original (images ≤ 25 MB; **videos ≤ 300 MB** since M1) because there is only `getRange` and a buffer `put`. Add `getStream(key)` and a streaming/multipart `put` so the video scrub can patch boxes while streaming (the box walk only needs the box headers plus the metadata payloads). Until then, size the VPS for ~600 MB peak RSS during a video job, or lower the video limit.
2. **Pending-upload prefix (lib + bucket):** for a bucket-level orphan backstop, uploads could go to `incoming/{id}` (lifecycle-expire after 2 days) and be server-side copied to `originals/` on confirm. Needs a `copy()` in `StorageService`. Current design relies on the cleanup job instead.
3. **T2:** `hasMedia` must match the rule in "FE requests answered" 1 (ready + approved + not deleted); prefer `countVisibleMediaByCuencada`.
4. **Deploy:** set `VITE_MEDIA_UPLOAD_ORIGIN` as above.
5. **Linode PUT enforcement (WP-0.4 open question):** at integration, verify on the real bucket that a PUT with a different `Content-Length` or `Content-Type` is rejected (403 `SignatureDoesNotMatch`). The confirm HEAD check is the backstop either way.
6. **Original download (FE Request 9):** not built. If wanted, add `GET /api/media/:id/original` → a presigned GET with `Content-Disposition: attachment` (members who can see the item). Note originals keep EXIF/GPS, so this would expose location data; recommend not offering it, or offering a metadata-stripped full-size WebP instead.

## Merge with main (T4-FE #9, T2-FE #11)
- `origin/main` merged cleanly (no lockfile conflict).
- **FE alignment (authorized by the orchestrator):**
  - `features/gallery/testUtils.ts`: `makeMedia` sets `canEdit`/`canDelete` (default: the `isMine` override, like the server for a member); the MSW intent handler now returns only `{ "Content-Type" }` in `headers`, matching the real server.
  - `components/GalleryLightbox.tsx`: "Editar descripción" and "Eliminar" now follow the server's `canEdit` / `canDelete` instead of `isMine || isAdmin` computed client-side (the store's admin flag is no longer read there). "Reportar" still hides on `isMine`. The FE never compared uploader ids.
  - `GalleryPage.test.tsx`: the admin case gets `canEdit`/`canDelete: true` from the "server" fixture.
- **Confirm:** the FE sends `POST /media/:id/confirm` with body `{}`, which `z.strictObject({}).nullish()` accepts (a body-less call is accepted too).
- **Cancel:** the FE's upload manager calls `DELETE /media/:id` after a user cancel when it has a `mediaId`; the server allows the uploader to delete in any status (including `pending_upload`), answers 204 and is idempotent, so a retry or double cancel is harmless.

## Verification (2026-10-06)
- `scripts/test-db.sh up && pnpm lint && pnpm typecheck && pnpm test && pnpm build`: all green. 55 files, 547 tests (media: 6 files, 70 tests). After merging main and the FE alignment: 66 files, 664 tests, all green. After the PR #13 round-1 fixes: 66 files, 682 tests (media: 6 files, 88 tests), all green.
- Coverage of the brief's list: happy/400/401/403/404 per route; magic-byte mismatch (PNG as JPEG, text renamed `.jpg`, QuickTime declared as MP4); size mismatch; wrong stored Content-Type; object not uploaded yet; decompression bomb (a 100-byte PNG claiming 10000×10000: `failed`/`pixel_limit_exceeded`, no derivatives); JPEG with GPS EXIF + orientation 6 → outputs have no EXIF, no orientation, no camera string, rotated dimensions; derivative sizes and `Cache-Control`; video duration (MP4 and QuickTime); re-queue on startup (deleted rows skipped); deletion mid-processing discards derivatives; cleanup (NULL expiry kept, grace, injected clock, idempotent, storage failure counted); visibility (others' processing/failed/pending_review/hidden hidden; own visible); pagination across tied timestamps; presigned URL shape (origin, 1 h expiry, no keys/bucket in the JSON); report idempotency (409) and audit without details; moderation with the flag on and off; audit rows; rate limit (31st intent → 429, other users unaffected); logs contain no keys, presigned URLs, captions, report details or file names.

## Notes for T4-FE
- Confirm errors: branch on `error.details[0].message`: `not_received` → retry the confirm (or the PUT), `rejected` → final, show "El archivo no es válido".
- A video now shows `displayUrl` pointing at its scrubbed copy; `thumbUrl` is still `null`.
- Items interrupted by a restart come back as `uploadStatus: "failed"`; the uploader re-uploads.
- 429 on the intent can now also mean the daily byte budget ("Llegaste al límite de subidas de hoy…").

## Open questions (→ orchestrator)
- None blocking. See Requests 1, 2 and 6.

## Review log
- **PR #13 round 1: TL APPROVED, Security CHANGES REQUESTED.** Addressed on `wp/t4-be-media` (new commits only):
  - **M1 (Security, blocking): video location metadata.** Pure-JS in-place scrub (orchestrator decision, no ffmpeg): `udta`/`meta`/`uuid`/`XMP_` → same-size zeroed `free` boxes, padding zeroed, offsets untouched; served from `display/{id}.mp4|.mov`, never the original, which is deleted after success. Tests: a synthetic QuickTime with `©xyz`, `©mak`, `©swr`, `©day`, a QuickTime `meta` with the ISO6709 key, a track-level `udta` and an XMP `uuid`; the served bytes contain none of them, the length, the `stco` value and the `mdat` payload are unchanged, and the list's `displayUrl` points at the display key.
  - **L1:** closed by M1 (only re-validated, scrubbed copies are served); test swaps a confirmed video for same-length junk before the job reads it → `failed`/`signature_mismatch`, nothing stored.
  - **L2:** no re-queue on boot; `processing` → `failed`/`interrupted` + objects deleted (tested, and the original is never read).
  - **L3:** originals and partial outputs are deleted on processing failure (decompression-bomb test now asserts an empty bucket) and on rejection; the sweep retries.
  - **L4:** 2 GiB rolling-24 h per-user byte budget at intent time (tested: over/at the limit, failed and older items ignored, deleted items counted).
  - **TL 1:** cursor timestamps limited to ≤ 18 digits and ≤ year 9999 → 400 (tests for 19/20 digits and just past 9999).
  - **TL 2:** leftover-object sweep + soft-delete claim/purge for abandoned uploads (tests: retry after a failed delete, deleted/failed/ready windows, a legacy row that displays its original is never touched).
  - **TL 3:** covered by M1 (magic bytes and size re-checked in the job for both kinds).
  - **TL 4:** `sharp.concurrency(1)`, `sharp.cache(false)`, one full decode per image.
  - **TL 5:** confirm limited to 60/min per user (tested: 61st → 429).
  - **TL 6:** `UPLOAD_INVALID` `details[0].message` = `not_received` | `rejected` (tested).
  - **TL 7:** open-intent cap and byte budget checked under a per-user advisory lock in the insert transaction (cap tested).
  - **TL 8:** added the 50-intent 429, both cleanup-vs-confirm orders, the 19/20-digit cursors and the delete-through-the-API-while-processing case.
  - Nits: one shared `deleteObjectsQuietly` (`objects.ts`); `byteSize < 1` guarded in the job; `AuditAction` gains `MediaUploaded`, `MediaUploadRejected`, `MediaUpdated`, `MediaDeleted`, `MediaReported` (`packages/types/src/admin.ts`, not the barrel) and the routes use them.
