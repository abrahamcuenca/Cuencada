# WP-T1-BE Auth, sessions & invites [SEC]
Owner: Senior JS Backend Engineer · Reviewers: TL, Security · Branch: wp/t1-be-auth · PR: # (not opened)

Based on `origin/main` (2363af2, WP-0.4 merged).

## Scope
- `apps/server/src/modules/auth/**`:
  - `sessionRoutes.ts`: login, refresh, logout, logout-all, `/me`, session list/delete, revoke-others
  - `passwordRoutes.ts`: change-password, password-reset request/confirm
  - `emailRoutes.ts`: magic-link request/consume, email verify-request/verify
  - `sessions.ts`: session start, revocation, refresh-token rotation (`SELECT … FOR UPDATE`)
  - `cookies.ts`: refresh cookie
  - `currentUser.ts`: `CurrentUser` / `AuthTokenResponse` from the DB
  - `emailTokens.ts`: single-use `magic_links` tokens, audit action names, background mail
- `apps/server/src/modules/invites/**`:
  - `publicRoutes.ts`: inspect, accept
  - `adminRoutes.ts`: list, create, revoke, resend
  - `service.ts`: helpers
- Removed: the WP-0.4 bridge login/`/me`/change-password/magic-link stub and its tests in `src/app.test.ts`. They are re-covered, against the contract shapes, by the module tests.
- Tests: `modules/auth/{sessionRoutes,passwordRoutes,emailRoutes}.test.ts` and `modules/invites/invites.test.ts`, 71 tests. They use real Postgres, `inject()`, `FakeMailer`, an injected `TestClock` and a captured log stream. New test helper: `test/helpers/auth.ts` (`loginFull`, `refreshCookie`, `withRefreshCookie`, `CSRF_HEADERS`, `linkToken`, `TestClock`). The `loginAs` doc in `factories.ts` was updated.
- Contract amendments in `packages/types/src/auth.ts`, plus tests (listed below).
- ADR 0001: the "Open" item is now decided (see Decisions).

## Interfaces consumed / exposed
**Consumed** (all frozen, none edited):
- WP-0.4 guard (`config.auth`, `allowPendingPasswordChange`, CSRF on `"cookie"` routes)
- `lib/tokens`, `lib/passwords`, `lib/rateLimit` (`credentialRateLimits`, `extraRateLimitHook`, `rateLimitByIp`), `lib/audit`, `lib/mailer` (`sendTemplate`, `appLink`), `lib/errors`
- `app.jobs`, `app.clock`, `app.storage`
- schema tables `users`, `sessions`, `refresh_tokens`, `invites`, `magic_links`, `profiles`, `people`

**Exposed:** every T1 row of the WP-0.2 table, plus the amendments.

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/auth/login` | P | `credentialRateLimits`. 200 `AuthTokenResponse` + cookie. One 401 `INVALID_CREDENTIALS` for every failure, with a dummy argon2 verify for unknown emails |
| POST | `/api/auth/refresh` | C | 60/min/IP. Rotation; 409 `REFRESH_RACE` within 20 s; reuse after 20 s → session revoked (`refresh_reuse`) + audit + 401; every 401 clears the cookie |
| POST | `/api/auth/logout` | C | 204 and clears the cookie; **401** (also clears it) when there is no cookie or the session is already dead |
| POST | `/api/auth/logout-all` | U | **new**. Revokes all of the caller's sessions (`user_revoked`), including the current one; clears the cookie; 204 |
| GET | `/api/me` | U\* | `CurrentUser` from the DB (`personId` via `people.user_id`, avatar presigned for 1 h; `null` and a warn log if presigning fails) |
| POST | `/api/auth/change-password` | U\* | 20/15 min per IP + 10/15 min per user |
| POST | `/api/auth/magic-link/request` | P | `credentialRateLimits`; always 202 |
| POST | `/api/auth/magic-link/consume` | P | 20/15 min/IP |
| POST | `/api/auth/password-reset/request` | P | `credentialRateLimits`; always 202 |
| POST | `/api/auth/password-reset/confirm` | P | 10/15 min/IP; 204, no login |
| POST | `/api/auth/email/verify-request` | U | **3/15 min per user**; always 202 |
| POST | `/api/auth/email/verify` | P | 20/15 min/IP; 204 |
| GET | `/api/auth/sessions` | U | live sessions only, at most 100, `current` flag |
| DELETE | `/api/auth/sessions/:id` | U | 404 for anything that isn't the caller's live session |
| POST | `/api/auth/sessions/revoke-others` | U | `revoke_others` |
| POST | `/api/invites/inspect` | P | 30/15 min/IP |
| POST | `/api/invites/accept` | P | 10/15 min/IP **+ 5/15 min per token hash** |
| GET | `/api/admin/invites` | A | keyset cursor; `status` filter uses the effective status (pending past expiry = `expired`) |
| POST | `/api/admin/invites` | A | 201; `inviteUrl` only for copy-link invites |
| POST | `/api/admin/invites/:id/revoke` | A | idempotent; 409 once accepted |
| POST | `/api/admin/invites/:id/resend` | A | **new**. Rotates the token, emails it, sets `last_sent_at`; 409 unless pending, unexpired and email-bound |

### Contract amendments (`packages/types/src/auth.ts`), for orchestrator sign-off
1. **`POST /api/auth/logout-all`** (U, 204) is documented next to the session schemas. It has no body, so no new schema.
2. **`displayNameSchema`** also rejects names made only of blank-rendering characters (U+3164, U+115F/1160, U+FFA0, U+2060–2064, U+00AD, U+034F, U+180E, U+17B4/17B5, U+2800, ZW*, whitespace). New export: `hasVisibleNameChars()`. `profile.ts` reuses `displayNameSchema`, so the rule applies there too.
3. **`adminInviteCreateInputSchema`:** email-bound ⇒ `maxUses === 1` (refinement on `maxUses`). The service also forces `max_uses = 1` for bound invites.
4. **`AdminInviteCreated.inviteUrl` is now `string | null`:** `null` when `sendEmail` is true. An emailed invite therefore has no copy-link, and the "delivered by email ⇒ verified" rule can't be bypassed by sharing the link.
5. **`AdminInviteListItem.lastSentAt: string | null`** (additive), so the admin UI can show "enviada" and offer resend.
6. **`POST /api/admin/invites/:id/resend`** (A) → `AdminInviteListItem`, documented in a comment.
7. **`REFRESH_COOKIE_INSECURE = "cuencada_rt"`**: the dev/http cookie name (browsers reject a `__Secure-` cookie without `Secure`).

No web code consumed the changed shapes (checked with grep), so `apps/web` needs no change.

## Decisions
- **Contract over brief where they differ:**
  - inspect answers 400 `INVITE_INVALID` (one generic body for unknown, expired, used and revoked), not `{ valid: false }`
  - the verify paths are `/api/auth/email/verify-request` and `/api/auth/email/verify`
  - reset confirm returns 204 and does not log in
- **No `pending_verification` user status exists** (`UserStatus` = `active | disabled`). Login rejects only `disabled`. Unverified users can log in; T5/T6 gate PII with `requireVerifiedEmail`.
- **Change-password starts a new session.** It revokes **every** session, including the caller's (`password_changed`), and starts a new one for this device. So any copy of the old access token or refresh token dies immediately, which satisfies "revoke others and rotate current" (WP-0.4 T1 item: "new session + new access token + refresh cookie"). It also burns outstanding reset links.
- **Change-password rate limit.** I did not use `credentialRateLimits` here. Its email keys come from the body, which has no `email`, so the "per email across IPs" cap would become one global bucket shared by all users. Instead: 20/15 min per IP (`config.rateLimit`) plus 10/15 min per user (`extraRateLimitHook` keyed on `request.user.id`). Reset confirm uses a per-IP limit for the same reason; its tokens carry 256 bits.
- **Email sends on the request endpoints** (magic link, reset, verify, password-changed notice) run on `app.jobs`, off the request path. Known and unknown emails therefore answer in the same time. The known path adds one small insert; a test asserts similar timing. Trade-off: the queue is serial and shared with T4 media processing, so an email can wait behind an image job; that's fine at family scale. Invite emails are awaited instead, so the admin sees a failure: 503 `SERVICE_UNAVAILABLE`, the invite stays pending with `last_sent_at = null`, and Resend can retry it.
- **Idempotency keys** come from row ids, never from tokens: `magic-link:<id>`, `password-reset:<id>`, `verify-email:<id>`, `password-changed:<sessionId|magicLinkId>`, `invite:<id>:<sentAtMs>`.
- **Refresh token rows** expire with the session's idle expiry at issue time. The idle expiry slides on refresh and is capped at the absolute expiry. Cookie `Max-Age` = seconds until that expiry. Tokens are locked `FOR UPDATE` together with their session row.
- **Logout** finds the session from any of its refresh tokens, including one already rotated by another tab, so logging out from a stale tab still works.
- **`emailVerified` is set** by:
  - accepting an invite that was email-bound **and** has `last_sent_at` set (it was sent or resent by email)
  - a magic-link login
  - a password reset
  - a verify link

  The last three count only when the link was sent to the account's **current** address.
- **Invite accept:**
  - hashes the password before locking the invite row
  - creates the user, a profile (`full_name` = display name) and a `people` row: it links `invite.person_id` if that person is still unlinked, otherwise it creates a new person
  - sets `users.invited_by_invite_id`
  - increments `use_count`, and sets `status=accepted` only when the invite is exhausted (open invites stay pending until then)
  - an existing email gives 409 "Ya tienes cuenta, inicia sesión." (also on a concurrent insert race, via `ON CONFLICT DO NOTHING`)
- **Admin create:**
  - 409 if the bound email already has an account
  - 400 `VALIDATION` (`personId`) if the person is missing or already linked
  - the person's name becomes `invites.display_name` (the suggested name)
  - audit metadata holds no email address
- **Audit actions:**
  - `auth.logged_in`, `auth.login_failed` (known users only; reason `bad_password`/`inactive`)
  - `auth.logged_out`, `auth.session_revoked`, `auth.sessions_revoked`, `auth.refresh_reuse_detected`
  - `auth.password_changed`, `auth.password_reset`, `auth.password_reset_requested`
  - `auth.magic_link_requested`, `auth.email_verification_requested`, `auth.email_verified`
  - `invite.created`, `invite.revoked`, `invite.resent`, `invite.accepted`
- **ADR 0001 (decided):** unverified members get 403 on the directory, the family tree and other PII reads through `requireVerifiedEmail: true`. **T5 and T6 must set it** on those routes.
- `logout-all` is a plain `U` route. A user who must still change their password gets 403 there, but change-password itself revokes every session.

### Orchestrator / security notes from the PR #10 review (addressed)
1. **Invite accept is rate-limited per token hash** (`INVITE_ACCEPT_PER_TOKEN` = 5 / 15 min, keyed on `sha256(token)`, never the raw token), on top of 10/15 min per IP. A test drives 6 attempts from 6 IPs against one open invite (5 × 409, then 429) and checks that another invite is unaffected.
2. **Verify-email request is rate-limited to 3 / 15 min per user.** The rate-limit plugin runs it in `preHandler`, after the guard, keyed on `request.user.id`. It always answers a generic 202, also for already-verified users, who get no email. A test checks 202 ×3 and then 429, and that another user is unaffected.
3. **Magic-link consume and invite accept ignore any `Authorization` header** (they are `auth: "public"`, so the guard never loads a user). The previous user's session is not read, extended or revoked, and the response is built only from the link's user. Tests send user A's bearer while consuming user B's link or accepting an invite: the response contains nothing from A. The magic-link test also checks that A's session row is unchanged, and the invite test that A's token still resolves to A.

## Requests (→ orchestrator)
- **Audit actions in the contract:** add the `auth.*`/`invite.resent` actions above to `AuditAction` in `packages/types/src/admin.ts` (owned by T8/Phase 0) so the admin audit view can label them. They already pass `auditActionSchema`.
- **`SessionRevokedReason` has no "logout all" value:** `logout-all` uses `user_revoked`. If T8 wants to tell "user revoked one session" from "user logged out everywhere", add `logout_all` in a future WP-2.1 migration.
- **Mail queue isolation (optional):** a separate job queue (or priority) for emails in `lib/jobs.ts`, so a long sharp job (T4) can't delay a magic-link email.
- **WP-2.4:** `/api/auth/*` responses carry `Set-Cookie`. nginx must not cache them and must forward `Origin` unchanged (the CSRF check compares it exactly).

## Verification
`pnpm lint`, `pnpm typecheck`, `pnpm test` (546 tests; server 232, two extra server runs also green), `pnpm build`, `pnpm audit --prod` (no known vulnerabilities).

## Review log
- (none yet)
