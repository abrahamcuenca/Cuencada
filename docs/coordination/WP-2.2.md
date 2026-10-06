# WP-2.2 End-to-end + mobile quality gates [SEC]
Owner: Senior JS Frontend Engineer + UI/UX · Reviewers: TL, Sec · Branch: wp/2.2-e2e · PR: # (not opened)

Based on `origin/main` 28c55aa. Later `origin/main` merges, each followed by a full-suite re-run: e75e718 (WP-0.8c, PR #34), then bc2d3d5 (WP-2.3 #35 and WP-2.3b #36). Review round: Security L1/L2 and the TL's requested changes (see "Review round").

## Scope
- `tests/e2e/**` (new): harness, fixtures, 7 journey specs, quality gates, Lighthouse.
- `playwright.config.ts` (root), root scripts `e2e`, `e2e:build`, `e2e:run`, `e2e:lighthouse`, `typecheck:e2e`.
- `.github/workflows/e2e.yml` (separate from `ci.yml`, same pinned-action style).
- Root devDeps: `@axe-core/playwright` 4.13, `lighthouse` 13.5, `tsx`, `@types/node` (all past `minimumReleaseAge`; `pnpm audit` clean).
- Root `package.json` is now `"type": "module"` (the e2e TypeScript uses `import.meta`; no root `.js` files are affected).
- `.gitignore`/`biome.json`: ignore `apps/web/dist-e2e`, `playwright-report`, `test-results`.
- Two product bug fixes, each in its own commit with a unit test (see Bugs).
- `docs/ux/screenshots/e2e/*-375.webp` (28 journey screenshots, fictional data), `docs/ux/lighthouse/wp-2.2-summary.json`.

## How to run
```sh
pnpm install
scripts/test-db.sh up                    # the podman Postgres on 127.0.0.1:55432
pnpm exec playwright install chromium    # once
pnpm e2e                                 # build + journeys + gates + Lighthouse
```
- `pnpm e2e:build`: builds the API (`turbo run build --filter=@cuencada/server`) and the e2e SPA into `apps/web/dist-e2e`.
- `pnpm e2e:run`: the journeys (iphone-13, pixel-7, desktop-1280) and `mobile-gates`. Rebuild with `e2e:build` after web changes.
- `pnpm e2e:lighthouse`: Lighthouse alone (it must not share the CPU with the journeys).
- One project or spec: `pnpm exec playwright test --project=pixel-7 tests/e2e/chat.spec.ts`.
- `E2E_UPDATE_DOCS=1` re-takes the screenshots (iphone-13 project) and rewrites the Lighthouse summary in `docs/`. Normal and CI runs never write to `docs/`.
- Overrides: `E2E_DATABASE_URL` (default `postgresql://cuencada:cuencada@127.0.0.1:55432/cuencada_e2e`), `E2E_API_PORT` 3190, `E2E_STORAGE_PORT` 3191, `E2E_WEB_PORT` 4190, `E2E_WORKERS` 3, `E2E_LOG_LEVEL` warn.
- Every run starts its own servers (`reuseExistingServer: false`) and resets the database, so runs never depend on each other.

## Harness design

```
Playwright ──https──▶ vite preview :4190 (apps/web/dist-e2e, self-signed TLS)
   │                     └─ /api + /api/chat/ws proxy ──▶ harness API :3190 (apps/server/dist buildApp)
   │                                                        ├─ Postgres cuencada_e2e (reset + migrate + seed)
   │                                                        ├─ FileSinkMailer  → $TMP/cuencada-e2e/mail/*.json
   └──https (presigned PUT/GET)──▶ LocalObjectStore :3191 ◀─┘ (same process, $TMP/cuencada-e2e/objects)
```

- **Real API:** `tests/e2e/harness/server.ts` (run with `tsx`) imports `buildApp`/`loadConfig` from `apps/server/dist` and injects only `mailer` and `storage` through the existing `AppDeps` seam. Routes, auth, CSRF, rate limits, the job queue (sharp), chat sockets and the DB are the production code. Nothing was added to `apps/server/src`. `dist/index.js` isn't used only because it can't take injected services; its graceful shutdown is mirrored.
- **Start conditions:** the harness requires `E2E=1`, which Playwright's `webServer` sets, and refuses outright when `NODE_ENV=production`. It then **forces `NODE_ENV=test`** in the config it passes to `loadConfig`. That config is built from constants, not `process.env`.
- **Database:** `harness/seed.ts` drops and recreates the e2e database, runs the real migrations (`runMigrations`) and the real product seed (`runSeed`; the admin, the 2026 edition and the chat rooms, with fake `SEED_*_URL` links), then adds fictional fixtures:
  - a cast per Playwright project (`harness/people.ts`, `@e2e.example.test`): a first-login admin, a ready admin and members Ana, Beto, Carla, Darío, Elena and Fede
  - a published future **Cuencada 2027** in "Pueblo Ejemplo" (RSVP open, a hotel, two programa items, its chat room)
  - a small family tree per project
  - 24 chat messages from one sender
  Each project has its own cast, so the projects run in parallel without stepping on each other (password changes, logout-all, the directory switch, the tree).
- **SPA:** `tests/e2e/vite.e2e.config.ts` wraps `apps/web/vite.config.ts`. It sets `VITE_MEDIA_UPLOAD_ORIGIN` to the local store, writes to `dist-e2e`, and runs `vite preview` over **HTTPS**: the production build only opens the chat socket over `wss:` and only accepts an `https:` upload origin. The `/api` proxy has `ws: true`.
- **Per-phone client IPs:** the API runs with `TRUST_PROXY=loopback` (the production default), and every browser context sends its own `X-Forwarded-For`. Per-IP rate limits then behave like separate phones instead of coupling every journey to 127.0.0.1.
- **Hermetic:** each context aborts every request that isn't to the preview or the object store (weather widget, fonts).
- **Devices:** the iPhone 13 and Pixel 7 profiles run in **Chromium**. Playwright's iPhone profile defaults to WebKit; see Requests. The desktop project is 1280×800.

### Test-only mail sink and object store: why they can't run in production [SEC]
Both live in `tests/e2e/harness/`, **outside `apps/server/src`**. They aren't compiled into `apps/server/dist` and aren't part of any deploy artifact. Nothing in the product can select them: there is no config flag, env var or route.

| Guard | Mail sink (`mailSink.ts`) | Object store (`localObjectStore.ts`) |
|---|---|---|
| Not shipped | outside the server build | outside the server build |
| Wired only by | `harness/server.ts` | `harness/server.ts` |
| Entry refuses | unless `E2E=1`; always when the process has `NODE_ENV=production`. The API config it builds **forces `NODE_ENV=test`** (from constants, not the shell env). | same |
| Self-check | the constructor throws on `NODE_ENV=production` | — |
| Data at rest | one JSON file per message (tokens included), file mode 0600, directory mode 0700, under `$TMP/cuencada-e2e/mail`, wiped at every start | bodies named by `sha256(key)`, so a key can't escape the directory |
| Network | none (specs read the files) | loopback only. Presigned URLs carry an HMAC (per-process random secret) over method, key, expiry, content type and length. A PUT must match the signed `Content-Type` and the exact size. Expired or tampered URLs get 403. CORS is open only to the e2e origin. |

- **Database guard** (`harness/dbGuard.ts`, Security L2). The harness runs `DROP DATABASE`, `CREATE DATABASE` and migrations, and an SSH tunnel to production Postgres may also listen on loopback. Every check runs **before** any DROP or CREATE:
  1. The URL must be a plain `postgresql://` URL with **no query string and no fragment**. The driver turns query params into connection settings, so `?options=-c …` or `?cuencada.test_cluster=…` could forge the marker for one connection, and `?database=…` could swap the database. The host must be loopback, the name must match `/^[a-z0-9_]+_e2e$/`, and the port must be the test container's **55432** (another port only when `E2E_ALLOW_DB_PORT` names exactly that port).
     - Every connection (drop/create, migrate, seed, API) uses **canonical URLs rebuilt from the parsed host, port, user, password and database**. The raw env value is never passed through.
  2. A **live catalog check**: `pg_db_role_setting` must hold `cuencada.test_cluster=cuencada-test` as a database-level, all-roles setting on the `postgres` database. It is never read from `current_setting`, which a connection can set for itself.
  3. After connecting for migrate, seed and the API, `current_database()` must equal the checked `_e2e` name.
  - The marker is a database-level setting (`ALTER DATABASE postgres SET cuencada.test_cluster = 'cuencada-test'`).
    - `scripts/test-db.sh up` sets it idempotently, including on a container that is already running. It doesn't recreate anything, so it stays backward compatible.
    - CI's e2e job sets it on its service container.
    - An older container gets the marker on its next `scripts/test-db.sh up`. Until then the harness refuses and says to run it. There is deliberately no weaker fallback such as a port or version heuristic.
  - Tests: `harness/dbGuard.test.ts` (Vitest project `e2e-harness`, part of `pnpm test`):
    - query strings refused (`options`, `database`, the marker param, the full reported bypass, an empty `?`); fragments refused
    - credentials re-encoded into the canonical URL
    - wrong port refused, the exact override accepted, non-loopback host and non-`_e2e` name refused, no password echoed
    - a missing catalog marker refused; a `current_database()` mismatch refused
    - an **integration test against the test container**: a GUC forged through the driver's `options` shows up in `current_setting`, but the catalog check still refuses
  - Also checked live: the harness refuses the reported bypass URL before connecting.
- **Seed environment allowlist** (`harness/seedEnv.ts`, Security L1). The product seed gets an explicit set of e2e-only constants: `NODE_ENV=test`, the guarded `DATABASE_URL`, an e2e admin email and temporary password, and fake `*.example.test` `SEED_*_URL` links. It never gets `process.env`, so vault seed values in an operator's shell can't reach the e2e database, screenshots or traces. `harness/seedEnv.test.ts` covers this.
- TLS: `openssl` makes self-signed certificates per run, outside the repo. Only the test Chromium runs with `--ignore-certificate-errors` and `ignoreHTTPSErrors`.
- `X-Forwarded-For` spoofing works here only because the client is on loopback. Production depends on nginx overwriting `X-Forwarded-For` (already on the cutover checklist). The e2e setup demonstrates why that item matters.
- The JWT secret is a fixed, non-secret e2e value, used only for the throwaway database.
- CI uploads `test-results/` (traces, screenshots) on failure. Traces contain the fictional accounts' one-time tokens and passwords. All of them are e2e-only and die with the run's database.

## Journeys (Spanish UI, asserted by role/label)
| # | Spec | What it proves |
|---|---|---|
| 1 | `auth.spec.ts` | First login with the temporary password lands on "Cambia tu contraseña". `/admin` stays locked until the password changes. After the change, the console ("Administración", "Secciones de administración") opens. The temporary password then gets 401. |
| 2 | `auth.spec.ts` | The admin sends an email-bound invite. The member opens the link from the **captured email**, the token is scrubbed from the URL, and the member accepts and lands logged in. No "Verifica tu correo" banner: an emailed invite marks the address verified on the server. The admin sees the invite as "Aceptada". |
| 2b | `auth.spec.ts` | A shared-link invite gives an unverified account: banner, then "Reenviar enlace", then the emailed `/verificar` link, "Confirmar mi correo", "Correo verificado", and the banner is gone. (This is how journey 2's "verifies email via the emailed link" gets exercised, since emailed invites are verified on accept.) |
| 3 | `auth.spec.ts` | Magic link: "Recibir enlace por correo", then "Revisa tu correo", the email, the "Entrar" tap, and the user is logged in. The link is single-use ("No pudimos abrir tu enlace"). Opened on a phone that is logged in as someone else, it shows "Ya tienes la sesión abierta como …", and "Seguir como …" keeps that session. |
| 4 | `cuencada.spec.ts` | `/cuencada/2027` anonymous shows the programa plus "Solo para la familia", with no RSVP and no attendees. A member saves "Sí" plus notes and gets "¡Listo! Confirmaste tu asistencia.". The "N confirmados: ver la lista" sheet lists the member first with "Tú". The answer survives a reload ("¡Vas!", "Cambiar respuesta"). |
| 5 | `gallery.spec.ts` | A JPEG generated in a canvas (abstract shapes, no people) goes through the file chooser (`multiple`), the "Subir 1 archivo" sheet with a caption, the presigned PUT to the local store, confirm, the sharp job and the "Ver foto: …" tile with a loaded thumbnail. Then the lightbox, "Editar descripción" ("Descripción guardada.") and "Eliminar" ("Foto eliminada.", tile gone). |
| 6 | `directory.spec.ts` | Searching "Buscar por nombre o ciudad" returns exactly one match; the detail opens at `/directorio/:id`. Carla switches "Aparecer en el directorio" off and saves; searching for her then shows "No encontramos a nadie con …". |
| 7 | `family.spec.ts` | "Árbol familiar" is centred on me (Padres, Hermanos). Re-centring on the parent shows the children and "Aún no hay pareja registrada."; "Personas visitadas" leads back. An admin goes to `/admin/familia`, the person page, "Agregar pareja" and "Elegir a …" ("Agregamos a …."). The member then sees the partner. |
| 8 | `chat.spec.ts` | Two phones in "Familia Cuenca" exchange messages in real time over `wss:` through the proxy. "Opciones del mensaje de Tú", "Eliminar" and the confirm show "🚫 Mensaje eliminado" on the other phone. A message sent while the other member is away shows as "… sin leer" on their Chat tab. |
| 9 | `auth.spec.ts` | Two sessions; "Cerrar sesión en todos los dispositivos" and its confirm on one phone. The other phone's next **in-app** navigation (its access token is still in memory) is refused, and it ends up on `/entrar`. |
| 10 | `offline.spec.ts` | The SW installs and controls the page. Offline, a reload of `/cuencada/2026` renders the cached programa with "Sin conexión — mostrando la última versión guardada". A member page reloaded offline shows "Sin conexión" with "Reintentar" and no member data. Back online it recovers by itself. |

### Results (local, after merging bc2d3d5, pinned fonts)
| Project | Journeys | Result |
|---|---|---|
| iphone-13 (Chromium, 390×664, DPR 3, touch) | 1, 2, 2b, 3, 4, 5, 6, 7, 8, 9, 10 | 11/11 pass |
| pixel-7 (Chromium, 412×839, touch) | 1, 2, 2b, 3, 4, 5, 6, 7, 8, 9, 10 | 11/11 pass |
| desktop-1280 | the `@desktop` subset: 1, 3, 4, 5, 6, 7, 8, 9, 10 | 9/9 pass |
| mobile-gates | probe self-test + public/member/admin routes | 4/4 pass |
| lighthouse | Home, `/cuencada/2027`, `/galeria/2027` | 1/1 pass |

`pnpm e2e`: 35 passed (about 1.6 min) plus Lighthouse 1 passed (about 25 s). `pnpm lint`, `pnpm turbo run typecheck --force`, `pnpm typecheck:e2e`, `pnpm test` (now including the `e2e-harness` guard tests) and `pnpm build` all pass.

## Mobile quality gates (`quality.spec.ts`, `support/gates.ts`)
21 routes (public, member and admin) are checked at **320 and 375 px**, 42 checks in all:
- **Fonts are pinned.** Every browser the suite launches gets `FONTCONFIG_FILE=tests/e2e/fonts/fonts.conf`, which exposes only DejaVu Sans plus Noto Color Emoji. Both come from Debian/Ubuntu packages at the same paths locally and in CI, and the e2e job installs them.
  - Before this, Chromium resolved the CSS stack (`system-ui, …, "Noto Sans", Arial, sans-serif`) to whatever each machine had. Glyph widths differed, so CI failed the 320 px overflow check on the year pages while local runs passed.
  - DejaVu is wide, so it's a pessimistic font for overflow, and it's Ubuntu's default fallback.
- **Each route waits for a content heading before measuring** (year pages, Fotos, Directorio, Árbol). An error state can't pass the gate.
- **Horizontal overflow** (`scrollWidth <= clientWidth`): 0 failures after the year-page fix (bug 3). Content clipped inside a horizontal scroller that itself fits isn't reported as a culprit. The 2027 fixture includes an item with long unbreakable tokens (a URL, a place name, a 24-character tag).
- **Touch targets ≥ 44 px:** every visible interactive element is sampled (3–38 per route), 0 failures. The exemptions follow WCAG 2.5.8:
  - links inline in a sentence
  - the off-screen skip link
  - a visually hidden native radio or checkbox, which is measured by its `<label>`
  - a small switch whose label hit area (the design system's full-row `::after`) is ≥ 44 px
- **Form controls ≥ 16 px font:** 0 failures.
- **axe-core** (`wcag2a/2aa/21a/21aa/22aa`) at 375 px: **0 serious/critical**, and 0 violations of any impact on the final run. It found one serious issue on the chat room, fixed below.
- **Known gaps:**
  - Only each route's **initial state** is sampled. Sheets, dialogs, menus, the lightbox, the upload sheet and expanded filters aren't opened by the gate (the journeys exercise them, but nothing measures them).
  - **Clickable `div`/`span` elements without a role or `tabindex`** aren't sampled for touch targets: the selector covers native controls, `[role=button|switch|tab]` and `[tabindex="0"]`.
  - axe runs at 375 px only.
- A probe self-test on a synthetic page proves the overflow, target and font probes do fail on bad markup. The axe gate was checked the same way: with the chat fix reverted, it fails on `chat-sala`.

## Lighthouse mobile (`lighthouse.spec.ts`, `docs/ux/lighthouse/wp-2.2-summary.json`)
Default mobile emulation, simulated slow 4G, against the e2e stack. The public pages load cold. Fotos runs warm: storage is kept so the login cookie survives, and so is the SW precache.

| Page | Performance | Accessibility | Best practices | LCP | TBT | CLS |
|---|---|---|---|---|---|---|
| Home `/` | 99 | 100 | 96 | 1.93 s | 18 ms | 0 |
| `/cuencada/2027` | 98 | 100 | 96 | 2.04 s | 15 ms | 0 |
| Fotos `/galeria/2027` (warm) | 100 | 100 | 100 | 0.94 s | 38 ms | 0.007 |

- Performance on this shared machine ranged from 90 to 99 between runs (load average around 13). Accessibility and best practices didn't move.
- Best practices is 96 because of "errors-in-console": the expected anonymous `/auth/refresh` 401.
- `vite preview` serves without compression (nginx compresses in production), so performance is a lower bound.
- CI runs Lighthouse as a non-blocking step, writes the score table to the job summary (`$GITHUB_STEP_SUMMARY`) and uploads the JSON.

## CI (`.github/workflows/e2e.yml`)
- Triggers on `pull_request` to main and `workflow_dispatch`, with read-only permissions and a per-ref concurrency group.
- Runs a Postgres 16 service on `55432` (the harness creates `cuencada_e2e` itself).
- Steps:
  1. `pnpm install --frozen-lockfile`
  2. `playwright install --with-deps chromium`
  3. install the pinned fonts (`fonts-dejavu-core`, `fonts-noto-color-emoji`)
  4. `pnpm e2e:build`
  5. `pnpm typecheck:e2e`
  6. mark the Postgres service as the test cluster (`ALTER DATABASE postgres SET cuencada.test_cluster`)
  7. `pnpm e2e:run`
  8. `pnpm e2e:lighthouse` (continue-on-error, scores in the job summary)
- Uploads the Lighthouse summary always, and `test-results/e2e/` plus `playwright-report/` (traces, screenshots) on failure.
- Actions are pinned by SHA: checkout, pnpm and setup-node as in `ci.yml`, plus `actions/upload-artifact@043fb46…` (v7.0.1).

## Bugs found
| # | Bug | Fix |
|---|---|---|
| 1 | **Invite link sometimes stuck on "Revisando tu invitación…".** `InvitePage` inspected the invite on mount while the boot `/auth/refresh` was in flight. For an anonymous visitor the refresh returns 401, `loggedOut` runs `resetApiState()`, and that aborts the in-flight inspect. The abort is swallowed and `started` is already set, so the page spins forever. It showed up as a flaky journey 2b. | Commit a9fd97d. The inspect waits until the session gate isn't `waiting`. Unit test: "waits for the boot session check before inspecting …" fails before the fix and passes after. Magic-link and verify pages are unaffected: they consume on a tap, after the gate. |
| 2 | **Chat log not reachable by keyboard** (axe serious `scrollable-region-focusable`, WCAG 2.1.1). The message log scrolls but had `tabIndex={-1}`. When every message is someone else's there's no focusable child, so a keyboard user can't scroll it. | Commit aacf8e4. `tabIndex={0}`; the existing `:focus-visible` outline applies. Unit test in `ChatPage.test.tsx`. The e2e seed has a one-sender history, so the gate covers this case. |
| 3 | **Year page scrolled sideways at 320 px** (details below) | Commit 96c571d |

**Bug 3 in detail.** `/cuencada/2026` and `/cuencada/2027`, anonymous and member, had a scrollWidth up to 331 at 320 px. The CI overflow gate found it.
- Causes:
  - The programa `.timeline` grid had an implicit `auto` column, so a day card's min-content set its width (nowrap Badge chips such as "📍 Lobby Hotel Chariot", long titles).
  - The section-link strip hid its overflow behind an invisible scrollbar: "Clim…" was cut off and there was no affordance.
- Fix:
  - `.timeline` uses `minmax(0, 1fr)`; `.day` has `min-width: 0`.
  - Titles use `overflow-wrap: anywhere`, and chips wrap inside the card.
  - The date column has a little more room, so "Domingo" fits.
  - Section links **wrap** onto rows, so every link stays visible.
- Before/after at 320/375 px: `docs/ux/screenshots/e2e/year-{2026,2027}-programa-{before,after}-{320,375}.webp`.
- Regression check: the overflow gate plus the long-token fixture.

Flaky test fixed (pre-existing, also on main): `RsvpCard.test.tsx` "creates an RSVP with guests, dates and a hotel" failed about 1 in 5 runs.
- The failing DOM showed the success toast committed while the card was still on its pre-save render. The toast lives in a separate provider and can commit first.
- The card isn't stuck: the optimistic patch and then the server copy always arrive.
- The test now awaits the summary (`findByText`) and checks "Cambiar respuesta" is enabled. It passed 20 out of 20 runs (commit 26bd594).

Not bugs, recorded for UX:
- The Chat tab badge outside `/chat` refreshes on load and every 2 minutes, by design (T7). The journey reloads to observe it.
- The vite preview proxy logs "This socket has been ended by the other party" when a page with an open chat socket closes. This is harness noise only.

New backlog items: see `backlog.md` → "WP-2.2 findings".

## Decisions
- **No MinIO.** The `StorageService` interface plus `AppDeps.storage` already let the harness inject a store. A ~250-line loopback store keeps the real presigned flow: browser to bucket, CORS, signature-bound type and size, then server `head`/`getRange`/`put`. It needs no extra container in CI and no product change.
- **File mail sink, not an HTTP endpoint.** An endpoint would put a "read anyone's mail" route on the API, even if gated. Files keep the capability out of the HTTP surface entirely.
- **HTTPS preview.** It's required for `wss:` chat and the `https:` upload origin in a production build. It also makes the refresh cookie use its production name and flags (`__Secure-cuencada_rt`, `Secure`).
- **Chromium for both phone profiles.** WebKit needs extra system dependencies and has limited service-worker support in Playwright. See Requests.
- **Separate e2e build** (`dist-e2e`): the release `dist/` (size gate, `check:sw`) stays untouched.
- **Screenshots** are 375 px viewport, 2x, WebP, written only with `E2E_UPDATE_DOCS=1`, using fictional data and the pinned DejaVu font, so they look more generic than on a phone. The 2026 edition content comes from the existing public seed, with fake member links.

## Requests
1. **Security:** review the harness guards above, in particular that nothing in `tests/e2e/harness` can be reached from `apps/server/dist` or the deploy.
2. **TL / CI owner:** decide whether `e2e.yml` should be a required check, and whether Lighthouse should block (it's non-blocking today because runner performance varies).
3. **UX / 0.8c follow-up:** the backlog items under "WP-2.2 findings".
4. **Later:** add a WebKit project (`devices["iPhone 13"]` as-is) once CI installs WebKit dependencies; service-worker checks may need to stay Chromium-only.

## Review round (PR #37)
| Item | Commit |
|---|---|
| Security L2: DB guard requires port 55432 (or the exact `E2E_ALLOW_DB_PORT`) **and** the live `cuencada.test_cluster` marker before any DROP/CREATE; `scripts/test-db.sh up` sets the marker idempotently on the running container; CI sets it on its service; unit tests | 5fd388d |
| Security L1: the seed gets an explicit e2e-only env allowlist, never `process.env`; unit tests | df4a255 |
| Doc: the harness requires `E2E=1`, refuses `NODE_ENV=production` and forces `NODE_ENV=test` | 85ea21d |
| TL 1: fonts pinned so the gate is deterministic (local run reproduced CI exactly) | 647cec2 |
| TL 1: year-page overflow fix (product) + before/after screenshots | 96c571d |
| TL 1: long-token fixture + content-ready checks in the gates | a8b87c6 |
| TL 2: `RsvpCard` flaky test | 26bd594 |
| TL 4: fixture branch "Norte" (no "Rama Rama Ejemplo"; the product hint has the same issue, see the backlog) | 7e6b6af |
| TL 5: Lighthouse scores in `$GITHUB_STEP_SUMMARY` | dcf8b4a |
| TL 3: gate gaps documented (above) | this doc |
