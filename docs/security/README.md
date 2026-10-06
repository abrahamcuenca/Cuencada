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
- **`authz-matrix.test.ts`**:
  - Every route is called by 7 principals with a minimal **valid** request:
    anonymous, verified member, unverified member, member pending a password
    change, disabled user with an old token, revoked session, and admin.
    Because the request is valid, a denial proves the guard decided, not
    validation.
  - 27 extra probes as a verified member. A probe re-reads the rows it must
    not touch, before and after the request, and fails on any change:
    - IDOR on another member's session, avatar intent, media in every state
      (hidden, pending review, pending upload, processing, failed) and chat
      message;
    - hidden-room chat history, read state and delete;
    - reporting your own item;
    - mass assignment on `PATCH /api/family/me` (and its alias) and on
      `PUT …/rsvp/me`.
  - 6 CSRF header variants on the cookie routes.
  - WebSocket upgrades: anonymous, unverified, revoked, plus a control.
- **`pii-leak.test.ts`**: scans the bodies of directory, family, attendees,
  chat, media, profile, edition and admin reads. It looks for hidden fields,
  other people's emails or phones (matched on digits), argon2 or 64-hex
  hashes, JWTs, raw object keys, opaque-token-shaped values, the planted raw
  tokens, IPs, bucket names, presigned PUT URLs, the unlisted member's name
  in directory bodies, and the body of a deleted chat message. It also scans
  the chat WebSocket frames. It uses the real S3 presigner, and a self-test
  proves the scanner catches each leak class.
- **`verified-gating.test.ts`**: unverified members get 403
  `EMAIL_UNVERIFIED` and no data on every media route and on the member
  edition details. Announcements and the RSVP summary stay open to them.
- **`cache-lifetimes.test.ts`**: stored photos and avatars are cached
  privately, for no longer than their presigned URL.
- **`headers.test.ts`**: checks HSTS, nosniff, DENY, no-referrer, CORP and
  the full CSP on 200, 401 and 404 responses. It also checks CORS
  (allowlisted origins only) and `Cache-Control: no-store`.

## Matrix summary

99 routes: 14 public, 37 user (21 of them need a verified email), 45 admin,
2 cookie, and the CORS preflight. That makes 693 principal checks plus 27
probes, and all of them match the expected status. The guard behaved exactly
as designed: no route was more open than declared. The one design gap, media
and member links being open to unverified members, was fixed as M2.

| Principal | Public | User | User + verified | Admin | Cookie |
|---|---|---|---|---|---|
| Anonymous | 2xx | 401 | 401 | 401 | 401 (403 without CSRF) |
| Verified member | 2xx | 2xx | 2xx | 403 `FORBIDDEN` | 2xx |
| Unverified member | 2xx | 2xx | 403 `EMAIL_UNVERIFIED` | 403 | 2xx |
| Pending password change | 2xx | 403 `PASSWORD_CHANGE_REQUIRED` (2xx on `/me` and change-password) | 403 | 403 | 2xx |
| Disabled (old token) | 2xx (credential endpoints 400/401) | 401 | 401 | 401 | 401 refresh / 2xx logout |
| Revoked session | 2xx | 401 | 401 | 401 | 401 |
| Admin | 2xx | 2xx | 2xx | 2xx | 2xx |
| Other member (probes) | n/a | 404 on sessions, avatar confirm, media in any non-public state (read, edit, delete, confirm, report), chat delete, hidden-room history/read/delete, unlisted directory entry; 403 for reporting your own item; mass assignment has no effect | | | |

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
| M2 (was L2) | **Medium** (A01) | Unverified members could read the gallery (photos, uploader names) and the member edition details (WhatsApp/album links), and could upload and report. That is inconsistent with ADR 0001's "every other PII read". | **Fixed** by owner decision: `requireVerifiedEmail` on every media route and on `/cuencadas/:year/members`; announcements and the RSVP summary stay open (`verified-gating.test.ts`, ADR 0001). Residual: a leaked open invite lets a stranger verify their own mailbox (threat model A2; stricter open invites planned). |
| L3 | Low | The API CSP from `contentSecurityPolicy(config)` (`base-uri 'self'`, `frame-src 'self' …`) is looser than the documented SPA policy. | WP-2.4 checklist: paste the `csp.md` string verbatim |
| L4 | Low | The CI Postgres service image is pinned by tag, not digest. | Backlog |
| L5 | Low | No breached-password check (ASVS 2.1.7). | **Fixed** (WP-2.3c): HIBP k-anonymity check on invite accept, change and reset (`lib/breachedPasswords.ts`); fails open with a warn log. New egress: `api.pwnedpasswords.com` (threat model TB7). |
| L6 | Low | Stored photos and avatars carried `private, max-age=31536000, immutable`, so they stayed in a shared browser's disk cache for a year after logout. | **Fixed:** `private, max-age=3600`, no longer than the presigned GET (`cache-lifetimes.test.ts`). The residual hour is accepted (threat model A9). |

No High was found.
