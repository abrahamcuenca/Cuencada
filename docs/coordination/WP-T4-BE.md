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
| `jobs/mediaCleanup.ts` | Abandoned-upload cleanup |
| `*.test.ts`, `jobs/*.test.ts` | Route, job and unit tests |

Outside the module (flagged): `packages/types/src/media.ts` (two contract amendments, below), `packages/types/src/media.test.ts` (one assertion), and a new test helper `apps/server/test/helpers/media.ts` (fixtures; no frozen helper was edited).

## Endpoints
| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/cuencadas/:year/media/uploads` | U | 201 `CreateUploadResponse`. The edition must exist **and be published** (else 404). **30/min per user** (`preHandler`, keyed on the user id) and at most **50 open `pending_upload` intents per user** (429). The server picks the key `cuencadas/{year}/originals/{mediaId}.{ext}`; the file name is stored sanitized, as display metadata only. The presigned PUT (5 min) signs `content-type;content-length;host`. |
| POST | `/api/media/:id/confirm` | U (uploader, else 404) | HEAD: size and Content-Type must equal the intent. Ranged GET of the first 32 bytes: JPEG `FFD8FF`, PNG `89504E470D0A1A0A`, WebP `RIFF????WEBP`, MP4/QuickTime `ftyp` at offset 4 with an allowed major brand. A mismatch → row `failed` (`size_mismatch` / `content_type_mismatch` / `signature_mismatch`), object deleted, audit `media.upload_rejected`, 400 `UPLOAD_INVALID`. Object not there yet → 400 `UPLOAD_INVALID`, row stays `pending_upload` (retry). Accepted → `processing`, audit `media.uploaded`, job queued, 200 `MediaItem`. Idempotent: a repeat returns the current item; a `failed` item answers 400. |
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
- Serial (`app.jobs`, concurrency 1). Images: the original is read with `getRange(0, byteSize-1)` (max 25 MB), checked against the declared format with `sharp().metadata()`, then `sharp(input, { limitInputPixels: 50_000_000, failOn: "error" }).rotate()` → `resize({ width, height: 4×width, fit: "inside", withoutEnlargement })` → WebP. sharp writes **no metadata** unless asked, so EXIF (incl. GPS), XMP, IPTC and orientation tags are gone (tested by decoding the outputs). Keys: `cuencadas/{year}/thumbs/{id}.webp` (400px) and `cuencadas/{year}/display/{id}.webp` (1600px), uploaded with `Content-Type: image/webp` and `Cache-Control: private, max-age=31536000, immutable`. `width`/`height` are the auto-oriented original dimensions.
- Moderation: `MEDIA_REQUIRE_APPROVAL` is applied **at insert** (WP-0.3 note): `pending_review` for members, `approved` otherwise. Admin uploads are always `approved`. The job does not change moderation.
- Videos: no transcoding; `display_key` = the original, no thumbnail, `duration_seconds` from `moov/mvhd` when it sits in the first 512 KB ("fast start"), else `null`.
- Failures → `failed` with a short code in `processing_error` (`storage_read_failed`, `storage_write_failed`, `size_mismatch`, `pixel_limit_exceeded`, `format_mismatch`, `decode_failed`, `processing_failed`); any derivative already written is deleted. Logs carry only `mediaId` and the code (the raw error may contain a key, so it is never logged).
- Deleted mid-processing: the final update is guarded by `upload_status = 'processing' and deleted_at is null`; if it matches nothing the job deletes the derivatives it wrote. `DELETE` also deletes the deterministic derivative keys, so either order leaves no objects behind.
- Shutdown aborts between steps and leaves the row `processing`; **`onReady` re-queues every live `processing` row**.

### Cleanup
Every 15 min (unref'd interval, cleared on close; a pass never overlaps another). Deletes `pending_upload` rows with `upload_expires_at IS NOT NULL AND upload_expires_at < now − 6 h` in batches of 200 (max 20 batches), then their objects. **NULL expiry is never stale.** The row is claimed first (`DELETE … WHERE id IN (…) AND <stale> RETURNING`), so a concurrent confirm that already moved it to `processing` cannot lose its file. Soft-deleted (cancelled) pending rows are purged the same way, which also catches a PUT that landed after the cancel. Idempotent, tested with an injected clock. The 6 h grace covers a 300 MB PUT that started before the 5-minute URL expired.

### FE requests answered
1. **Years with media (Request 1):** no `/api/media/years`. T2 adds `hasMedia` to `CuencadaSummary`; to keep one visibility rule, T2 should compute it with `countVisibleMediaByCuencada(db, ids)` exported from `modules/media/index.ts` (`ready` + `approved`, not deleted). The FE drops its probing once `hasMedia` lands.
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
1. **Streaming read in `StorageService` (lib, frozen):** the job reads the whole original via `getRange(0, size-1)` (≤ 25 MB, serial, so ≤ 1 buffer at a time). A `getStream(key)` would let sharp stream; not needed at current limits.
2. **Pending-upload prefix (lib + bucket):** for a bucket-level orphan backstop, uploads could go to `incoming/{id}` (lifecycle-expire after 2 days) and be server-side copied to `originals/` on confirm. Needs a `copy()` in `StorageService`. Current design relies on the cleanup job instead.
3. **T2:** compute `CuencadaSummary.hasMedia` with `countVisibleMediaByCuencada` (exported from `modules/media/index.ts`).
4. **T4-FE:** add `canEdit`/`canDelete` to fixtures; set `VITE_MEDIA_UPLOAD_ORIGIN` as above; confirm sends no body or `{}` (both work now).
5. **Linode PUT enforcement (WP-0.4 open question):** at integration, verify on the real bucket that a PUT with a different `Content-Length` or `Content-Type` is rejected (403 `SignatureDoesNotMatch`). The confirm HEAD check is the backstop either way.
6. **Original download (FE Request 9):** not built. If wanted, add `GET /api/media/:id/original` → a presigned GET with `Content-Disposition: attachment` (members who can see the item). Note originals keep EXIF/GPS, so this would expose location data; recommend not offering it, or offering a metadata-stripped full-size WebP instead.

## Verification (2026-10-06)
- `scripts/test-db.sh up && pnpm lint && pnpm typecheck && pnpm test && pnpm build`: all green. 55 files, 547 tests (media: 6 files, 70 tests).
- Coverage of the brief's list: happy/400/401/403/404 per route; magic-byte mismatch (PNG as JPEG, text renamed `.jpg`, QuickTime declared as MP4); size mismatch; wrong stored Content-Type; object not uploaded yet; decompression bomb (a 100-byte PNG claiming 10000×10000: `failed`/`pixel_limit_exceeded`, no derivatives); JPEG with GPS EXIF + orientation 6 → outputs have no EXIF, no orientation, no camera string, rotated dimensions; derivative sizes and `Cache-Control`; video duration (MP4 and QuickTime); re-queue on startup (deleted rows skipped); deletion mid-processing discards derivatives; cleanup (NULL expiry kept, grace, injected clock, idempotent, storage failure counted); visibility (others' processing/failed/pending_review/hidden hidden; own visible); pagination across tied timestamps; presigned URL shape (origin, 1 h expiry, no keys/bucket in the JSON); report idempotency (409) and audit without details; moderation with the flag on and off; audit rows; rate limit (31st intent → 429, other users unaffected); logs contain no keys, presigned URLs, captions, report details or file names.

## Open questions (→ orchestrator)
- None blocking. See Requests 1, 2 and 6.

## Review log
