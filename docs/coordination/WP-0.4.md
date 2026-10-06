# WP-0.4 Server platform [SEC]
Owner: Backend · Reviewers: TL, Security · Branch: wp/0.4-server-platform · PR: # (not opened)

Stacked on `origin/wp/0.3-schema` (e03e77f, includes main with 0.1/0.2/0.5/0.7) and `origin/wp/0.5-emails`.

## Scope
- **Deps** (`apps/server`): `fastify-type-provider-zod@7` (zod ≥ 4.1.5, Fastify 5; pulls `@fastify/swagger` + `openapi-types` as required peers, unused at runtime), `@fastify/cookie`, `@fastify/websocket` (resolved to 11.3.1 by `minimumReleaseAge`), `resend@6.30`, `sharp@0.35.5` (prebuilt `@img/*` binaries, no install script, so no `allowBuilds` entry is needed; verified it loads), `@cuencada/emails` (workspace), `pino-pretty` (dev).
- **Config** `src/config.ts`: new keys below; production rules; `ConfigError` that names keys only. `SEED_*` removed from `AppConfig` (the seed reads its own env), which removes the `Password123!` default from the server.
- **Bootstrap** `src/app.ts` (`buildApp(config, deps)`), `src/index.ts` (SIGTERM/SIGINT, 10 s hard limit), `src/logging.ts`, `src/plugins/{errors,auth,security}.ts`.
- **Libraries** `src/lib/`: `tokens`, `passwords`, `audit`, `errors`, `clock`, `jobs`, `rateLimit`, `mailer/{index,resend,dev,types}`, `storage/{s3,types}`.
- **Modules**: `src/modules/<m>/index.ts` for auth, invites, profile, directory, cuencadas, rsvp, media, family, chat, announcements, admin; all registered under `/api`.
- Removed: `src/auth.ts` (`requireUser`/`requireAdmin`), `modules/gallery` (S3 code now in `lib/storage/s3.ts`), the chat placeholder route, and the `POST /api/invites/accept` stub with the `tokenHashPreview` leak.
- Test harness: `createTestApp({ config, mailer, storage, clock, logStream, routes })` (fakes by default; the harness pool-close hook is gone because the app closes its own pool). `createUser({ emailVerified })`, `createSession(userId, opts)`, `bearerFor(user, session, { role, mustChangePassword, now, secret, ttlSeconds })`. `globalSetup` stale reclaim now swallows only SQLSTATE 55006.
- `.env.example` and `infra/project.yml` env updated.

## Config
| Key | Default | Production |
|---|---|---|
| `APP_BASE_URL` | `http://localhost:5173` | required, `https://` (`https://cuencada.com`) |
| `CORS_ORIGIN` | origin of `APP_BASE_URL` | comma list of exact origins, `https://` only |
| `DEV_ALLOWED_ORIGINS` | `http://localhost:5173` | ignored (forced to `[]`) |
| `TRUST_PROXY` | `false` | `loopback` (nginx on the same host); also `true`/`false`/hop count/CSV |
| `JWT_SECRET` | – (≥ 16) | ≥ 32 chars |
| `ACCESS_TOKEN_TTL_SECONDS` | 900 (60–3600) | |
| `REFRESH_IDLE_DAYS` / `REFRESH_ABSOLUTE_DAYS` | 30 / 90 (idle ≤ absolute) | |
| `COOKIE_SECURE` | `false` | `true` |
| `RESEND_API_KEY`, `MAIL_FROM` | unset → `DevMailer` | required (`vault_cuencada_resend_api_key`) |
| `SUPPORT_EMAIL` | `admin@cuencada.com` | |
| `MEDIA_REQUIRE_APPROVAL` | `false` | |
| `LOG_LEVEL` | `info` | |

## How-to for Phase-1 backend tracks
Only touch `src/modules/<m>/**` (plus `packages/types/src/<m>.ts`). Everything below is already wired.

### Declare a route
```ts
import { AuditAction, idParamSchema, apiErrorSchema } from "@cuencada/types";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { recordAudit } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { rateLimitByIp } from "../../lib/rateLimit.js";
import { authUser } from "../../plugins/auth.js";

const peopleModule: FastifyPluginAsyncZod = async (app) => {
  app.patch(
    "/admin/people/:id",                       // module plugins are mounted at /api
    {
      config: { auth: "admin", rateLimit: rateLimitByIp({ max: 60, timeWindow: "1 minute" }) },
      schema: {
        params: idParamSchema,
        body: updatePersonInputSchema,
        response: { 200: personSchema, 404: apiErrorSchema }   // response schemas strip unknown keys (PII guard)
      }
    },
    async (request) => {
      const admin = authUser(request);          // typed AuthUser; never null on user/admin routes
      return app.db.transaction(async (tx) => {
        const [row] = await tx.update(people).set(request.body).where(eq(people.id, request.params.id)).returning();
        if (!row) throw new AppError("NOT_FOUND");
        await recordAudit(tx, {
          actorUserId: admin.id, action: AuditAction.PersonUpdated, entityType: "person",
          entityId: row.id, metadata: { fields: Object.keys(request.body) }, ip: request.ip
        });
        return toPerson(row);
      });
    }
  );
};
export default peopleModule;
```
- **`config.auth`** is required in spirit: missing means `"user"` (default deny). Values: `"public"`, `"user"`, `"admin"`, `"cookie"`. Unknown values fail at boot.
  - `allowPendingPasswordChange: true`: only `/me`, change-password (T1). Everyone else with `must_change_password` gets 403 `PASSWORD_CHANGE_REQUIRED`.
  - `requireVerifiedEmail: true`: directory, family tree and other PII reads (T5/T6). Unverified users get 403 `FORBIDDEN`.
  - `"cookie"` (refresh/logout, T1): the guard checks `X-Cuencada-CSRF: 1` and an exact allowed `Origin` (→ 403 `CSRF_FAILED`); the route validates the `__Secure-cuencada_rt` cookie itself via `request.cookies`.
  - The chat WebSocket route (T7) is `"public"` and must validate the single-use ticket and `Origin` itself; `request.url` with the ticket is already scrubbed in logs.
- **Guard semantics:** HS256 JWT with `iss=cuencada-api`, `aud=cuencada-web`. Expired → 401 `TOKEN_EXPIRED`; anything else invalid → 401 `UNAUTHENTICATED`. Then the session is loaded by `sid`: revoked, idle-expired, absolute-expired, a different `sub`, or a disabled user → 401 `UNAUTHENTICATED`. **Role and must-change come from the DB**, so demotion/disable/revocation are immediate. `sessions.last_used_at` is updated at most once a minute.
- **`request.user`** is `AuthUser | null`: `{ id, email, displayName, role, status, mustChangePassword, emailVerified, sessionId }`. Use `authUser(request)` for the non-null value.
- **Errors:** throw `new AppError(code, spanishMessage?, { details?, cause?, headers? })`. Status comes from `errorHttpStatus`. Schema failures and `ZodError`s become 400 `VALIDATION` with `details` capped at 100 (99 + a summary). Anything unexpected becomes 500 `INTERNAL` with a generic message; the real error is only logged. Do not set your own error handler.
- **Rate limits:** every route gets the global 300/min per IP. Override per route with `rateLimitByIp`, `rateLimitByIpAndEmail` (runs in `preHandler`, keys on the hashed, lowercased body `email`) or `rateLimitByEmail`. Keys use `request.ip`, which honours `TRUST_PROXY`. 429 answers `RATE_LIMITED` with `Retry-After`.
- **Tokens/passwords:** `createOpaqueToken()` + `hashToken()` (store only the hash), `safeEqual()`, `app` config TTLs, `signAccessToken(accessTokenSettings(app.config), claims, app.clock.now())`. `hashPassword`, `verifyPassword`, `needsRehash`, and `verifyDummyPassword` for the "no such user" branch (equal timing).
- **Audit:** `recordAudit(tx, { actorUserId, action, entityType, entityId, metadata?, ip? })` inside the mutation's transaction. `action` is an `AuditAction` or another `entity.verb_past` string (validated). Metadata keys matching password/token/ticket/secret/hash/cookie/apiKey are stored as `[REDACTED]`.
- **Email:** `await sendTemplate(app, to, { kind: "magic-link", props: { displayName, loginUrl: appLink(app.config, AppLinkPath.MagicLink, rawToken), expiresInMinutes: 15 } }, { idempotencyKey: \`magic-link:${row.id}\` })`. Links always use the fragment (`/invitacion#t=…`, `/entrar/enlace#t=…`, `/restablecer#t=…`, `/verificar#t=…`). `Reply-To` is `SUPPORT_EMAIL`; for `password-changed` pass `supportContact: app.config.SUPPORT_EMAIL`. Never log the rendered body.
- **Storage:** `app.storage` (`StorageService`): `presignPut` (signature covers `content-type` and `content-length`), `presignGet`, `head`, `getRange`, `put`, `delete`. Keys are server-generated. Without S3 config every call throws 503 `SERVICE_UNAVAILABLE` (the app still boots).
- **Jobs (T4):** `app.jobs.enqueue("media.process", async (signal) => { … })`: serial, FIFO, failures logged, not durable (keep state in the DB and have a cleanup path). Closed on shutdown.
- **Time:** use `app.clock.now()` (tests can inject a clock).
- **Config:** `app.config.MEDIA_REQUIRE_APPROVAL` (T4), `REFRESH_*_DAYS`/`COOKIE_SECURE` (T1).

### Write route tests
```ts
import { createTestApp } from "../../../test/helpers/app.js";
import { createUser, loginAs } from "../../../test/helpers/factories.js";
import { FakeMailer } from "../../../test/helpers/fakes.js";

const mailer = new FakeMailer();
const app = await createTestApp({ mailer });            // FakeStorage by default
const member = await createUser({ emailVerified: true }); // must-change false, member
const auth = await loginAs(app, member);                  // real login → bearer header
const res = await app.inject({ method: "GET", url: "/api/directory", ...auth });
expect(res.statusCode).toBe(200);
await app.close();
```
Cover at least: happy path, 400 `VALIDATION`, 401 without a token, 403 for the wrong role/unverified user. `bearerFor(user, await createSession(user.id), { role: "admin" })` forges claims to prove the DB wins. Use `logStream` to assert on logs, and `routes` for test-only fixture routes.

## Frozen files (Phase 1 must not edit; ask the orchestrator)
`apps/server/src/app.ts`, `src/config.ts`, `src/index.ts`, `src/logging.ts`, `src/plugins/**`, `src/lib/**` (except adding new files a track owns with orchestrator approval), `test/helpers/app.ts`, `test/globalSetup.ts`, `test/setup.ts`. Plus the existing freezes: `packages/types/src/index.ts`, `db/schema/**`, `drizzle/**`.

## Decisions
- **Login bridge:** the scaffold login now creates a `sessions` row and signs `sid`/`role`/`mcp`, because the guard requires a live session. It does not set the refresh cookie and keeps the scaffold response shape (`{ user, accessToken, accessTokenExpiresAt }`). T1 replaces it with `AuthTokenResponse` + refresh rotation. Wrong credentials and disabled users get the same 401 `INVALID_CREDENTIALS`, with a dummy argon2 verify when the user does not exist.
- **Change-password bridge:** wrong current password → 400 `VALIDATION` on `currentPassword` (a 401 would make the web client try to refresh). It audits `auth.password_changed`. T1 adds session rotation and the notification email.
- `magic-link/request` now answers 202 `{ ok: true }` (contract) and is rate-limited per IP+email; sending is T1.
- Admin scaffold routes (`POST /api/admin/cuencadas`, `PATCH …/publish`) now audit. `GET /api/cuencadas/:year` keeps serving `data.ts` without a response schema (T2).
- **404 vs 401:** unknown URLs answer 404 even without a token (the guard skips `request.is404`); the 404 handler is rate-limited.
- **CSP** is applied to API responses by helmet (`useDefaults: false`). nginx serves the SPA, so **WP-2.4 must set the HTML CSP in nginx**: render it with `contentSecurityPolicy(config)` from `src/plugins/security.ts`. The SPA will likely need `style-src 'self' 'unsafe-inline'` (React inline `style` attributes) — decide there. The bucket origins (`https://<bucket>.<endpoint host>` and the endpoint) are in `img-src`/`media-src`/`connect-src`; `wss://` app origins are in `connect-src`; the Vite origin only outside production. `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`.
- **Redaction:** Pino `redact` covers `req/res` credential headers and `token`/`accessToken`/`refreshToken`/`ticket`/`password`/`currentPassword`/`newPassword`/`passwordHash`/`tokenHash`/`secret`/`authorization`/`cookie` at depth 0–2. The `req` serializer logs only method, scrubbed URL (`ticket`, `token`, `t`, `code`, `key`, `signature` query values redacted), IP and port. Request ids from clients are ignored.
- **`trustProxy`** defaults to `loopback` in production instead of `true`, so a client that reaches the port directly cannot spoof `X-Forwarded-For`.
- `buildApp` closes only what it created (DB pool, S3 client); injected deps belong to the caller.
- `AppError` lives in `src/lib/errors.ts`; default Spanish messages per `ErrorCode` are there.
- **`DevMailer` logs `to` (an email address, i.e. PII) in development/test only.** It refuses to construct in production, and production always uses Resend (config requires `RESEND_API_KEY`/`MAIL_FROM`). Bodies are never logged.

## Production seed (one-off, operator machine only)
The API service env in `infra/project.yml` carries **no `SEED_*` variables**: the temporary admin password must never live on the VPS. The vault ref `vault_cuencada_seed_admin_temp_password` is now used only by the operator for this manual step, not by the deploy.

Run it once per environment, after the first deploy's migrations, from a checkout with `pnpm build` done and the DB tunnel open:
```sh
# all variables set in the local shell only; never written to a file in the repo
NODE_ENV=production \
DATABASE_URL='<tunnel URL to the production DB>' \
SEED_ADMIN_EMAIL=admin@cuencada.com \
SEED_ADMIN_TEMP_PASSWORD='<vault_cuencada_seed_admin_temp_password>' \
SEED_WHATSAPP_URL='<rotated invite link>' \
SEED_EXTERNAL_ALBUM_URL='<regenerated album link>' \
SEED_LYRICS_URL='<…>' \
SEED_PROGRAM_URL='<…>' \
node apps/server/dist/seed.js
```
- The seed reads `DATABASE_URL` (the migrator uses `MIGRATE_DATABASE_URL || DATABASE_URL`; point both at the same tunnel URL).
- **Set every `SEED_*_URL` on the FIRST run.** The seed is insert-only: outside development/test an unset link is simply not seeded, and a later re-run never fills or overwrites existing rows, so a missing link must then be added through the admin UI.
- With `NODE_ENV=production` the seed refuses a missing, weak (< 16 chars) or placeholder password. The admin is created with `must_change_password = true`.
- Clear the shell history / variables afterwards.

## Open questions (→ orchestrator)
- **Linode PUT enforcement:** the presigned PUT signs `content-length` (unit-tested offline). Verifying on the real bucket that a mismatched body is rejected needs credentials, so it is T4's job at integration; the `head()` size check stays the backstop.
- **`@fastify/swagger` peer:** pulled in by `fastify-type-provider-zod@7`. Unused; fine unless we want OpenAPI docs later.
- Resolved: `SEED_*` removed from the API service env (see "Production seed").

## Review log
- (pending TL and Security review)
