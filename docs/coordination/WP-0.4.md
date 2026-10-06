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
| `NODE_ENV` | **required, no default** (`development`/`test`/`production`) | `production` |
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
- **Errors:** throw `new AppError(code, spanishMessage?, { details?, cause?, headers? })`. Status comes from `errorHttpStatus`. Schema failures and `ZodError`s become 400 `VALIDATION` with `details` capped at 100 (99 + a summary entry with `path: ""`, meaning "general"). Anything unexpected becomes 500 `INTERNAL` with a generic message; the real error is only logged. Do not set your own error handler.
  - **Only let a `ZodError` escape for client input.** The handler maps every `ZodError` to 400, so parsing server-side data (DB rows, config, provider responses) must use `safeParse` and throw a plain `Error` (→ logged 500) on failure. `recordAudit` does this for a bad action.
  - zod's default messages are Spanish (`z.config(z.locales.es())` runs when `app.ts` is imported).
- **Logging:** use `request.log` / `app.log`. Every logged object is scrubbed recursively and case-insensitively (keys containing token/password/ticket/secret/authorization/cookie/hash/apikey/credential → `[REDACTED]`). Errors use a custom `err` serializer: DB errors keep only the SQL text (with `$n` placeholders), the Postgres `code`/`constraint`/`table`/`column`/`schema`, and stack frames, never `params`/`detail`/`where`. Still, do not log request bodies or PII on purpose.
- **Rate limits:** every route gets the global 300/min per IP. Override per route with `rateLimitByIp`, `rateLimitByIpAndEmail` (runs in `preHandler`, keys on the hashed, lowercased body `email`; malformed bodies never reach it and fall under the global limit) or `rateLimitByEmail`. Keys use `request.ip`, which honours `TRUST_PROXY`. 429 answers `RATE_LIMITED` with `Retry-After`.
  - **Credential endpoints** (login, magic-link, reset, change-password): `const limits = credentialRateLimits(app)` then `{ config: { rateLimit: limits.rateLimit }, preHandler: limits.preHandler }`. Defaults (`LOGIN_RATE_LIMITS`): 10 per IP+email, 20 per IP across emails (spraying), 10 per email across IPs (distributed), each per 15 min. Call it once per route (own counters).
  - **Never stack `app.rateLimit()` hooks**: the plugin marks the request after the first one and silently skips the rest. For extra caps use `extraRateLimitHook(app, { max, timeWindow, keyGenerator })` (built on `createRateLimit`).
- **Tokens/passwords:** `createOpaqueToken()` + `hashToken()` (store only the hash), `safeEqual()`, `app` config TTLs, `signAccessToken(accessTokenSettings(app.config), claims, app.clock.now())`. `hashPassword`, `verifyPassword`, `needsRehash`, and `verifyDummyPassword` for the "no such user" branch (equal timing).
- **Audit:** `recordAudit(tx, { actorUserId, action, entityType, entityId, metadata?, ip? })` inside the mutation's transaction. `action` is an `AuditAction` or another `entity.verb_past` string (validated). Metadata keys matching password/token/ticket/secret/hash/cookie/apiKey are stored as `[REDACTED]`.
- **Email:** `await sendTemplate(app, to, { kind: "magic-link", props: { displayName, loginUrl: appLink(app.config, AppLinkPath.MagicLink, rawToken), expiresInMinutes: 15 } }, { idempotencyKey: \`magic-link:${row.id}\` })`. Links always use the fragment (`/invitacion#t=…`, `/entrar/enlace#t=…`, `/restablecer#t=…`, `/verificar#t=…`). `Reply-To` is `SUPPORT_EMAIL`; for `password-changed` pass `supportContact: app.config.SUPPORT_EMAIL`. Never log the rendered body.
- **Storage:** `app.storage` (`StorageService`): `presignPut` (signature covers exactly `content-length;content-type;host`, with no SDK checksum parameters: the client uses `requestChecksumCalculation`/`responseChecksumValidation: "WHEN_REQUIRED"`), `presignGet`, `head`, `getRange`, `put`, `delete`. Signing dates and `expiresAt` come from `app.clock`. Keys are server-generated. Without S3 config every call throws 503 `SERVICE_UNAVAILABLE` (the app still boots).
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
- **CSP** is applied to API responses by helmet (`useDefaults: false`). nginx serves the SPA, so **WP-2.4 must set the HTML CSP in nginx** (see "WP-2.4 items"). The app policy allows **no third-party script**: `script-src 'self'`, `frame-src 'self'`. Only the bucket-specific origin (`https://<bucket>.<region>.linodeobjects.com`, derived from `S3_ENDPOINT` + `S3_BUCKET`) and `S3_PUBLIC_BASE_URL` are in `img-src`/`media-src`/`connect-src`; the shared regional endpoint is not (it would allow any customer's bucket). `wss://` app origins are in `connect-src`; the Vite origin only outside production. `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`. The SPA will likely need `style-src 'self' 'unsafe-inline'` (React inline `style` attributes); decide in WP-2.4.
- **Weather widget** (orchestrator decision, S2, option 1): no third-party script runs on cuencada.com. The SPA embeds weatherwidget.io's own widget page as a cross-origin, sandboxed iframe and configures it with `postMessage` from our code (replacing the vendor's 2.6 KB loader script). The app policy therefore has `script-src 'self'` and `frame-src 'self' https://weatherwidget.io`; there is no `/widgets/*` page and no separate widget policy. Verified in headless Chromium against the live widget: the config is accepted and the height message comes back. See "Weather widget embed contract" below.
- `/health/ready` is rate-limited (60/min per IP) and reuses its DB ping result for 5 s (`READY_CACHE_MS`), with concurrent probes sharing one in-flight ping.
- `NODE_ENV` is **required** (no default): a process started without it no longer fails open into development behaviour.
- `buildApp` and `createTestApp` release the pool (and S3 client, job queue) they created if construction, fixture registration or `ready()` fails.
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

## T1 acceptance items (carried from this WP's bridges)
- `POST /api/auth/change-password` must **revoke every other session** (`revoked_reason = password_changed`) **and rotate the current one** (new session + new access token + refresh cookie), returning `AuthTokenResponse` (contract decision 13), and send the password-changed email.
- The login (and `/me`) response moves from the scaffold shape `{ user, accessToken, accessTokenExpiresAt }` to the contract `AuthTokenResponse` / `CurrentUser`, and login sets the refresh cookie. Update `test/helpers/factories.ts#loginAs` accordingly.
- Reuse `credentialRateLimits(app)` on magic-link request, password-reset request/confirm and change-password.

## Weather widget embed contract (T2-FE)
The legacy `<a class="weatherwidget-io">` + `widget.min.js` loader must **not** be used. The SPA renders the widget itself:

```html
<iframe
  title="Clima en Mérida"
  src="https://weatherwidget.io/w/"
  sandbox="allow-scripts allow-same-origin allow-popups"
  referrerpolicy="no-referrer"
  loading="lazy"
></iframe>
```
Size and border come from a CSS Module class (no inline `style` attribute: `style-src 'self'`); the height is set from script via `frame.style.height`, which CSP does not block.
- **`src`:** exactly `https://weatherwidget.io/w/` (the only origin in `frame-src` besides `'self'`).
- **`sandbox`:** exactly `allow-scripts allow-same-origin allow-popups`. `allow-same-origin` gives the frame **weatherwidget.io's own origin** (it needs it for its cookies and for `postMessage` targeting); that origin stays cross-origin to cuencada.com, so the frame cannot touch our DOM, storage, cookies or access token. `allow-popups` lets the forecast link open. Do **not** add `allow-top-navigation`, `allow-forms` or `allow-popups-to-escape-sandbox`.
- **Config:** on the iframe's `load` event, post the config with an explicit target origin:
  ```ts
  frame.contentWindow?.postMessage(
    {
      id: "weatherwidget-io-0",                       // echoed back as `wwId`
      href: cuencada.weatherWidgetUrl,                // e.g. https://forecast7.com/es/20d97n89d59/merida/
      label_1: "MÉRIDA",
      label_2: "Clima",
      theme: "original"                               // optional: font, icons, mode, days, basecolor, textcolor, accent, …
    },
    "https://weatherwidget.io"                        // never "*"
  );
  ```
  The keys are the widget's `data-*` attributes (`data-label_1` → `label_1`, …). `href` must be the Cuencada's `weatherWidgetUrl` (an `https://forecast7.com/…` URL from the API), never user-typed text.
- **Height messages:** the frame posts `{ wwId: string, wwHeight: number }` to its parent. The listener must ignore anything where `event.origin !== "https://weatherwidget.io"` or `event.source !== frame.contentWindow`, and accept only a finite number (`typeof wwHeight === "number" && Number.isFinite(wwHeight)`), clamped to a sane range (e.g. 0–600 px), before setting the iframe height. Never use the message for anything else (no HTML, no URLs). Remove the listener on unmount.
- No `script-src` change is needed or allowed for this.

## WP-2.4 items (nginx / deploy)
- **Client IP:** cuencada.com is **not** behind Cloudflare (DNS points at server_1; nginx terminates TLS). nginx must set `proxy_set_header X-Forwarded-For $remote_addr;` (overwrite; never `$proxy_add_x_forwarded_for`, which would append an untrusted client-supplied value) and must **not** trust `CF-Connecting-IP`. The app keeps `TRUST_PROXY=loopback`, so rate-limit, session and audit IPs are the direct client IP.
- **HTML CSP:** send `contentSecurityPolicy(config)` (from `apps/server/src/plugins/security.ts`, rendered with the production config) on every SPA response. It already allows the weather widget iframe (`frame-src 'self' https://weatherwidget.io`); no other third-party origin may be added. Decide `style-src 'unsafe-inline'` there. Remember that `add_header` inside a `location` drops inherited headers.
- Strip the query string from access logs for `/api/chat/ws` (the ticket), and consider restricting `/health*` to localhost/monitoring.

## Open questions (→ orchestrator)
- Resolved: weather widget embed. The planned `/widgets/clima.html` wrapper with `sandbox="allow-scripts"` broke the widget (sandbox flags propagate to its nested frame, which then gets a `null` origin and drops the config `postMessage`). The orchestrator chose the direct iframe (option 1); see the embed contract.

- **Linode PUT enforcement:** the presigned PUT signs `content-length` and now carries no checksum parameters (unit-tested offline). Verifying on the real bucket that a mismatched body is rejected needs credentials, so it is T4's job at integration; the `head()` size check stays the backstop.
- **`@fastify/swagger` peer:** pulled in by `fastify-type-provider-zod@7`. Unused; fine unless we want OpenAPI docs later.
- Resolved: `SEED_*` removed from the API service env (see "Production seed").

## Review log
- **PR #8 round 1: TL and Security, CHANGES REQUESTED.** Addressed:
  - **B1 (TL):** the S3 client uses `requestChecksumCalculation`/`responseChecksumValidation: "WHEN_REQUIRED"`. A test asserts the presigned PUT has no `x-amz-checksum-*`/`x-amz-sdk-checksum-algorithm` and signs exactly `content-length;content-type;host`.
  - **S1 / M1 (Security):** a custom `err`/`error` serializer drops DB params, `detail` and `where` and the params line of Drizzle messages and stacks, keeping only `type`, the SQL text, Postgres `code`/`constraint`/`table`/`column`/`schema`/`routine`/`severity` and stack frames. A regression test inserts a duplicate email through a route and asserts the log contains neither the email nor `$argon2`.
  - **S2 / M2 (Security):** weatherwidget.io is removed from `script-src`/`connect-src`. After testing showed the sandboxed `/widgets/clima.html` wrapper breaks the widget, the orchestrator chose option 1: the SPA embeds `https://weatherwidget.io/w/` directly (`frame-src 'self' https://weatherwidget.io`) and posts the config itself; the interim `widgetContentSecurityPolicy()` was removed (see the embed contract).
  - **L1:** redaction is recursive (any depth, cycle-safe) and case-insensitive via `formatters.log` plus the error serializer; tests cover `Token`, `PASSWORD` and deeply nested keys.
  - **L2:** `credentialRateLimits()` adds 20/15 min per IP across emails and 10/15 min per email across IPs on login, on top of IP+email. Found and documented that stacked `app.rateLimit()` hooks silently skip each other; the extra caps use `createRateLimit`.
  - **L3:** WP-2.4 item (no Cloudflare: `X-Forwarded-For $remote_addr`, ignore `CF-Connecting-IP`).
  - **L4:** CSP storage origins are only the bucket-specific host (and `S3_PUBLIC_BASE_URL`).
  - **L5:** `/health/ready` is rate-limited and caches the ping for 5 s.
  - TL non-blocking: `NODE_ENV` required; `recordAudit` throws a plain `Error`; `z.config(z.locales.es())` at boot; no pool leak on failed construction (tested with a spied `createDatabase`); storage presign uses the injected clock; `scrubUrl` also redacts names starting with `ticket`/`token`; the summary detail convention (`path: ""`) is documented; T1 acceptance items added.
  - **Flaky `logging.test.ts`:** not reproducible locally (3 cold full runs green before the fix). Most likely cause: every worker's first file races to `CREATE DATABASE … TEMPLATE` and can exhaust the 55006 retries under cold-start load, failing that file's `beforeAll`. `ensureWorkerDatabase` now serializes clones with `pg_advisory_lock(hashtext(template))`. `logging.test.ts` also moved its traffic out of `beforeAll` into the tests (test timeout, memoized).
  - Server tests resolve `@cuencada/emails` from source (vitest alias + automatic JSX), so they no longer need a prior build.
