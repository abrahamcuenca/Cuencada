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
  - `details` lists `{ path, message }` for validation failures.
- The web branches on `code` only. Notable codes:
  - `TOKEN_EXPIRED` (401): the client refreshes and retries.
  - `UNAUTHENTICATED` (401): the client logs out.
  - `PASSWORD_CHANGE_REQUIRED` (403): the client routes to `/cambiar-contrasena`.
  - `REFRESH_RACE` (409): the client waits for the tab holding the `navigator.locks` lock.
  - `INVALID_CREDENTIALS`, `INVITE_INVALID` and `TOKEN_INVALID` are deliberately generic.
- Messages never contain stack traces, SQL, token material or other users' data. The server should call `z.config(z.locales.es())` for default messages. The contracts set explicit Spanish messages where the wording matters.

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
- **Decided (owner, WP-2.3 security audit → WP-2.3b, 2026-10-06): stricter open invites.** Verifying an email proves mailbox ownership, not family membership, so a leaked open (not email-bound) invite link lets a stranger join. Therefore:
  - Open invites default to **5 uses and 72 h** and allow at most **10 uses and 72 h** (`OPEN_INVITE_*` in `packages/types/src/auth.ts`). `expiresInDays` stays in whole days, so the open maximum is 3 days (= 72 h). Enforced by `adminInviteCreateInputSchema` (defaults depend on `email`) **and** by a separate server-side guard in `POST /api/admin/invites`. Email-bound invites keep 1 use, default 7 days, maximum 30.
  - Open invites created under the old limits are **clamped at accept time** (no migration): they stop 72 h after `created_at` and after 10 uses, with the same generic `INVITE_INVALID`. The admin list shows the clamped `expiresAt`, `maxUses` and status.
  - Every acceptance of an open invite emails every active admin an `admin-invite-accepted` notice (display name, invite note and short id, uses so far / allowed, bitácora link). No email address, like the other admin alerts. Queued after commit; bounded by its own daily cap, separate from the admin-account alert cap. Details: `docs/coordination/WP-2.3b.md`.

## Consequences

- Adding a field to a response means changing the interface **and** its schema. `satisfies` makes the compiler enforce this in one direction: a schema can't omit a field the interface requires.
- Phase-1 tracks can add schemas to their own module file, but must not rename anything exported here without going through the orchestrator.
- Web code must build the `packages/types` `dist/` before Vite dev (`turbo` already does this for `build` and `typecheck`).
