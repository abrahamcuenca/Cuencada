# WP-2.3c Breached-password check (ASVS 2.1.7) [SEC]
Owner: Senior JS Backend Engineer (with the matching FE change) · Reviewers: Security, TL · Branch: wp/2.3c-breached-passwords · PR: # (not opened)

Based on `origin/main` (bc2d3d5). Comes from the owner's decision on WP-2.3 finding L5: build a breached-password check before launch.

## Scope
- **Service** `apps/server/src/lib/breachedPasswords.ts` (new):
  - Have I Been Pwned range API with k-anonymity: `GET https://api.pwnedpasswords.com/range/<first 5 hex of SHA-1>` with `Add-Padding: true` and `User-Agent: cuencada`, via Node's built-in `fetch` (no new dependency).
  - Only the 5-char prefix leaves the server. The 35-char suffix is looked up locally in the parsed answer. Padding entries (count 0) and malformed lines are ignored.
  - 1.5 s timeout (one `AbortController`, covers headers and body), `redirect: "error"`, and a 512 KiB body cap enforced from `content-length` and while streaming. Over the cap counts as unavailable (`oversized`).
  - Threshold: reject when the count is ≥ `PASSWORD_BREACH_MIN_COUNT` (default 1, the ASVS default).
  - A small LRU cache of the **outcome per password** (its breach count): at most 2000 entries (~150 bytes each, well under 1 MB), 10-minute TTL. The key is HMAC-SHA-256 of the full SHA-1 under a random per-process key, so memory never holds the plain unsalted SHA-1. Failed lookups are not cached. (Was a whole-bucket cache per prefix; TL review: tens of MB at worst on a < 1 GB VPS and rare hits.)
  - `assertPasswordNotBreached(checker, password, path)` throws the route error.
- **Wiring:**
  - `config.ts`: `PASSWORD_BREACH_CHECK=on|off` (case-insensitive, blank = default; defaults to `off` under `NODE_ENV=test`, `on` otherwise) and `PASSWORD_BREACH_MIN_COUNT` (integer 1–1,000,000, default 1). Both are validated and tested in `config.test.ts`.
  - `app.ts`: new decorator `app.breachedPasswords` and the injectable `AppDeps.breachFetcher` (tests only). This touches the frozen `app.ts`/`config.ts` (Phase 0 ownership rule) minimally: one decorator and two config keys. There was no other way to inject the HTTP boundary.
  - `.env.example` and `infra/project.yml` (`server.env`: `PASSWORD_BREACH_CHECK: "on"`, `PASSWORD_BREACH_MIN_COUNT: "1"`, both non-secret literals).
- **Routes** (where a user chooses a password):
  - `POST /api/invites/accept` → detail on `password`.
  - `POST /api/auth/change-password` → detail on `newPassword`.
  - `POST /api/auth/password-reset/confirm` → detail on `newPassword`.
- **Seed:** `assertSeedPasswordNotBreached` runs in `main()` when `NODE_ENV=production` (unless `PASSWORD_BREACH_CHECK=off`). A breached `SEED_ADMIN_TEMP_PASSWORD` fails the seed with "SEED_ADMIN_TEMP_PASSWORD appears in known data breaches (Have I Been Pwned). Generate a new random one in vault." The seed also fails open (stderr warning) when HIBP is unreachable, since the admin is forced to change that password at first login, where the API checks it.
- **Contract** (`packages/types`):
  - `common.ts`: `ValidationIssueCode = { PASSWORD_BREACHED }` (exported constant) and an optional `code` on `ApiErrorDetail` / `apiErrorDetailSchema`. The wire schema accepts **any** string up to 64 chars (`API_ERROR_DETAIL_CODE_MAX`), so an older client still parses an error carrying a code it doesn't know; the web branches only on the known value. The barrel is untouched.
  - `auth.ts`: `PASSWORD_BREACHED_MESSAGE` = "Esta contraseña apareció en filtraciones de datos conocidas. Elige otra."
  - `plugins/errors.ts`: `capErrorDetails` keeps a detail's `code`.
- **Frontend** (`apps/web/src/features/auth`):
  - `forms.ts`: `breachedPasswordError(error, field)`.
  - `InvitePage`, `ChangePasswordPage`, `ResetPasswordPage`: show the message on the password field (`aria-invalid`, focused), keep the form and the token.
  - No client-side check: the browser never calls a third party, so the CSP is unchanged.
- **Not touched:** admin temporary-password flows (there is no admin route that sets a password; temporary passwords force a change at first login, which is checked), `apps/server/src/__tests__/security/**`, DB schema and migrations.

## Decisions
1. **Fail-open.** A timeout, network error, non-200, redirect or oversized body allows the password and logs a structured warn: `{ event: "password.breach_check_unavailable", reason: "timeout" | "network" | "status" | "redirect" | "oversized" | "body", upstreamStatus?, unavailableTotal }`.
   - **Redirects (Security L2):** the fetch uses `redirect: "error"`, so a 3xx is never followed off `api.pwnedpasswords.com`. fetch rejects it (`network`); a 3xx surfaced by any other fetcher counts as `redirect`.
   - **Body cap (Security L1):** a `content-length` over 512 KiB is refused before reading. Otherwise the body is streamed with a running byte cap; past 512 KiB the request is aborted through its `AbortController` (the same one as the 1.5 s timeout) and the result is `oversized`. Nothing past the cap is buffered. No password, hash, prefix or suffix is logged. (The keys avoid the logger's `password`/`hash` redaction patterns on purpose, so the event stays readable.) Rationale: a third-party outage or a firewall block must not stop every signup and reset. The 12-character policy still applies, and the counter makes a persistent outage visible.
2. **Error shape: `VALIDATION`, not a new `ErrorCode`.** It is a field problem the user can fix, and every client already handles 400 `VALIDATION` without logging out. The stable machine-readable reason is the new optional detail `code: "PASSWORD_BREACHED"`, on `path: "password"` or `"newPassword"` (matching each route's body field). The web branches on that code, never on the message text.
3. **Ordering and single-use tokens.** The check runs after the zod body validation and **before** argon2 hashing, the DB transaction and any token or invite lookup. A breached password therefore never consumes the reset token or an invite use: the user can retry with the same link (tested: the token's `used_at` stays null, the invite's `use_count` stays 0, and the retry succeeds). The check is a plain `await` in the handler before any state change, so there is no race that skips it: every path to the hash/write goes through it.
   - Side effect: with a breached password, a dead invite/reset token answers `PASSWORD_BREACHED` rather than `INVITE_INVALID`/`TOKEN_INVALID`. That reveals nothing about the token (the breach status is public data about the password).
   - change-password runs the check before verifying the current password (argon2), as required. A caller with a stolen session learns nothing new from it.
4. **Outbound calls are bounded by existing rate limits** (confirmed in the route configs): invite accept 10/15 min per IP plus 5/15 min per invite token; change-password 20/15 min per IP plus 10/15 min per user; reset confirm 10/15 min per IP; plus the global 300/min per IP. The outcome cache cuts repeat calls further.
5. **Tests default to `off`** (`NODE_ENV=test` default), so no test can reach the network. Tests that exercise the check pass `config: { PASSWORD_BREACH_CHECK: "on" }` and a fake `breachFetcher` (`test/helpers/breach.ts`); that is the only mocked boundary.

## Egress, nginx and firewall
- `server_1` needs **outbound HTTPS (443) to `api.pwnedpasswords.com`** (Cloudflare-fronted, so allow by hostname or permit 443 egress). Read-only check in `docs/deploy/runbook.md` § 1 (pre-flight step 10).
- nginx needs no change: the call is server-side, not proxied. The SPA CSP is unchanged.
- If egress is blocked, nothing breaks; the check is silently skipped except for the warn logs. After deploy, grep the API log for `password.breach_check_unavailable`.
- **Alert:** in `docs/deploy/runbook.md` § 10 (alert rules): "Breached-password check unavailable", `count_over_time({unit="cuencada-server.service"} | json | event="password.breach_check_unavailable" [5m])` > 0 for 15 minutes (the `unavailableTotal` counter keeps rising). That means egress is blocked or HIBP is down, and the check is effectively off. A single warn is not actionable.
- The one-off prod seed, run from the operator's machine, needs the same egress (or `PASSWORD_BREACH_CHECK=off` with a password generated by the vault).

## Interfaces consumed / exposed
- Exposed: `ValidationIssueCode`, `API_ERROR_DETAIL_CODE_MAX`, `ApiErrorDetail.code?` (open string), `PASSWORD_BREACHED_MESSAGE` (`@cuencada/types`); `app.breachedPasswords`; `AppDeps.breachFetcher`; `createTestApp({ breachFetcher })`.
- Consumed: `api.pwnedpasswords.com/range/*`.

## Tests
- `lib/breachedPasswords.test.ts`: SHA-1 prefix/suffix (public test vector), padding entries ignored, only the prefix in the URL, headers, threshold, disabled → no request, timeout → fail-open + warn, non-200 and network error → fail-open + warn, no password/hash/prefix/suffix in the logs (logger spy), cache TTL and LRU eviction, failed lookups not cached, the route error shape.
- `modules/auth/breachedPasswordRoutes.test.ts` (real Postgres, `inject()`): each of the three routes answers 400 on the right path; invite not consumed and reset token not burned, and a retry with a good password succeeds; change-password keeps the session; upstream 503 → fail-open with the event in the log and no password; `off` → no request.
- `config.test.ts`, `seed.test.ts`, `plugins/errors.test.ts`, `packages/types/src/common.test.ts`.
- Web: the message on the field (focused, `aria-invalid`) for `InvitePage`, `ChangePasswordPage` and `ResetPasswordPage`; the reset retry reuses the link.

## Open questions (→ orchestrator)
- ~~**WP-2.4 overlap**~~ Resolved when merging #38 (main 43f2be9): both keys are non-secret and sit in `server.env` (not `server.credentials`); `CONFIG_ENV_KEYS` picks them up for the preflight; the runbook's pre-launch gate is marked done, with the egress check and the alert added.

## Review log
- PR #39, Security: APPROVED with two Lows, both folded in. L1: the body cap is now enforced from `content-length` and while streaming (abort + `oversized`); before, it was checked only after `response.text()` buffered everything. L2: `redirect: "error"`, and a 3xx counts as fail-open. Ops: the alert on a rising `password.breach_check_unavailable` counter is documented above and in the backlog.
- PR #39, TL: APPROVED with two non-blocking items, both folded in. Cache: per-password outcome (HMAC-keyed count, bounded LRU, TTL) instead of whole prefix buckets. Contract: the detail `code` is an open string on the wire (an unknown code parses; tested in `common.test.ts` and `forms.test.ts`).
