# OWASP Top 10 and ASVS L2 checklist

WP-2.3 · Security Engineer · 2026-10-06 · `main` @ `28c55aa` + WP-2.3

Status values: **met**, **partial** (the gap is listed and tracked), and
**N/A**. Evidence paths are relative to the repository root. Test files run in
CI against real Postgres.

The security suite lives in `apps/server/src/__tests__/security/`:

- `inventory.test.ts`: route drift guard. It generates [routes.md](routes.md).
- `authz-matrix.test.ts`: 99 routes × 7 principals, plus IDOR, CSRF and
  WebSocket checks.
- `pii-leak.test.ts`: response-body scans.
- `headers.test.ts`: security headers, CSP, CORS and `no-store`.

## OWASP Top 10

The table covers both the 2021 and 2025 editions.

| 2021 | 2025 | Status | Evidence / notes |
|---|---|---|---|
| A01 Broken Access Control | A01 Broken Access Control | **met** (after M2) | **WP-2.3 M2, fixed:** unverified members could read the gallery and member links; these are now gated with `requireVerifiedEmail` (`verified-gating.test.ts`). Default-deny guard. `config.auth` is required in spirit, and a missing value means `user`. Role, status and must-change come from the DB (`apps/server/src/plugins/auth.ts`). Every route is classified, and a new route fails CI until it is (`inventory.test.ts`). The full matrix and 27 state-checked probes pass (`authz-matrix.test.ts`). CORS uses an exact allowlist (`headers.test.ts`). Cookie routes need CSRF. The WS upgrade needs a ticket and checks `Origin`. |
| A02 Cryptographic Failures | A04 Cryptographic Failures | **met** | argon2id at m = 19 MiB, t = 2 (`lib/passwords.ts`). Opaque tokens use 32 random bytes and are stored only as SHA-256 hashes (`lib/tokens.ts`; `pii-leak.test.ts` confirms no hash is ever serialized). JWTs are HS256 with the algorithm pinned, `iss`/`aud` checked and a secret of ≥ 32 chars in prod (`config.ts`). TLS and HSTS are set (`headers.test.ts`; nginx in WP-2.4). |
| A03 Injection | A05 Injection | **met** | Drizzle uses parameterized queries. `ILIKE` input is escaped (T5, T6). zod validates every body, param and query at the boundary (`fastify-type-provider-zod`). CSV export neutralizes formulas (`modules/rsvp/csv.ts`). The SPA renders text only, with no `dangerouslySetInnerHTML`. CSP has no inline script (`csp.md`). |
| A04 Insecure Design | A06 Insecure Design | **met** | ADR 0001 covers the contracts, the PII guard via response schemas, tokens in fragments, and email-bound admin invites. The threat model is [threat-model.md](threat-model.md). Abuse limits: mail budgets, upload budgets, chat rate limits. |
| A05 Security Misconfiguration | A02 Security Misconfiguration | **partial** | API: helmet with a strict CSP, HSTS, nosniff, DENY, no-referrer, CORP same-origin, no `x-powered-by`, and `no-store` (`headers.test.ts`, WP-2.3 M1 fix). `NODE_ENV` is required, and production refuses insecure config (`config.test.ts`). **Gap: the SPA headers depend on nginx (WP-2.4)**, using the policy in [csp.md](csp.md). Also: restrict `/health*`, and strip `?ticket=` from access logs (cutover checklist). |
| A06 Vulnerable and Outdated Components | A03 Software Supply Chain Failures | **met** | `pnpm audit` is clean (full and prod). Licenses have been reviewed, and Actions are SHA-pinned and current ([dependencies.md](dependencies.md)). `minimumReleaseAge` is 7 days. The lockfile is frozen in CI. |
| A07 Identification and Authentication Failures | A07 Authentication Failures | **met** (one Low) | Passwords need ≥ 12 chars, but there is no breached-password check (L5). Credential rate limits apply per IP, email and IP+email. Login timing is equalized. Refresh rotation detects reuse. Sessions have idle (30 d) and absolute (90 d) expiry. Logout, logout-all, revoke-others and admin revoke are available. A temporary password forces a change. Request endpoints answer a generic 202 (`modules/auth/*.test.ts`). |
| A08 Software and Data Integrity Failures | A08 Software or Data Integrity Failures | **met** | Uploads are verified server-side: HEAD size and type, magic bytes, then re-encode (`modules/media/*.test.ts`, `profile/avatar.test.ts`). No `eval`, and CSP blocks it. The SW precache is hashed by Workbox. CI permissions are `contents: read`. The `@fastify/swagger` peer is unused. |
| A09 Security Logging and Monitoring Failures | A09 Security Logging and Alerting Failures | **partial** | There are audit rows for every sensitive mutation, with redacted metadata (`lib/audit.ts`). Pino logs redact recursively, and DB errors are scrubbed (`logging.test.ts`). Admins are alerted on role and status changes. **Gap:** no alerting on `mail.cap_reached` / `mail.queue_full` and no auth-failure dashboards yet (backlog, Observability). |
| A10 Server-Side Request Forgery (2021) | N/A | **met** | The server fetches nothing user-supplied. Admin links (`https://` only, canonical) are rendered, never fetched. S3 calls use server-generated keys on the configured endpoint. |
| N/A | A10 Mishandling of Exceptional Conditions | **met** | One error handler. Unexpected errors become a generic 500 and are logged without PII (`plugins/errors.test.ts`). zod failures become 400 `VALIDATION` with capped details. Response serialization fails closed (ADR 0001 §2). Jobs and mail retries log failures. |

## ASVS 4.0.3 Level 2, chapter by chapter

| ASVS | Area | Status | Evidence / notes |
|---|---|---|---|
| V1 | Architecture, threat modeling | **met** | [threat-model.md](threat-model.md), ADR 0001, coordination WPs, and a security review on every [SEC] PR. |
| V2.1 | Password security | **partial** | Min 12 chars, no composition rules, max length bounded (`packages/types/src/auth.ts`). Change requires the current password. **Gap (WP-2.3 L5):** no breached-password check (2.1.7). Suggested fix: an offline top-100k list on set/change/reset, or HIBP k-anonymity. |
| V2.2 | General authenticator security | **met** | Anti-automation (credential rate limits, mail budgets). Users are notified of password changes (`password-changed` email) and admins of role changes. |
| V2.4 | Credential storage | **met** | argon2id; `needsRehash` upgrades parameters on login. |
| V2.5 | Credential recovery | **met** | Reset tokens are single-use, last 30 min and are hashed. A reset revokes every session. The response is a generic 202. |
| V2.7/2.8 | Out-of-band / one-time tokens | **met** | Magic links last 15 min, are single-use and hashed, and are bound to the user and address. Email verification links last 24 h. |
| V3.1–3.3 | Session management, termination | **met** | Sessions live server-side, are checked on every request, and support logout, logout-all, revoke-others, password-change revoke, admin revoke and disable (matrix "revoked"/"disabled" columns). |
| V3.4 | Cookie-based session management | **met** | `__Secure-` prefix, HttpOnly, Secure, SameSite=Strict, `Path=/api/auth` (`modules/auth/cookies.ts`, `sessionRoutes.test.ts`). |
| V3.5 | Token-based session management | **met** | The access JWT lasts 15 min and lives in memory only. Refresh rotation is single-use and detects reuse. |
| V3.7 | Defenses against session exploits | **met** | Re-authentication with the current password for password changes. |
| V4.1–4.3 | Access control | **met** | Server-side default deny. Least privilege: the admin role is checked in the DB. IDOR is prevented by owner checks that answer 404 (27 matrix probes, which re-read the rows and assert nothing changed; mass assignment has no effect). Verified-email gating covers 21 routes, including media and member links (M2). The admin interface is protected (45 admin routes → 403 for members). |
| V5.1–5.3 | Input validation, sanitization, output encoding | **met** | zod on every input, with bounded strings, NFC normalization and bidi/invisible-character rejection (ADR 0001 §1). Output: JSON, React text, CSV formula neutralization. |
| V5.5 | Deserialization | **met** | Fastify's `secure-json-parse` (proto poisoning → error). No other deserializers. |
| V7.1–7.3 | Logging content, processing, protection | **met** | No credentials, tokens or PII in logs: recursive redaction, a query-param allowlist, DB error params dropped (`logging.test.ts`). Audit metadata is redacted. |
| V7.4 | Error handling | **met** | Generic messages, an `ApiError` envelope, no stack traces or SQL (`plugins/errors.test.ts`). |
| V8.1 | General data protection | **met** | Response schemas strip unknown keys (`pii-leak.test.ts`). |
| V8.2 | Client-side data protection | **met (after M1)** | **WP-2.3 M1, fixed:** `/api/` responses now send `Cache-Control: no-store` (`headers.test.ts`). The access token is never in storage. The SW caches only PII-free public reads and purges on logout (T9). |
| V8.3 | Sensitive private data | **partial** | PII is member-only and honors visibility (`pii-leak.test.ts`). Media metadata is stripped. The gallery, media routes and member links are verified-only (WP-2.3 M2, fixed; `verified-gating.test.ts`). Stored photos and avatars are cached privately for at most 1 h (L6, fixed). **Open:** non-A/V video tracks are not yet neutralized (backlog T4). A leaked open invite still lets a stranger verify their own mailbox (threat model A2; stricter open invites planned). |
| V9.1–9.2 | Communications | **partial** | HSTS on the API. Production config requires `https://` origins. **Pending:** nginx TLS config and HSTS on HTML (WP-2.4). DB TLS depends on the deploy. |
| V10.3 | Application integrity (deployed code) | **met** | No auto-update from untrusted sources. The SW update needs user consent ("Actualizar", `registerType: prompt`). |
| V11 | Business logic | **met** | Limits on uploads (count and bytes), RSVPs (deadline and window), invites (uses and expiry), chat (rate), admin changes (3 per target per hour) and the last-admin guard. |
| V12.1–12.5 | Files and resources | **partial** | Type allowlist, size limits, magic bytes, decompression-bomb guard, server-generated keys, private bucket, presigned PUT bound to length and type. **Open:** `nosniff` metadata on stored QuickTime objects. Real-bucket enforcement check at cutover. |
| V13.1–13.2 | API and RESTful web services | **met** | Every route has schemas. The CSRF header plus exact `Origin` on cookie routes. Content-type enforced by Fastify. Rate limits on all routes. |
| V13.5 | WebSocket (ASVS 5 V17) | **met** | `wss` only in the prod CSP. Single-use, session-bound ticket. Exact `Origin`. Message size and rate limits. Re-check of revoked sessions. |
| V14.1–14.2 | Build, dependencies | **met** | [dependencies.md](dependencies.md). The lockfile is frozen, and Actions are SHA-pinned. |
| V14.3 | Unintended disclosure | **met** | No `x-powered-by` or server banner. No stack traces. `/health/ready` reveals only a boolean (nginx restriction tracked). |
| V14.4 | HTTP security headers | **partial** | API: met (`headers.test.ts`). SPA: the nginx policy is specified and verified in Chromium ([csp.md](csp.md)), but it is not deployed yet (WP-2.4). |
| V14.5 | HTTP request header validation | **met** | `Origin` validated on cookie routes and WS. `X-Forwarded-For` trusted only from loopback. Client request ids are ignored. |

## Sign-off

The API and SPA code pass this review. Two Mediums were found and fixed: M1
(`Cache-Control`) and M2 (verified-email gating of media and member links,
owner decision).
The remaining **partial** items depend on WP-2.4 (nginx headers, TLS, log
redaction, `/health` restriction) or are tracked Lows and decisions. They are
listed in [`backlog.md`](../coordination/backlog.md#wp-23-findings). Repeat the
sign-off once WP-2.4 deploys the nginx config: re-run
`node docs/security/csp-check.mjs` against the staging origin and check the
live headers.
