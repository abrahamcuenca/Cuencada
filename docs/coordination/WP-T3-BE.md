# WP-T3-BE RSVP and attendance (backend)
Owner: Backend · Reviewers: TL (+ Security for the attendee list and CSV export) · Branch: wp/t3-be-rsvp · PR: # (not opened)

Based on `origin/main` (37dd59d: WP-0.4, T1-FE, T2-BE merged). T3-FE builds against the same contract.

## Scope
- `apps/server/src/modules/rsvp/**`:
  - `rules.ts`: pure `rsvpEditability` (status + deadline in the edition's timezone), `rsvpDateWindow`, `rsvpDateProblems`, `addDays` (+ `rules.test.ts`)
  - `csv.ts`: `toCsv`/`csvCell` (BOM, CRLF, RFC 4180 quoting, formula-injection guard) (+ `csv.test.ts`)
  - `attendees.ts`: `mergeAttendees` (union + dedupe + sort), `toAttendees` (avatar presign, `isMe`) (+ `attendees.test.ts`)
  - `repository.ts`: every query (upsert, summary aggregates, attendee candidates, admin table, attendance writes)
  - `member-routes.ts`, `admin-routes.ts`, `index.ts` (+ `member-routes.test.ts`, `admin-routes.test.ts`)
- `packages/types/src/rsvp.ts` and `packages/types/src/admin.ts`: contract amendments (below).
- Reused from T2 by import only (no edits): `getPublishedByYear`, `getCuencadaById` (`modules/cuencadas/repository.ts`) and `computeCuencadaStatus`, `localDateInZone` (`modules/cuencadas/status.ts`).

## Interfaces exposed
| Route | Auth | Notes |
|---|---|---|
| `GET /api/cuencadas/:year/rsvp/me` | U | `MyRsvpResponse`: own RSVP or `null`, `deadline` (stored ISO), `editable` |
| `PUT /api/cuencadas/:year/rsvp/me` | U | `MyRsvp`. 400 `VALIDATION` (schema, stay window, hotel), 404 draft/unknown, **409 `CONFLICT`** when not editable. 30/min per IP |
| `GET /api/cuencadas/:year/rsvp/summary` | U | `RsvpSummary`: counts by status, `expectedPeople` (`yes` + guests), people per hotel. No names |
| `GET /api/cuencadas/:year/attendees` | U + **`requireVerifiedEmail`** | `Attendee[]` (ADR 0001: it reveals family membership) |
| `GET /api/admin/cuencadas/:id/rsvps` | A | `AdminRsvpRow[]` (name, email, status, guests, dates, hotel, notes) |
| `GET /api/admin/cuencadas/:id/rsvps.csv` | A | `text/csv; charset=utf-8`, BOM, `Content-Disposition: attachment; filename="cuencada-<year>-rsvps.csv"`, `Cache-Control: no-store`. Audited. 20/min per IP |
| `GET /api/admin/cuencadas/:id/attendance` | A | `AttendanceRecord[]` by name |
| `POST /api/admin/cuencadas/:id/attendance` | A | contract `{ add, remove }`, transactional, audited |
| `PUT /api/admin/cuencadas/:id/attendance` | A | **amendment**: `{ personIds }` replaces the whole set, transactional, audited |

Member routes answer 404 for drafts and unknown years (same as the edition pages). Admin routes work on drafts too.

### Behaviour
- **Editable** (`rsvpEditability`): the edition must be published and its computed status (T2's `computeCuencadaStatus`, calendar days in the edition's timezone) `upcoming` or `active`; `past` → 409 "Esta Cuencada ya pasó…". With an `rsvp_deadline`, edits are allowed while **today in the edition's timezone ≤ the deadline's calendar day there**, so the deadline lasts until local midnight at the end of that day whatever hour was stored → 409 "La fecha límite para confirmar asistencia ya pasó.". The same rule drives `editable` in `GET …/rsvp/me`. Tested at 23:59:59 / 00:00:00 local in Mérida (route + unit) and in Tokyo (unit).
- **Validation** (`PUT`): the contract schema covers `guestCount` 0–20, `notes` ≤ 500, `departure ≥ arrival`. The service adds:
  - **stay window**: `arrivalDate`/`departureDate` within `RSVP_DATE_WINDOW_DAYS` (14) days before the first day through 14 after the last day (local dates). → 400 at the field.
  - **hotel**: `hotelLocationId` must be a location **of the same Cuencada with `kind = hotel`**; another edition's hotel, a venue, or an unknown id → 400 at `hotelLocationId` ("Elige un hotel de esta Cuencada."). All problems are reported together.
- **Upsert** on the unique `(cuencada_id, user_id)` (`INSERT … ON CONFLICT DO UPDATE`), with `created_at`/`updated_at` from `app.clock`. `PUT` is a full replace: omitted optional fields reset to their defaults (`0`/`null`).
- **Audit**: `rsvp.saved` (`entityType: rsvp`) with `{ cuencadaId, status, guestCount, created }`: never notes or dates. `rsvp.exported` (`entityType: cuencada`) with `{ rows }`. `attendance.updated` (`entityType: cuencada`) with `{ mode: "patch" | "replace", added, removed, total }`: counts only, no person ids or names.
- **Summary** is two SQL aggregates (`count(*) filter`, `sum(1 + guest_count)`; per-hotel `group by`, only hotels of the same edition, in the edition's location order). RSVPs of **disabled accounts are excluded** here and in the attendee list; the admin table shows everything.
- **Attendees** = `yes` RSVPs of active accounts ∪ `cuencada_attendance`, two queries plus in-memory merge:
  - dedupe key: `person_id`, or the user id when the account has no linked `people` row; a person with both an RSVP and attendance shows once with `source: "rsvp"`, `rsvpStatus: "yes"`; attendance-only rows have `rsvpStatus: null`.
  - display name: the account's `display_name`, else the person's `nickname`, else `full_name`.
  - avatar: `profiles.avatar_key` presigned with `app.storage.presignGet` (1 h, same as T4's view URLs). If storage is not configured (503), avatars degrade to `null` with one warning; other storage errors fail the request.
  - `isMe` for the caller's row. Sorted with a Spanish, accent-insensitive collator.
  - **No contact fields**: the queries select only ids, names and the avatar key, and `attendeeSchema` strips anything else (tested: phone/email never in the body, exact key set).
- **CSV**: columns are exactly the `AdminRsvpRow` keys (contract). UTF-8 BOM + CRLF. Cells starting with `=`, `+`, `-`, `@`, TAB or CR get a leading `'`; then cells with `"`, `,`, CR or LF are quoted with doubled quotes. The body is a string with a non-JSON content type, so Fastify sends it as-is (asserted on the raw bytes).
- **Attendance writes**: the edition row is locked `FOR UPDATE`; every id must be a person (unknown → 400 at `add.N`/`personIds.N`, nothing written). `POST` dedupes `add`/`remove`, deletes then inserts with `ON CONFLICT DO NOTHING`. `PUT` deletes everyone not in `personIds` (all when empty) and inserts the rest, in one transaction. Both return the full list.
- **No N+1**: every route runs a fixed number of queries (attendees: 2; summary: 2; admin table: 1 join; attendance writes: lock + existence check + delete + insert + list).

## Contract amendments (`packages/types`) [flagged]
1. **`Attendee.isMe: boolean`** (required; brief).
2. **Attendees are `yes` RSVPs only** (brief), not `yes`/`maybe` as WP-0.2 decision 9 said. `rsvpStatus` is therefore `"yes"` or `null`. The JSDoc is updated; the schema is unchanged.
3. **`PUT …/rsvp/me` closed → 409 `CONFLICT`** (brief), not 403 `FORBIDDEN` as the WP-0.2 table said. A closed edition is a state conflict, and a 403 would read as "you are not allowed" to the client. The `editable` JSDoc now says the deadline lasts to the end of its day in the edition's timezone.
4. **`RSVP_DATE_WINDOW_DAYS = 14`** exported so T3-FE can bound its date pickers.
5. **`PUT /api/admin/cuencadas/:id/attendance`** with the new `adminAttendanceReplaceInputSchema` (`{ personIds: uuid[] }`, ≤ `ATTENDANCE_MAX_PEOPLE` = 1000, duplicates rejected) replaces the set (brief: "bulk PUT"). The contract's `POST { add, remove }` is kept unchanged (its limit now uses `ATTENDANCE_MAX_PEOPLE`).
6. **`AuditAction`** gains `RsvpSaved: "rsvp.saved"` and `RsvpExported: "rsvp.exported"`; `attendance.updated` is documented (counts only).

Not changed: the summary stays at `/rsvp/summary` (contract path; the brief said `/rsvps`), and it has no name lists, matching `RsvpSummary`.

## Decisions
- **`listed_in_directory`** (applied in `wp/t3-be-unlisted`, after migration 0002 added the column): on `/attendees`, a person whose linked account has `listed_in_directory = false` is returned to everyone else as **"Familiar"** with `avatarUrl`, `personId` and `userId` all `null`. They still count (one row per person, after dedupe), and the RSVP status/source stay. Anonymization happens after dedupe and **before sorting**, so a row's position does not hint at the real name, and no avatar is signed for it. The caller's own row (`isMe`) is always complete. People without an account (historical attendance only) have no profile and are unaffected. The admin RSVP table and CSV stay complete.
- Active editions accept RSVP changes (the contract's `editable` is false only for `past` or after the deadline).
- Drafts → 404 on member routes (no RSVP before publishing), consistent with `/cuencadas/:year/members`.
- Disabled accounts are excluded from the summary and the attendee strip, since a disabled account is a removed member. Historical attendance of their linked person still shows (it is a fact about the past edition).
- RSVP changes are audited (not only admin mutations), with no personal content in the metadata.
- `AttendanceRecord.displayName` is `people.full_name` (the admin's canonical name).

## Requests (→ orchestrator)
1. Done: migration 0002 added `profiles.listed_in_directory`; T3 applies it (see Decisions). T5's directory and its "Aparecer en el directorio" toggle use the same flag.
2. **Migration 0002: same-Cuencada FK for `cuencada_rsvps.hotel_location_id`**: composite `(cuencada_id, hotel_location_id)` → `cuencada_locations (cuencada_id, id)` with `ON DELETE SET NULL (hotel_location_id)`, as T2 requested for itinerary locations. The `kind = hotel` rule stays in the service (a later kind change by an admin leaves stale choices, which the summary keeps counting under that location; acceptable).
3. **T2 (cuencadas):** when an admin changes a location's `kind` away from `hotel` or deletes it, RSVPs keep or lose the reference (the FK sets null on delete). If T2-FE wants a warning, a count of RSVPs per location could be added to `AdminCuencadaDetail` later.
4. **T3-FE:** handle 409 on `PUT …/rsvp/me` (show the Spanish message and refetch `rsvp/me`), and 403 on `/attendees` for unverified members (prompt to verify the email). Use `RSVP_DATE_WINDOW_DAYS` for the pickers. The CSV link needs the bearer token, so download it with `fetch` + `Blob`, not a plain `<a href>`.

## Verification (2026-10-06)
- `pnpm lint && pnpm turbo run typecheck --force && pnpm test && pnpm build`: all green (82 files, 807 tests).
- New tests (45): `rules.test.ts` 9, `csv.test.ts` 9, `attendees.test.ts` 4, `member-routes.test.ts` 15, `admin-routes.test.ts` 8. Route tests run against real Postgres with `inject()` and an injected clock.

## Follow-up: unlisted members (wp/t3-be-unlisted)
- `repository.ts` selects `profiles.listed_in_directory` with the attendee candidates; `mergeAttendees(rsvps, attendance, viewerId)` anonymizes; `toAttendees` no longer needs the viewer id.
- Contract: `Attendee` JSDoc documents the anonymized shape (no schema change).
- **Security L1 (PR #19):** hidden rows no longer keep DB order (≈ RSVP/recording time). Ties after `displayName` break on a server-only `orderKey`: the id for visible rows; for hidden rows `source` then HMAC-SHA256 of the dedupe key (`p:<personId>`/`u:<userId>`) under a **per-process random 32-byte key** (`randomBytes` at module load). The key never leaves the process, so the order is not reversible to an id and does not correlate with time; it is stable within a process and reshuffles on restart. `orderKey` is not part of the response (`toAttendees` maps fields explicitly, and `attendeeSchema` strips unknown keys). Unit test: hidden rows merged in opposite insertion orders produce the same order (source first, then ascending HMAC), and the key contains no id.
- New tests (+5): unit tests for anonymization, the viewer's own row and no avatar signing; a route test (anonymized for others with no ids/names/avatar key in the body, complete for the user themselves, count kept, historical-only unlisted account also hidden); an admin test (table and CSV complete for an unlisted member).
- `pnpm lint && pnpm turbo run typecheck --force && pnpm test && pnpm build`: all green (96 files, 1037 tests).

## Open questions (→ orchestrator)
- None blocking.
