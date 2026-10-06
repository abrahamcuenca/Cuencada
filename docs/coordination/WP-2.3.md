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
  - 9 "other member" IDOR probes.
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
- **L1–L5:** in `backlog.md` → "WP-2.3 findings".

## Open questions (→ orchestrator)
- **L2:** should unverified members read the gallery and member links? Either gate them with `requireVerifiedEmail`, or record the exception in ADR 0001.

## Review log
