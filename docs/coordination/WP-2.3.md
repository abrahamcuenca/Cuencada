# WP-2.3 Security audit [SEC]
Owner: Security Engineer · Reviewers: TL · Branch: wp/2.3-security-audit · PR: # (not opened)

## Scope
- **Route inventory:** an `onRoute` recorder (`apps/server/test/helpers/routes.ts`, installed through a mocked Fastify factory) and `apps/server/src/__tests__/security/inventory.test.ts`. The test fails when:
  - a registered route is missing from `routeMatrix.ts`, or the matrix lists a route that doesn't exist;
  - a route's guard config differs from its classification;
  - a route omits `config.auth`;
  - a HEAD twin drifts from its GET;
  - `docs/security/routes.md` is stale.
- **Authorization matrix** (`authz-matrix.test.ts`):
  - Every route is called by 7 principals with valid fixtures: anonymous, verified, unverified, pending a password change, disabled with an old token, revoked session, admin.
  - 27 state-checked probes (IDOR, hidden rooms, own-item rules, mass assignment).
  - CSRF variants on the cookie routes.
  - The WebSocket upgrade for anonymous, unverified and revoked callers.
- **PII leak scans** (`pii-leak.test.ts`) on member and admin bodies, using the real S3 presigner.
- **Header and CSP tests** (`headers.test.ts`).
- **Docs** in `docs/security/`: `README.md`, `routes.md` (generated), `threat-model.md`, `owasp-checklist.md`, `csp.md`, `dependencies.md`, and the `csp-check.mjs` harness.
- **Fix M1:** `Cache-Control: no-store` on every `/api/` response (`plugins/security.ts`).
- `apps/server/tsconfig.json` excludes `src/**/__tests__/**` from the production build. `routeMatrix.ts` is test support that imports test helpers.

## Interfaces consumed / exposed
- **Consumed:** the test helpers (`createTestApp`, factories, chat, media, cuencadas and family fixtures) and `createEmailToken`.
- **Exposed:**
  - `recordedRoutes` / `recordingFastify` (test helper).
  - `ROUTE_MATRIX` / `expectationFor` / `createActor` (`src/__tests__/security/routeMatrix.ts`).
  - **A new route must be added to `ROUTE_MATRIX`** with its classification and a minimal valid request. Then regenerate `routes.md` with `UPDATE_SECURITY_DOCS=1 pnpm --filter @cuencada/server test -- inventory`.

## Decisions
- The matrix builds **valid** requests for every principal. A 401 or 403 therefore comes from the guard, never from validation or a missing row.
- Expected exceptions, kept as explicit overrides:
  - A disabled user's refresh cookie can still log out (204), since that only revokes the session.
  - Public credential endpoints treat a disabled user like a wrong password: 401 `INVALID_CREDENTIALS`, or 400 `TOKEN_INVALID` for tokens.
- The CSP check runs against the **real built API** on a scratch database instead of a stub, so pages render real states (the weather iframe, the chat socket).
- The SPA policy for nginx is stricter than `contentSecurityPolicy(config)`: `base-uri 'none'`, and no `'self'` in `frame-src`. `style-src 'self'` needs no `'unsafe-inline'`.

## Findings
- **M1 (fixed):** no `Cache-Control` on API responses (ASVS 8.2.1).
- **M2, formerly L2 (fixed, owner decision):** the gallery, every media route and `/cuencadas/:year/members` now need a verified email (ADR 0001).
- **L6 (fixed):** stored photo and avatar `Cache-Control` was a year with `immutable`; it is now `private, max-age=3600`.
- **M2 web follow-up (fixed in this PR):** the year page shows the verify-email or no-access prompt instead of a dead Retry, and the gallery hides upload controls over a 403.
- **L1, L3, L4, L5** are in `backlog.md` → "WP-2.3 findings".

## Open questions (→ orchestrator)
- None. L2 was decided by the owner (see the review log).

## Review log
- **PR #35, round 1.** Tech Lead: APPROVED `1b728fd` with two nits. Second Security reviewer: CHANGES REQUESTED. Owner: decided L2.
  - **L2 → M2 (A01), fixed:**
    - `requireVerifiedEmail` on all media routes and on `/cuencadas/:year/members`; announcements and the RSVP summary stay open.
    - Regression test `verified-gating.test.ts`.
    - The matrix, `routes.md` and ADR 0001 are updated.
    - Uploads and media mutations were **not** gated before; they are now.
  - **B1:** the threat model no longer says unverified accounts can't read PII. It now describes the new gating and the residual risk: a stranger with a leaked open invite can verify their own mailbox. The planned stricter open invites (about 5 uses, 72 h, an admin alert on each acceptance) are listed as the mitigation.
  - **B2:** M2 is recorded in the findings table, the README, the OWASP checklist and the backlog.
  - **N1:** derivative and avatar object metadata is now `private, max-age=3600`, no longer than the presigned GET (L6, `cache-lifetimes.test.ts`).
  - **N2:** probes can return `state`, which is re-read before and after the request and must not change. Mutation-checked.
  - **N3:** new probes:
    - another member's pending, processing, failed, pending-review or hidden media;
    - hidden-room history, read state and delete;
    - reporting your own item → 403;
    - mass assignment on `PATCH /api/family/me` (and its alias) and on the RSVP PUT.
  - **N4:** the PII scanner now:
    - matches phones on digits;
    - has JWT, raw S3 key and opaque-token patterns;
    - searches the planted tokens verbatim;
    - checks the unlisted member by name;
    - plants a deleted chat message;
    - scans the WebSocket frames.
  - **N5:** the resize worker loads under `worker-src 'self'` with a 48 MP upload (`csp.md`).
  - **L3:** a cutover line says to paste the `csp.md` string verbatim.
  - **L5:** on the pre-launch list.
  - **TL nits:**
    - the unclassified-route message names `routeMatrix.ts`;
    - `csp-check.mjs` parses the policy from `csp.md`, and its JSDoc explains why `upgrade-insecure-requests` is dropped locally.
