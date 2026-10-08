# ADR 0001: Shared zod contracts, response schemas as PII guard, token transport, error envelope

- Status: accepted (WP-0.2)
- Date: 2026-10-06
- Deciders: Software Architect, reviewed by Tech Lead and Security

## Context

Phase 1 builds frontend and backend tracks in parallel. They need one contract they cannot drift from. The server also handles PII (directory contacts, family tree, RSVPs) and single-use tokens (invites, magic links, password reset, email verification). In the scaffold these were handled ad hoc: inline zod in routes, `{ error: "string" }` bodies, and a stub that leaked a token-hash prefix.

## Decisions

### 1. zod 4 schemas live in `packages/types`

- `packages/types/src/<module>.ts` holds, for each module:
  - zod **input** schemas (`xxxSchema`, with input types `z.infer<typeof xxxSchema>`)
  - JSDoc'd **response interfaces** with a matching zod schema checked by `satisfies z.ZodType<Interface>`
  - unions as an `as const` object plus `z.enum(obj)`, never a TS `enum`
- The package is ESM. Source imports use `.js` suffixes and the package compiles with `NodeNext`, so the server (NodeNext) and Vite (bundler) both consume `dist/`. zod is a runtime dependency (`^4`, same major as the server).
- The web uses the same input schemas for forms, so client and server validation cannot drift.
- Defensive limits are mandatory:
  - Every string has a `max`. Text is trimmed, and emails are trimmed and lowercased *before* validation (`emailSchema`).
  - Admin-entered links must literally start with `https://`, have no userinfo and a dotted host. They are stored as the canonical `URL.href`. This blocks `javascript:`/`data:` and `https://cuencada.com@evil.com` lookalikes.
  - Names and file names are NFC-normalized and reject bidi controls and invisible characters (`displayTextSchema`). Chat bodies strip them instead, keeping ZWJ for emoji.
  - Uploads use an allowlist of MIME types (JPEG, PNG, WebP, MP4, QuickTime; no HEIC) and per-kind size limits (image 25 MB, video 300 MB).
  - Lists returned in `details` are capped at `API_ERROR_DETAILS_MAX` (100).
- Every input schema exports two types: `XxxInput = z.infer` (parsed output, for the server) and `XxxRequest = z.input` (pre-defaults and pre-coercion, for RTK Query args and forms).
- PATCH inputs are built from field maps **without defaults** and then `.partial()`, so a partial update never resets omitted fields to their defaults.
- `src/index.ts` re-exports every module and is **frozen** after this WP. Phase-1 tracks edit only their own module file.

### 2. Response schemas are the PII guard

- Every route declares a response schema through `fastify-type-provider-zod`. zod objects strip unknown keys, so a column that is accidentally selected (for example `passwordHash`, `showPhone`, or a hidden phone) is never serialized.
- `DirectoryEntry` contact fields (`email`, `phone`, `city`) use `exactOptional()`. They are **absent** when hidden, not `null`, so a member can't learn that a field exists but is hidden.
  - The service must build entries with `toDirectoryEntry()`, which omits each field unless its `show*` flag is on.
  - The schema rejects `undefined`/`null` contact values, so a hand-rolled mapper fails closed with a 500 instead of leaking. The schema is defense in depth, not the only check.
  - Directory search must match only fields the target has made visible.
- Response datetimes are ISO strings with an offset. The server converts `Date` values before replying, and serialization fails closed (500) on a mismatch.

### 3. Tokens travel in the body (and the URL fragment), never in the path or query

- Emails link to `https://cuencada.com/<page>#t=<opaque>`. The SPA reads the fragment and POSTs `{ token }` to `/api/invites/inspect`, `/api/invites/accept`, `/api/auth/magic-link/consume`, `/api/auth/password-reset/confirm`, or `/api/auth/email/verify`.
  - *Note (WP-0.5.1, orchestrator decision):* `#t=` is the canonical fragment name, and it is what `@cuencada/emails` generates. Earlier drafts said `#token=`.
- Fragments are never sent to the server or in `Referer`, so tokens stay out of access logs and proxies. Email link scanners don't consume them, because a GET does nothing.
- The refresh token exists only in the `__Secure-cuencada_rt` cookie (HttpOnly, Secure, SameSite=Strict, Path=/api/auth). It is never in a JSON body. Refresh and logout also require the `X-Cuencada-CSRF` header and an exact `Origin` match. The access token is returned in the body and kept only in memory.
- **Refresh rotation threat note (T1, PR #14):**
  - Refresh tokens are single-use. A used token presented again **within 10 s** answers 409 `REFRESH_RACE` and revokes nothing, because two tabs refreshing at once is normal. Each race is audited as `auth.refresh_race`.
  - **Accepted risk:** a thief who replays a stolen token in the 10 s before the victim's own refresh gets 409 too, and so does the victim. The victim's client must therefore retry once **after** the window instead of logging out (T1-FE). Its token is then detected as reuse, and the whole session, including the thief's rotated chain, is revoked (`refresh_reuse`).
  - Used tokens of live sessions are never purged, so reuse detection works however old the replayed token is.
- **The one exception** is the WebSocket ticket. Browsers cannot set headers on a WS upgrade, so the 30-second, single-use ticket from `POST /api/chat/ticket` goes in `?ticket=`. The ticket is bound to the issuing session, so revoking the session invalidates unused tickets. The server must redact `ticket` from request logs, burn the ticket on first use, and check `Origin` on upgrade. App-level redaction doesn't cover the VPS reverse proxy, so WP-2.4 must also strip the query string from proxy access logs for `/api/chat/ws`.
- **Invites.** Holding an invite token must not be enough to claim someone else's identity:
  - `POST /api/invites/inspect` returns only `emailMasked` (`maskEmail`: `t***@e***.com`), never the full bound address. The invitee has to type it, and `accept` compares it after `emailSchema` normalization.
  - Admin invites must be email-bound, single-use and sent by email (`sendEmail: true`, no copy-link). Holding an admin token therefore implies controlling that mailbox.
  - `emailVerified` is set on accept **only** when the invite was bound to that email **and** delivered by email. Copy-link and open invites leave it `false` until the user verifies.
  - Open member invites are limited to 10 uses and 72 hours (defaults: 5 uses, 72 h), and every acceptance alerts all active admins (WP-2.3b owner decision; originally 20 uses and 14 days, see below).
- Request-for-token endpoints (magic link, password reset) always answer 202 `{ ok: true }`, so they reveal nothing about which accounts exist.

### 4. Error envelope and codes

- Every non-2xx response is `ApiError`: `{ error: { code, message, details? } }`.
  - `code` comes from the `ErrorCode` as-const object, with its HTTP status fixed in `errorHttpStatus`.
  - `message` is Spanish, produced server-side, and safe to show to the user.
  - `details` lists `{ path, message, code? }` for validation failures. `code` is an optional
    reason for the few cases the web branches on. The schema accepts any string (≤ 64 chars) so older
    clients still parse new codes; the known values are `ValidationIssueCode`, today only `PASSWORD_BREACHED`
    (WP-2.3c: the new password is in known breaches; the web shows the Spanish message on that field).
    The check is server-side and deliberately uncached, so its response time reveals nothing about
    earlier attempts with the same password.
- The web branches on `code` only. Notable codes:
  - `TOKEN_EXPIRED` (401): the client refreshes and retries.
  - `UNAUTHENTICATED` (401): the client logs out.
  - `PASSWORD_CHANGE_REQUIRED` (403): the client routes to `/cambiar-contrasena`.
  - `REFRESH_RACE` (409): the client waits for the tab holding the `navigator.locks` lock.
  - `INVALID_CREDENTIALS`, `INVITE_INVALID` and `TOKEN_INVALID` are deliberately generic.
- Messages never contain stack traces, SQL, token material or other users' data. The server should call `z.config(z.locales.es())` for default messages. The contracts set explicit Spanish messages where the wording matters.

### 5. Undated editions: status `announced` (WP-3.1a note)

- An edition can be published before its date and place are decided (migration 0003). `startsAt`/`endsAt` are **both set or both `null`** (DB CHECK `cuencadas_dates_check`, the contract's both-or-neither refine, and a merged-row check on PATCH). `city`/`state` may be `null` independently.
- `CuencadaStatus` gains **`announced`**: published with no dates. It is computed like the others, never stored: `draft` (unpublished) → `announced` (no dates) → `upcoming` / `active` / `past` (calendar days in the edition's timezone).
- `HomeMode` gains `announced`. Home features, in order: an active edition, the soonest dated upcoming one, then the announced edition with the lowest year ≥ the current year **in that edition's timezone** (an announcement for a year already over is stale and ignored), else memories. `latestPast` is still returned so Home can link to the last edition's memories.
- Read models (`CuencadaSummary`, `PublicCuencada`, `AdminCuencada`) type the four fields as nullable. `DatedCuencada<T>` and the `hasDates()` guard (exported from `cuencadas.ts`) narrow an edition before anything date-dependent; the web's countdown, `countdownInstants` and the RSVP form accept only the narrowed type, so a `null` date cannot reach them at compile time.
- **RSVP:** writes for an announced edition answer 409 `CONFLICT` with the Spanish message "Las confirmaciones abren cuando se anuncie la fecha." and a stable reason in the open detail-code channel of §4: `details: [{ path: "cuencada", message, code: "RSVP_DATES_PENDING" }]` (`RsvpIssueCode.DatesPending` in `rsvp.ts`). `ErrorCode` itself is a closed enum that older clients validate, so no new top-level code was added. A future deadline does not open RSVPs without dates (there is no stay window to check against). `GET …/rsvp/me` answers `editable: false`; attendees and the RSVP summary keep working.
- The admin dashboard's "next edition" (`AdminSummaryEdition.startsAt: string`) still lists only dated editions: an announced one has no RSVPs to count.

### 6. Family people, own-family circle, photos, contacts and revisions (WP-4)

Contracts and migration 0004 come from WP-4.0 (details in `docs/coordination/WP-4.0.md`); WP-4.1–4.4 implement them.

- **People model.** A `people` row is a tree node with or without an account (`user_id` nullable, unique). WP-4 adds `birth_date`/`death_date` (`date`), `birthplace` (≤ 120), `bio` (≤ 1000), `photo_key`/`photo_updated_at` and `updated_by_user_id`.
  - **Year follows date.** The year columns stay (many ancestors only have a year). When a full date is set, its year must equal `birth_year`/`death_year` (DB CHECK). The contract fills a missing year from the date and rejects a mismatch. A death year or date implies `deceased` (the contract sets it when omitted). Servers re-check a merged PATCH with `personDatesIssue()`.
  - New `Person` fields are optional on the wire (older clients and servers interoperate); `PersonDetails` carries all of them plus `photoUrl`, `photoSource`, `isLinked`, `canEdit`, `canEditPhoto` and `contacts`.
- **Own-family circle** (who a member may add or edit, enforced on the server, WP-4.1): the member themself, their partners, their children, their parents, and the ancestors of themselves and of their partners, recursively up (bounded by the tree depth, `FAMILY_TREE_MAX_DEPTH = 4`). A person newly created attached (`relateTo`) to someone in the circle joins it. People linked to **another** account are edited only by that member or an admin (`PERSON_LINKED_TO_OTHER`). Outside the circle: 403 `FORBIDDEN` with detail code `FAMILY_NOT_IN_CIRCLE`. Admins have full scope. Member create always carries a `relateTo` (no orphan nodes); members never set `userId`.
- **Photo precedence.** The linked account's own avatar wins; else the person's tree photo; else none. `Person.avatarUrl` and `PersonDetails.photoUrl` are that resolved photo, under the existing unlisted/disabled rules for linked accounts. A tree photo is kept when the member removes their avatar, so it shows again. Tree photos are uploaded by admins, close relatives (parent, child, partner) or the person once linked, through the avatar pipeline. An optional crop rect (integers, source pixels) is clamped server-side (`clampCropRect`); the web normally crops client-side and omits it.
- **Contact visibility.** Contacts are stored as handles (social networks), E.164 (WhatsApp) and canonical `https://` (website). The handle regexes are one exported constant (`CONTACT_HANDLE_RULES`) used by zod **and** the DB CHECKs. Each contact has its own switch, default hidden. `show_email`/`show_phone`/`show_city` stay the source of truth for those three; `contact_visibility` jsonb holds only the seven new kinds (its CHECK rejects other keys and non-boolean values), so nothing is stored twice. Members see a `ContactCard` (`{ kind, label, href, display }[]`) built only by `buildContactCard()` from fixed per-kind templates; clients never build links from raw values. Verified members only, and never for unlisted or disabled accounts.
- **Revisions as the undo source.** Every family change by a member or an admin writes a `person_revisions` row (`before`/`after` snapshots, discriminated by `type`) in the same transaction as the change, plus the usual `audit_logs` row with ids and field names only. The revisions table **holds PII**: admin-only reads, never copied into `audit_logs` or logs, 1-year retention by a cleanup job. "Deshacer" restores `before` (or removes/re-adds the relationship) and records a `person.revert` revision linked by `reverted_by_revision_id`. Photo changes are recorded but not revertible (old objects are deleted).
- **Error detail codes** (open channel of §4; `ErrorCode` stays closed): `FAMILY_NOT_IN_CIRCLE`, `PERSON_LINKED_TO_OTHER` (`FamilyIssueCode`, `family.ts`), `INVITE_PERSON_DECEASED`, `INVITE_PERSON_REQUIRES_BOUND` (`InviteIssueCode`, `auth.ts`).

## Review response (PR #2, round 1)

Changes made in response to the Security and Tech Lead reviews. Most are already reflected in the sections above.
- **Invite inspect** returns `emailMasked` instead of the full email.
- **Admin invites** require `sendEmail: true`.
- **`emailVerified`** is only granted for email-delivered invites.
- **Open invites** are limited to 20 uses and 14 days (superseded by WP-2.3b: 10 uses, 72 hours).
- **Media allowlist:** HEIC removed and QuickTime added (orchestrator decision).
- **Links** are canonicalized (`URL.href`); userinfo and single-label hosts are rejected.
- **Bidi and invisible characters** are rejected in names and file names, and stripped from chat bodies.
- **`timezoneSchema`** is verified with `Intl.DateTimeFormat`.
- **The WS ticket** is session-bound, and the proxy-log redaction requirement is added.
- **Client request types:** `XxxRequest = z.input` is exported for every input.
- **Deliberately not changed:**
  - `AuditLogEntry.entityType` stays a free string, so legacy rows still serialize.
  - Display names reject ZWJ, so emoji sequences are not allowed in names; chat bodies keep ZWJ.
- **Decided (T1, 2026-10-06):** unverified members (copy-link and open invites) get **403 `EMAIL_UNVERIFIED`** (403 `FORBIDDEN` until WP-0.8a, which split the code so the client shows "verify your email" only for this case) on the directory, the family tree and every other PII read. Those routes declare `config.requireVerifiedEmail: true` (the WP-0.4 guard reads `users.email_verified_at` from the database). T5 (directory, profile reads of other members) and T6 (family tree) enforce it. A member verifies through `POST /api/auth/email/verify-request` → `/verificar#t=…` → `POST /api/auth/email/verify`; a magic-link login or a password reset sent to the current address also verifies it. Own-profile routes and `/me` stay open to unverified members so they can see the prompt.
- **Decided (owner, WP-2.3 L2, 2026-10-06):** the gallery and the member edition details are also verified-only.
  - Covered routes: every media route (`GET /api/cuencadas/:year/media`, `GET|PATCH|DELETE /api/media/:id`, `POST /api/media/:id/confirm`, `POST /api/media/:id/report`, `POST /api/cuencadas/:year/media/uploads`) and `GET /api/cuencadas/:year/members` (WhatsApp group and album links).
  - Why: photos and uploader names reveal family membership just as the attendees list does.
  - Still open to unverified members: announcements, the RSVP summary (counts only), their own RSVP, their own profile and avatar, and `/me`.
  - Thumbnail and display images are presigned bucket URLs that only these routes hand out, so the gate covers them too.
  - Residual risk: email verification proves control of a mailbox, not family membership. A stranger holding a leaked open invite can verify their own address. Mitigated by the stricter open invites below (WP-2.3b).
  - Enforced and tested by `apps/server/src/__tests__/security/verified-gating.test.ts` and the authorization matrix.
- **Decided (owner, WP-2.3 security audit → WP-2.3b, 2026-10-06): stricter open invites.** Verifying an email proves mailbox ownership, not family membership, so a leaked open (not email-bound) invite link lets a stranger join. Therefore:
  - Open invites default to **5 uses and 72 h** and allow at most **10 uses and 72 h** (`OPEN_INVITE_*` in `packages/types/src/auth.ts`). `expiresInDays` stays in whole days, so the open maximum is 3 days (= 72 h). Enforced by `adminInviteCreateInputSchema` (defaults depend on `email`) **and** by a separate server-side guard in `POST /api/admin/invites`. Email-bound invites keep 1 use, default 7 days, maximum 30.
  - Open invites created under the old limits are **clamped at accept time** (no migration): they stop 72 h after `created_at` and after 10 uses, with the same generic `INVITE_INVALID`. The admin list shows the clamped `expiresAt`, `maxUses` and status.
  - Every acceptance of an open invite emails every active admin an `admin-invite-accepted` notice (display name, invite note and short id, uses so far / allowed, bitácora link). No email address, like the other admin alerts. Queued after commit; bounded by its own daily cap, separate from the admin-account alert cap. Details: `docs/coordination/WP-2.3b.md`.

## Consequences

- Adding a field to a response means changing the interface **and** its schema. `satisfies` makes the compiler enforce this in one direction: a schema can't omit a field the interface requires.
- Phase-1 tracks can add schemas to their own module file, but must not rename anything exported here without going through the orchestrator.
- Web code must build the `packages/types` `dist/` before Vite dev (`turbo` already does this for `build` and `typecheck`).
