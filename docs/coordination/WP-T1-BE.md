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
- `app.jobs` (only to key the mail queue), `app.clock`, `app.storage`
- schema tables `users`, `sessions`, `refresh_tokens`, `invites`, `magic_links`, `profiles`, `people`

**Exposed:** every T1 row of the WP-0.2 table, plus the amendments.

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/auth/login` | P | `credentialRateLimits`. 200 `AuthTokenResponse` + cookie. One 401 `INVALID_CREDENTIALS` for every failure, with a dummy argon2 verify for unknown emails |
| POST | `/api/auth/refresh` | C | 60/min/IP. Rotation; 409 `REFRESH_RACE` within **10 s** (audited `auth.refresh_race`); reuse after 10 s → session revoked (`refresh_reuse`) + audit + 401; every 401 clears the cookie |
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
- **Email sends on the request endpoints** (magic link, reset, verify, password-changed notice) run off the request path on the auth module's **own serial mail queue** (`modules/auth/mailQueue.ts`: a second `createJobQueue` instance, closed `onClose`; `lib/jobs.ts` untouched), so T4 media jobs on `app.jobs` can never delay them. Known and unknown emails therefore answer the same way and in the same time, whatever the provider latency. Tests: a held mail queue still lets the 202 through with an empty outbox, and an email goes out while a media job blocks `app.jobs`. Invite emails are awaited instead, so the admin sees a failure: 503 `SERVICE_UNAVAILABLE`, the invite stays pending with `last_sent_at = null`, and Resend can retry it.
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

### Security and TL fixes from the PR #14 review
- **M1, mail-bombing and quota exhaustion.** No schema change. Everything is counted from DB rows, so the budgets survive restarts. Code: `modules/auth/mailBudget.ts` and `mailQueue.ts`.
  - **Per recipient:** one gate, `issueBudgetedEmailToken()`, used by magic-link, reset and verify requests.
    - Counts `magic_links` rows for the address, under a transaction-scoped advisory lock on it.
    - `RECIPIENT_MAIL_BUDGET`: one per purpose per 2 min, 3 per hour, 10 per 24 h.
    - Over budget: no token row, no send, a `mail.recipient_budget_exceeded` warn (user id and purpose only), and still the generic 202.
    - `magic_links.created_at` is now written from `app.clock`, so the windows and tests agree on time.
  - **Global, per UTC day:** today's `magic_links` rows + invites with `last_sent_at` today + password-changed notices (counted from their `auth.password_changed`/`auth.password_reset` audit rows).
    - User-triggered emails stop at `GLOBAL_DAILY_MAIL_CAP` = 300.
    - Admin invites and password-changed notices keep `RESERVED_DAILY_MAIL_EXTRA` = 100 on top. Over the reserve, an invite create or resend gets 503 with a Spanish hint, and a notice is skipped.
    - `mail.cap_reached` (warn, no PII: tier, count, cap, day) is logged once per UTC day per process.
    - Known undercount: an invite resent twice in one day counts once, because `last_sent_at` is overwritten. The resend rate limit (10/15 min) bounds it.
  - **Queue:**
    - At most `MAIL_QUEUE_MAX_PENDING` = 500 waiting sends; past that the send is dropped with a `mail.queue_full` warn.
    - Retries: `MAIL_RETRY_ATTEMPTS` = 3 total, exponential backoff from `MAIL_RETRY_BASE_MS` = 200 ms plus up to 50% jitter.
    - Retried: Resend `rate_limit_exceeded`, `application_error`, `internal_server_error`, `concurrent_idempotent_requests`, and network errors.
    - Not retried: validation errors, quota exhaustion, template errors.
    - Retries reuse the same idempotency key. The awaited invite send uses the same retry helper.
  - **Config:** all constants are exported and are candidates for config once `config.ts` is unfrozen.
  - **Tests** (`mailSafety.test.ts`):
    - 40 mixed requests from 40 IPs deliver ≤ 3 emails, and every response is a generic 202 or 429. Deviation: past 10 requests per endpoint per address in 15 min, the existing per-email request limiter answers 429, identically for unknown addresses, so not every response is 202.
    - The 2-min, 3/h and 10/day windows, using the injected clock.
    - Verify-email requests share the budget.
    - The global cap with the invite reserve (and 503 past it), plus the single warning.
    - The queue bound.
    - A 429 is retried and then succeeds, with the same key.
    - A validation error is not retried.
- **L1, refresh grace.**
  - The grace window is now **10 s** (`REFRESH_REUSE_GRACE_MS`).
  - Every 409 race is audited as `auth.refresh_race` (new `AuditAction.RefreshRace`): user, session and IP, never token data.
  - **T1-FE follow-up:** on a second `REFRESH_RACE`, wait past the grace window (about 11 s) and try once more, instead of logging out locally. Then a thief racing the victim turns into reuse detection.
- **L3, burn pending tokens.**
  - Change-password and reset confirm now burn **every** unused `magic_links` row of the user, of every purpose (`burnPendingEmailTokens`).
  - Admin disable is T8's route, which doesn't exist yet. **Request:** T8 calls `burnPendingEmailTokens(tx, userId, now)` (exported from `modules/auth/emailTokens.ts`) when disabling a user.
  - Tests cover both T1 paths.
- **TL, cleanup.** `modules/auth/cleanup.ts` runs every 6 h. The timer is unref'd and cleared `onClose`. Deletes are batched (1000), idempotent and safe across processes.
  - It purges `magic_links` used or expired more than 7 days ago.
  - It purges sessions revoked or expired more than 30 days ago (their tokens cascade).
  - It purges `refresh_tokens` older than 7 days **only for dead sessions**.
  - Deviation from the brief, following the TL note: used tokens of **live** sessions are kept. Deleting them would turn a replayed old rotated token into a plain 401 instead of reuse detection, so a thief's chain would survive. They are bounded by the 90-day session lifetime.
  - Tested with the injected clock: what is kept and what is deleted, and a second run deletes nothing.
- **TL, in-memory mail queue.** Sends still queued at shutdown or deploy are dropped (`close()` aborts them). The user simply asks again, so the web's 202 copy should say "si no llega en unos minutos, vuelve a pedirlo" (T1-FE).
- **TL, residual login timing (L2, accepted).** A failed login for a **known** email also writes an `auth.login_failed` audit row, a millisecond-scale DB write that unknown emails don't pay. The same goes for the token insert on magic-link and reset requests. argon2 (about 50 ms) dominates, and the per-email limits bound sampling. If Security wants this closed later: create tokens and write audits inside the background mail job.
- **TL, grace-window threat note.** Added to ADR 0001.

## Requests (→ orchestrator)
- **0002 migration list (WP-2.1):** add `logout_all` to `SessionRevokedReason`; `logout-all` uses `user_revoked` until then.
- **T8:** call `burnPendingEmailTokens()` on admin disable (Security L3).
- **T1-FE:** the second-`REFRESH_RACE` retry after the grace window (L1), and the "vuelve a pedirlo" copy on the 202 screens.
- **WP-2.4:** `/api/auth/*` responses carry `Set-Cookie`. nginx must not cache them and must forward `Origin` unchanged (the CSRF check compares it exactly).

## Verification
PR #14 round (after merging T1-FE #10): lint, `turbo run typecheck --force` (6/6), build (4/4) and `pnpm audit --prod` green on every run. `pnpm test` (846 tests) was green on full runs 1, 4 and 5, and the server project alone was green 3 times in a row. Runs 2 and 3 hit load-related 5 s timeouts on this shared machine: two server suites (announcements, cuencadas) failed at file level once, and up to 6 web tests from other tracks failed (MSW/UI). None of these are in auth or invites, and none reproduced.

After merging `origin/main` (T2-FE #11, T4-FE #9, T2-BE #12): `pnpm lint`, `pnpm turbo run typecheck --force`, `pnpm test` (714 tests), `pnpm build` and `pnpm audit --prod` all green on two consecutive full runs. Earlier round: 665 tests, 4 consecutive green full runs, `pnpm build`, `pnpm audit --prod` (no known vulnerabilities). One earlier full run under load flaked in the login timing test (now compares the fastest of 5 runs with a 0.25 ratio) and in three web tests from main (T2-FE/T4-FE, not touched here).

## Review log
- **Orchestrator round 1:** every decision and all 7 contract amendments signed off. Follow-ups done:
  - merged `origin/main` (T2-FE #11, T4-FE #9; no conflicts)
  - **authorized:** the `auth.*` actions and `invite.resent` are now in `AuditAction` (`packages/types/src/admin.ts`, with a test that every action passes `auditActionSchema`); `AuthAuditAction` and the invite resend use them
  - **authorized:** a separate mail queue (see Decisions), done without touching frozen files
  - noted: PR #10 (T1-FE) will switch "cerrar en todos los dispositivos" to `POST /api/auth/logout-all`
- **Orchestrator round 2:**
  - merged `origin/main` again (T2-BE #12). `AuditAction` auto-merged to the union of both lists (46 actions, no duplicate keys or values), and the "every action passes `auditActionSchema`" test is kept.
  - **Security condition (PR #10 re-review), confirmed as built:** a verify token is a `magic_links` row bound to `user_id` and to `email` (the address at issue time). `POST /api/auth/email/verify` is `auth: "public"`, so it never reads the caller's session. Consuming the token sets `email_verified_at` only for the row's user, and only while that user's current email still equals the issued one. Otherwise the token is burned and the answer is a generic 400 `TOKEN_INVALID`. Tests: the address changed after issue (400, still unverified), and another user's bearer sent with the owner's token (the owner is verified, the caller is not).
- **PR #14 review (TL approved, Security requested changes; M1 blocking):**
  - merged `origin/main` (T1-FE #10)
  - M1: per-recipient budget, global daily cap with an invite reserve, bounded and retrying mail queue, tests
  - L1: 10 s grace and the `auth.refresh_race` audit (`AuditAction.RefreshRace` added); T1-FE follow-up noted
  - L3: every pending email token is burned on change-password and reset; `burnPendingEmailTokens` is exported for T8's disable
  - TL: periodic cleanup of spent auth rows, plus doc notes (in-memory queue, residual login timing, grace-window threat note in ADR 0001, `logout_all` on the 0002 list)
  - TL nit: the wrong-purpose behaviour is documented in `consumeEmailToken`'s JSDoc
  - The open-invite 409 is unchanged (rate-limited per token)
