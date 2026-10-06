# WP-T5-BE Profile & directory [SEC]
Owner: Backend · Reviewers: TL, Security · Branch: wp/t5-be-profile · PR: # (not opened)

Built on `origin/main` (37dd59d) against the WP-0.2 profile contract, the WP-0.3 schema (`profiles`, `avatar_uploads`) and the WP-0.4 platform. The T4 media module is not on main yet, so the upload pattern (presign → HEAD → magic bytes → sharp) is mirrored locally from `origin/wp/t4-be-media`, not imported.

## Scope
| File | What |
|---|---|
| `apps/server/src/modules/profile/index.ts` | Module plugin: own-profile and avatar routes, the cleanup timer (`onReady` starts it unref'd, `onClose` clears it and awaits a running pass). **Re-exports `avatarUrlFor` and `AvatarSize`.** |
| `profile/routes.ts` | `GET`/`PATCH /api/profile/me` |
| `profile/avatarRoutes.ts` | Avatar intent, confirm, delete |
| `profile/avatar.ts` | Keys, magic bytes, sharp processing, `avatarUrlFor` |
| `profile/avatarCleanup.ts` | Expired/retired `avatar_uploads` cleanup |
| `profile/service.ts` | Own-profile load (lazy row creation), mapping, PATCH allowlist |
| `profile/constants.ts`, `profile/shared.ts` | Tunables and rate limits; `rateLimitByUser`, error envelopes (also used by the directory) |
| `apps/server/src/modules/directory/index.ts` | `GET /api/directory`, `GET /api/directory/:id` |
| `directory/repository.ts` | Visibility-aware search, keyset query, `toDirectoryEntry` mapping |
| `directory/cursor.ts` | Opaque keyset cursor |
| `*.test.ts` | Route, unit and cleanup tests (5 files) |

Outside the modules (flagged): `packages/types/src/profile.ts` + `profile.test.ts` (amendments below).

## Endpoints
Paths follow the WP-0.2 contract table (`/api/profile/me…`), not the brief's `/api/me/profile`.

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/profile/me` | U | Full own profile (all fields + `visibility`). Allowed while the email is unverified; 403 `PASSWORD_CHANGE_REQUIRED` while a change is pending (default guard). A missing profile row is created from the display name. |
| PATCH | `/api/profile/me` | U | `updateProfileInputSchema` (now **strict**: `role`/`status`/`userId`/`email`/`avatarKey`/anything else → 400). `displayName` writes `users.display_name`; the rest writes `profiles`. One transaction, row locked. Audit `profile.updated`, metadata `{ fields: [sorted field names] }`, no values. 30/min per user. |
| POST | `/api/profile/me/avatar/uploads` | U | 201 `AvatarUploadResponse`. JPEG/PNG/WebP, ≤ 10 MB (contract). Key `avatars/{userId}/{uploadId}.{ext}` chosen by the server; presigned PUT (5 min) signs `content-type;content-length;host`; `headers` = `{ "Content-Type" }` (+ any `x-amz-*`). `avatar_uploads` row with `expires_at`. Presign runs inside the insert transaction (a 503 leaves no row). **10/hour per user** and **≤ 5 open intents** (429). Not audited (no content yet). |
| POST | `/api/profile/me/avatar/confirm` | U (uploader; others 404) | Object missing → 400 `UPLOAD_INVALID`, row kept (retry). Past `expires_at + 1 h` → rejected. HEAD size and Content-Type must equal the intent; first 32 bytes must match (`FFD8FF`, PNG signature, `RIFF….WEBP`); sharp `metadata().format` must match; `limitInputPixels: 50 MP`, `failOn: "error"`. Any rejection deletes the row and object, audits `profile.avatar_rejected` `{ uploadId, reason }` and answers 400 `UPLOAD_INVALID`. Accepted: `rotate()` (EXIF orientation) → `resize(256|64, cover, centre)` → WebP q82, **no metadata written** (EXIF/GPS/XMP/IPTC/ICC gone). Keys `avatars/{userId}/{uploadId}-256.webp` and `-64.webp`, `Cache-Control: private, max-age=31536000, immutable`. Then a transaction claims the row (`confirmed_at`), sets `profiles.avatar_key` to the 256 key and audits `profile.avatar_updated` `{ fields: ["avatar"], uploadId, replaced }`. After commit: the **previous avatar's two objects and this upload's original are deleted**. A repeat confirm returns the current profile. 20/hour per user. |
| DELETE | `/api/profile/me/avatar` | U | Clears `avatar_key`, deletes both objects, audits `profile.avatar_removed`. Idempotent (no avatar → 200, no audit). |
| GET | `/api/directory` | U + **verified email** | `Page<DirectoryEntry>`. Query `q`, `familyBranch`, `city`, `cursor`, `limit` (≤ 100). 60/min per user. |
| GET | `/api/directory/:id` | U + **verified email** | `DirectoryEntry`; 404 for unknown or disabled users. 120/min per user. |

All routes declare params/query/body **and response** schemas; errors use `apiErrorSchema`.

### Directory rules
- **Listed** = `users.status = 'active'` **and `profiles.listed_in_directory`** (WP-2.1, migration 0002) with a profile row. `listedSql` in `directory/repository.ts` applies to list, `q` search, filters and detail; an unlisted member's `GET /api/directory/:id` is 404 like a disabled one (T5-FE request). `visibility.listedInDirectory` is returned by `GET /api/profile/me` and toggled by PATCH (audited by field name).
- **Search (`q`)**: trimmed, NFC, ≤ 100. Matches `users.display_name`, `profiles.full_name`, `people.nickname` (linked person) and `profiles.family_branch` always; `profiles.city` **only when `show_city`**; **never email or phone**, even when shown (stricter than the contract JSDoc, which allowed visible email/phone). `ILIKE '%…%' ESCAPE '\'` with `%`, `_` and `\` escaped. Blank `q` = no filter.
- `familyBranch`: case-insensitive equality. `city`: case-insensitive equality **and `show_city`**.
- Every entry is built with `toDirectoryEntry()` and serialized through `directoryEntrySchema`, so hidden `email`/`phone`/`city` keys are **absent**.
- **Keyset**: `(lower(full_name), users.id)` ascending; the DB computes the sort key and the cursor carries it verbatim, so ties and accents page exactly. Cursor `n.<base64url(id:sortName)>`; if that would exceed the contract's 512 chars (very long non-ASCII names), `i.<base64url(id)>` and the server reads that user's sort key (a position only). Anything else → 400 `VALIDATION`.

## `avatarUrlFor` (for T3 RSVP, T6 family tree, T7 chat)
```ts
import { avatarUrlFor, AvatarSize } from "../profile/index.js";

const url = await avatarUrlFor(app, row.avatarKey);                  // 256 px, presigned GET, 1 h
const thumb = await avatarUrlFor(app, row.avatarKey, AvatarSize.Small); // 64 px
```
- `app` only needs `{ storage, log }` (`AvatarUrlDeps`), so a job or service can pass its deps.
- Returns `null` when the key is `null` **or not one this module wrote** (`avatars/{uuid}/{uuid}-256.webp`; legacy `photo_url` values, originals and anything else are refused). A storage failure is logged (error name only, no key) and degrades to `null` instead of failing the response.
- Select `profiles.avatar_key` and call this per row (presigning is local HMAC, no network). Never put the key itself in a response.

## Cleanup
Every 15 min (unref'd, cleared on close, passes never overlap): (1) unconfirmed rows with `expires_at < now − 1 h` are claimed with `DELETE … WHERE id IN (…) AND <condition> RETURNING`, then their originals are deleted; (2) confirmed rows older than 24 h are dropped after re-deleting their original (derivatives are never touched). Batches of 200, max 20 per kind. Idempotent; storage failures are counted and logged without keys. Tested with an injected clock.

## Contract amendments (`packages/types/src/profile.ts`) [flagged]
1. **`updateProfileInputSchema` is `z.strictObject(...)`**: unknown keys (mass assignment) are a 400 instead of being silently stripped. **FE impact:** the profile form must send only contract fields.
2. **`phoneSchema`** additionally requires 7–15 digits (E.164 max). New exports `PHONE_MIN_DIGITS`, `PHONE_MAX_DIGITS`.
3. **`familyBranch`/`city` use `nullableDisplayTextSchema(120)`** (NFC, rejects bidi/invisible characters) instead of `nullableTextSchema`; both are shown to and searched by other members.
4. **`directoryQuerySchema`** gains `city` (optional, ≤ 120); `q`/`familyBranch` are NFC-normalized. JSDoc now states the exact matching rule.
5. Tests added in `profile.test.ts` for 1–3 and the bio bound.

## Decisions
- `displayName` lives on `users` (it is the account name shown in chat, RSVPs, `/me`); PATCH writes it there. `people.full_name` of a linked person is **not** synced (T6 owns people).
- Confirm processes synchronously (≤ 10 MB, two small outputs) so the response carries the new avatar; per-user limits bound the cost. No job queue.
- Original uploads are always deleted after processing (they may carry GPS). There is no original download.
- Disabled users vanish from list and detail (404, no hint).
- Audit actions are new `entity.verb_past` strings (`profile.updated`, `profile.avatar_updated`, `profile.avatar_removed`, `profile.avatar_rejected`) with `entityType: "profile"`; `AuditAction` in `admin.ts` was not edited (not my file).

## Verification (2026-10-06)
`pnpm lint && pnpm turbo run typecheck --force && pnpm test && pnpm build`: after merging main (WP-2.1 etc.): all green, 101 files, 1122 tests. T5: 5 server files, 86 tests (+ 4 contract tests). T5 tests: `profile.test.ts`, `avatar.test.ts`, `avatarCleanup.test.ts`, `directory.test.ts`, `cursor.test.ts`, plus `packages/types/src/profile.test.ts`. Covered: happy/400/401/403 per route (unverified → 403 on the directory, pending password change → 403 everywhere), mass assignment (role, status, userId, email, avatarKey, mustChangePassword → 400 and nothing changed), visibility matrix in list and detail, hidden phone never in list/detail/search, search never matching hidden city / any email / any phone, nickname and branch matching, wildcard escaping, disabled users excluded, keyset paging across ties and with the long-name fallback, cursor tampering, magic-byte mismatch (JPEG declared PNG, text as JPEG), size and Content-Type mismatch, decompression bomb, object not yet uploaded, expired upload, IDOR on confirm (404), previous avatar objects deleted on replace, EXIF/GPS/camera strings stripped and orientation applied (pixel check), 256/64 px WebP, legacy key → `null`, cleanup (grace, retention, idempotent, clock, failures), timer cleared on close, audit rows (field names only), rate limits (61st search → 429; 6th open intent and 11th intent/hour → 429; other users unaffected), and no PII/keys/URLs in logs.

## Requests (→ orchestrator)
1. **Done (WP-2.1 merged):** no `birthday`/`show_birthday`/`whatsapp` (orchestrator decision; the phone covers WhatsApp). `listed_in_directory` is enforced and tested (4 directory + 2 profile tests). The PR merges after the T3-BE follow-up that anonymizes unlisted attendees.
2. **Logging (frozen `logging.ts`):** add `q` to `SENSITIVE_QUERY_PARAMS`. Directory search terms (names, possibly a phone someone types) currently appear in the request-log URL. Response bodies and profile values are never logged.
3. **Done:** `normalizeContentType`, magic-byte sniffing (`sniffMediaType`/`signatureMatches`) and `rateLimitByUser` are imported from the media module (`media/files.ts`, `media/shared.ts`); `avatar.ts` keeps thin avatar-typed wrappers. `deleteObjectsQuietly` stays local (the media one takes a `mediaId` for its log line).
4. **Bucket CORS / origin:** same as WP-T4-BE (avatar PUTs go to the same bucket origin).
5. **FE (T5-FE):** use `avatarUrl` as-is (expires in 1 h; refetch the profile/directory on 403 from the bucket); send only contract keys on PATCH (strict).

## Review log
- 2026-10-06: merged `origin/main` (WP-2.1 migration 0002, T1/T3/T4/T6 backends). Flipped the three WP-2.1 lines, replaced the 6 `it.todo`s with tests, deduped helpers with media, extended the log test for `q`.
