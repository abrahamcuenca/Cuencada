# Security

This folder holds the WP-2.3 security audit (2026-10-06), run against `main`
@ `28c55aa`.

| Document | Contents |
|---|---|
| [routes.md](routes.md) | Generated inventory of all 99 routes: guard config plus the expected status for each principal |
| [threat-model.md](threat-model.md) | Assets, actors, trust boundaries, STRIDE per component, accepted risks, open items |
| [owasp-checklist.md](owasp-checklist.md) | OWASP Top 10 (2021 and 2025) and ASVS 4.0.3 L2 status, with evidence |
| [csp.md](csp.md) | The SPA CSP that nginx must send (WP-2.4), and its headless-Chromium verification |
| [dependencies.md](dependencies.md) | `pnpm audit`, production licenses, GitHub Actions pins |
| [csp-check.mjs](csp-check.mjs) | Harness that serves the built SPA with the CSP against the real API and checks for violations |

## Automated checks

All of these live in `apps/server/src/__tests__/security/` and run in CI with
real Postgres:

- **`inventory.test.ts`**: records every route through an `onRoute` hook. It
  **fails when a route is added without being classified** in
  `routeMatrix.ts`. It also fails when a route's `config.auth`,
  `requireVerifiedEmail` or `allowPendingPasswordChange` changes, when a
  route omits `config.auth`, when HEAD twins drift from their GET, and when
  `routes.md` is stale. Regenerate `routes.md` with
  `UPDATE_SECURITY_DOCS=1 pnpm --filter @cuencada/server test -- inventory`.
- **`authz-matrix.test.ts`** (105 tests):
  - Every route is called by 7 principals with a minimal **valid** request:
    anonymous, verified member, unverified member, member pending a password
    change, disabled user with an old token, revoked session, and admin.
    Because the request is valid, a denial proves the guard decided, not
    validation.
  - 9 "other member" IDOR probes.
  - 6 CSRF header variants on the cookie routes.
  - WebSocket upgrades: anonymous, unverified, revoked, plus a control.
- **`pii-leak.test.ts`**: scans the bodies of directory, family, attendees,
  chat, media, profile, edition and admin reads. It looks for hidden fields,
  other people's emails or phones, argon2 or 64-hex hashes, IPs, object keys,
  bucket names and presigned PUT URLs. It uses the real S3 presigner, and a
  self-test proves the scanner catches each leak class.
- **`headers.test.ts`**: checks HSTS, nosniff, DENY, no-referrer, CORP and
  the full CSP on 200, 401 and 404 responses. It also checks CORS
  (allowlisted origins only) and `Cache-Control: no-store`.

## Matrix summary

99 routes: 14 public, 37 user, 45 admin, 2 cookie, and the CORS preflight.
That makes 693 principal checks plus 9 IDOR probes, and all of them match the
expected status. The guard behaved exactly as designed: no route was more
open than declared.

| Principal | Public | User | User + verified | Admin | Cookie |
|---|---|---|---|---|---|
| Anonymous | 2xx | 401 | 401 | 401 | 401 (403 without CSRF) |
| Verified member | 2xx | 2xx | 2xx | 403 `FORBIDDEN` | 2xx |
| Unverified member | 2xx | 2xx | 403 `EMAIL_UNVERIFIED` | 403 | 2xx |
| Pending password change | 2xx | 403 `PASSWORD_CHANGE_REQUIRED` (2xx on `/me` and change-password) | 403 | 403 | 2xx |
| Disabled (old token) | 2xx (credential endpoints 400/401) | 401 | 401 | 401 | 401 refresh / 2xx logout |
| Revoked session | 2xx | 401 | 401 | 401 | 401 |
| Admin | 2xx | 2xx | 2xx | 2xx | 2xx |
| Other member (IDOR) | n/a | 404 on sessions, media confirm/read-hidden/edit/delete, avatar confirm, chat delete, unlisted directory entry | | | |

These results were judgment calls, all accepted:

- A disabled user's refresh cookie can still **log out** (204). Logout only
  revokes that session.
- Public credential endpoints answer a disabled user exactly as they answer a
  wrong password: 401 `INVALID_CREDENTIALS` for login, and 400
  `TOKEN_INVALID` for magic-link, reset and verify tokens.

## Findings

| Id | Severity | Finding | Status |
|---|---|---|---|
| M1 | Medium | API responses had no `Cache-Control`. Directory and family PII and token bodies could be kept in the browser's HTTP cache after logout on a shared computer (ASVS 8.2.1). | **Fixed** (`plugins/security.ts`, regression test in `headers.test.ts`) |
| L1 | Low | zod 4's `new Function` probe triggers one blocked-`eval` CSP violation per page load. | Backlog (0.8c): `z.config({ jitless: true })` |
| L2 | Low / decision | Unverified members can read the gallery (uploader names), member edition links, announcements and the RSVP summary. That is inconsistent with ADR 0001's "every other PII read". | Backlog (owner decision) |
| L3 | Low | The API CSP from `contentSecurityPolicy(config)` (`base-uri 'self'`, `frame-src 'self' …`) is looser than the documented SPA policy. | Backlog (WP-2.4) |
| L4 | Low | The CI Postgres service image is pinned by tag, not digest. | Backlog |
| L5 | Low | No breached-password check (ASVS 2.1.7). | Backlog |

No High was found.
