# WP-T9 PWA [SEC]
Owner: Frontend · Reviewers: TL, Sec · Branch: wp/t9-pwa · PR: # (not opened)

Built on `origin/main` (885b4e9). Inputs: docs/plan.md (Frontend → PWA), WP-0.6 (memory-only auth, `isOffline`, `sessionEpoch`, fragment-token scrub at boot), WP-0.7 (icons, manifest colours), and the server CSP in `apps/server/src/plugins/security.ts`.

## Scope
- **`vite-plugin-pwa`** in `apps/web/vite.config.ts`. The options live in `src/features/pwa/pwaConfig.ts` so tests can import them. The proxy, dev host and size config are unchanged.
  - `strategies: 'generateSW'`, `registerType: 'prompt'`, `skipWaiting: false`, `clientsClaim: true` (on first install only, since no older worker exists), `cleanupOutdatedCaches`.
  - **`injectRegister: null`**: no inline or injected registration script. The worker is registered from our own bundled module through `workbox-window`, so the CSP `script-src 'self'` holds. `scripts/check-sw.mjs` asserts that `dist/index.html` has no inline script and no `registerSW.js`.
  - `devOptions.enabled: false`: dev has no service worker, so HMR and the `/api` proxy are untouched.
  - **Manifest** (`/manifest.webmanifest`, linked by the plugin at build): name and short_name "Cuencada", `lang: es-MX`, `start_url: /`, `scope: /`, `id: /`, `display: standalone`, `orientation: portrait`, `theme_color #0b5e55`, `background_color #fffaf0`, and the four WP-0.7 icons (any and maskable, 192 and 512).
- **Caching policy** (`src/features/pwa/swRules.ts`; matchers and plugin are self-contained because Workbox serializes them):
  - **Precache** (105 entries, about 1.1 MB): the app shell (`index.html`), every JS and CSS chunk, icons, `images/*.webp`, the manifest and `sw-purge.js`. Glob `**/*.{js,css,html,svg,png,webp,ico,webmanifest}`. Ignored: `**/canciones/**`, `**/api/**`, `**/*.map`. JPEG photos are not precached.
  - **Runtime, NetworkFirst** (`cuencada-public-api`, 6 s network timeout, only 200s cached, 12 entries, 30 days): only same-origin `GET /api/cuencadas` (the public edition list, exactly `^/api/cuencadas$`), `GET /api/cuencadas/home` and `GET /api/cuencadas/{4-digit year}`, with no query string and no trailing slash.
    - I checked `packages/types/src/cuencadas.ts` and the server's `public-routes.ts`. `cuencadaSummarySchema` (the list), `publicCuencadaSchema` and `cuencadaHomeSchema` carry only public items, and the server builds them from `ContentScope.Public` and strips extra fields through the response schema. `heroImageUrl` and `songUrl` are stored values, not presigned URLs.
    - `authorName` on public announcements is public by design.
  - **Not routed at all**, so the browser handles them natively (network only, nothing cached by the SW):
    - every other `/api/**` route, including `/api/cuencadas/:year/members`, `/api/cuencadas?…` and `/api/cuencadas/`, `/me`, directory, profile, media, admin and all of `/api/chat/*` (the ticket POST; the `/api/chat/ws` WebSocket upgrade never reaches a SW `fetch` handler anyway)
    - presigned S3 URLs and every other cross-origin request (the weatherwidget iframe, Google Maps), because the matcher requires `sameOrigin`
    - `/canciones/*`
  - **Navigation fallback** `index.html`. The denylist (tested against `pathname + search`):
    - `^/api(/|$)`
    - any URL carrying `?ticket=` / `&ticket=` (chat WebSocket tickets)
    - real files: `^/canciones/`, `^/images/`, `^/icons/`, and any path whose last segment has a 2–12 character extension (12 so `.webmanifest` counts) (`/sw.js`, `/robots.txt`, `/foo.webmanifest`), so a missing file 404s from the server instead of returning the HTML shell. App routes such as `/cuencada/2026` and `/arbol/:uuid` still fall back.
- **Song decision: network only.** `Cancion_Oficial.mp3` (4.2 MB) is neither precached nor runtime-cached.
  - `<audio>` always fetches with `Range` headers and gets 206 partial responses. Workbox cannot build a cache entry from those; it needs a full 200 response first plus `RangeRequestsPlugin`, which only precaching provides.
  - A CacheFirst rule would therefore never populate, and precaching 4 MB on every install is too heavy for phones on the trip.
  - Offline, the song does not play; everything else on the page works.
- **Update UX** (`PwaStatus.tsx`), fixed above the BottomNav (`--z-banner`), non-blocking:
  - The banner says "Hay una versión nueva", with **Actualizar** and **Más tarde**.
  - **Actualizar** switches it to "¿Recargar ahora? Si estás subiendo fotos, espera a que terminen.", with **Recargar ahora** and **Cancelar**.
  - **Recargar ahora** sends `SKIP_WAITING` to the waiting worker. On `controlling`, the page reloads exactly once.
  - The gallery upload manager's in-flight state is not part of the gallery's public surface (see Requests), so the update always asks first. The gallery's own `beforeunload` guard still fires on the reload as a backstop.
  - Open tabs check for a new `sw.js` hourly while online.
- **Offline UX:**
  - The service worker tells **only the requesting page** (`event.clientId`) whether a public read came from the cache or the network. The message carries no data.
  - While the last answer came from the cache, the page shows **"Sin conexión — mostrando la última versión guardada"** when WP-0.6's `isOffline` is set or `navigator.onLine` is false. Otherwise (a network timeout while online) it shows "Conexión lenta — mostrando la última versión guardada".
  - The next network answer clears the notice. RTK Query's `refetchOnReconnect` triggers it.
  - The listener is installed when the initial chunk evaluates, because a message to a page with no listener yet is dropped once the client message queue opens. Caught in manual testing.
- **Install** (`InstallAppCard`, on `/mas`):
  - Android/Chromium: the deferred `beforeinstallprompt`, captured early, behind an **Instalar** button.
  - iOS: the hint "En iPhone o iPad: toca Compartir y luego “Agregar a inicio”."
  - Hidden when the app already runs standalone or the browser offers neither.
  - Dismissible. The dismissal is stored in localStorage (`cuencada-install-dismissed = "1"`, a UI preference, not sensitive). A dismissed native prompt also counts as a dismissal.
- **Logout and user-switch purge** [SEC] (`purge.ts`, `startPwa.ts`):
  - The page subscribes to `auth.sessionEpoch`, which is bumped by every `loggedOut` (this tab, a cross-tab broadcast, a refused refresh) and by every account switch A → B.
  - On each bump:
    - `caches.delete` of every runtime cache from the page
    - a `{ type: "cuencada:purge-runtime-caches" }` message to the controlling worker, and to the active worker if it does not control the tab yet
    - the "cached" notice is cleared
  - The worker side is `public/sw-purge.js`, loaded with Workbox `importScripts`. It ignores messages from other origins. The precache (app shell, no user data) is kept so the app still opens offline.
  - A public NetworkFirst fetch already in flight can re-add a public entry after the purge. That entry is public data only, so it is accepted.
- **Fragment tokens (`#t=`):** fragments never reach the service worker. Navigations get the precached `index.html`, and WP-0.6's boot scrub runs unchanged. `check:sw` asserts that `/entrar` falls back to the shell.
- **App-shell edits (authorized minimal):**
  - `AppLayout.tsx`: one import and `<PwaStatusMount />`
  - `MorePage.tsx`: one import and `<InstallAppCard />`, needed for item 4 (see Requests)
  - `PwaStatusMount` is eager and tiny. It lazy-loads `PwaStatus` and fails soft, like the VerifyEmailBanner pattern.

## Interfaces exposed
- `features/pwa/index.ts`: `PwaStatusMount`, `InstallAppCard`.
- Service worker messages:
  - page → SW: `{ type: "cuencada:purge-runtime-caches" }`
  - SW → page: `{ type: "cuencada:public-api-source", source: "cache" | "network" }`
  - Workbox's own `{ type: "SKIP_WAITING" }`
- Runtime cache name: `cuencada-public-api`. It is kept in sync with `public/sw-purge.js`, and a unit test checks this.
- `pnpm --filter @cuencada/web check:sw` runs `apps/web/scripts/check-sw.mjs` against `dist/` (after a build).

## nginx for WP-2.4
```nginx
# The SW and its imported script must be revalidated on every update check.
location = /sw.js            { add_header Cache-Control "no-cache" always; <repeat the security headers + CSP>; try_files $uri =404; }
location = /sw-purge.js      { add_header Cache-Control "no-cache" always; <repeat the security headers + CSP>; try_files $uri =404; }
location = /manifest.webmanifest {
  default_type application/manifest+json;
  add_header Cache-Control "no-cache" always; <repeat the security headers>; try_files $uri =404;
}
location = /index.html       { add_header Cache-Control "no-cache" always; <security headers + CSP>; }
# Hashed build output (incl. workbox-<hash>.js) is immutable.
location /assets/            { add_header Cache-Control "public, max-age=31536000, immutable" always; <security headers>; }
```
- `add_header` inside a `location` replaces the server-level headers, so repeat the CSP and security headers in each block.
- **The CSP must also be on the `sw.js` response.** A worker's CSP comes from its own script response. Its `connect-src 'self'` governs the worker's `fetch`, which only ever touches same-origin `/api/cuencadas/*`.
- **No `Service-Worker-Allowed` header is needed:** `sw.js` is at the root and its scope is `/`.
- The page CSP already has `worker-src 'self'` and `manifest-src 'self'` (`security.ts`). Nothing new is required.
- Keep `/api/**` and `/canciones/**` out of the SPA `try_files` fallback, as today.

## Verification (2026-10-06, re-run after merging origin/main 4fd5b75)
- `pnpm lint`: 0 diagnostics.
- `pnpm turbo run typecheck --force`: 6/6 tasks succeed.
- `pnpm test`: 134 files, 1495 tests, all pass. Under heavy machine load (40+ vitest workers from parallel agents), 4 existing app tests timed out once at 5 s; they pass when re-run.
  - New PWA tests:
    - `swRules.test.ts`: public reads cached; `/members`, other APIs, chat ticket and ws, S3, weatherwidget, `/canciones` and writes not cached; navigation denylist; options; manifest; `sw-purge.js` sync; the plugin
    - `registerServiceWorker.test.ts`: prompt, apply, reload once, errors, hourly check
    - `PwaStatus.test.tsx`: update prompt with the register hook mocked; offline and slow notices
    - `purge.test.ts`: page and SW purge, epoch watch, logout → purge
    - `pwaListeners.test.ts`: SW message origin check; install prompt capture
    - `InstallAppCard.test.tsx`: prompt, iOS hint, dismissal stored and honoured, hidden when standalone
- `pnpm build`: succeeds. The precache has 105 entries, about 1112 KiB, and contains no mp3, jpg or api.
- `pnpm --filter @cuencada/web size`: initial JS is **171.6 kB gzip**, under the 190 KB gate (this WP adds about 0.5 kB: the mount wrapper and the early listeners). `PwaStatus` is a lazy 1.9 kB chunk, and `workbox-window` a lazy 2.4 kB chunk.
- **`check:sw` on the real build output.** It runs `dist/sw.js` and `sw-purge.js` in a `vm` with a fake Workbox, then exercises the routes it registered: 1 navigation route and 1 runtime route, every match and non-match above, the plugin, the purge (and that a foreign origin is ignored), `SKIP_WAITING`, and no inline scripts.
  - **It caught a real bug.** Workbox's production build (babel + terser) mangled a matcher written with destructured parameters into `function(){…s.search…}`, which never matched.
  - The matcher now takes a single parameter. The check guards against a regression.
- **Manual, headless Chromium 375×760** against `vite preview`, with the production CSP header and a stub API that uses fictional data:
  - The SW registers and controls the page. After visiting `/` and `/cuencada/2026`, the runtime cache holds exactly `/api/cuencadas/home` and `/api/cuencadas/2026`. `/api/cuencadas/2026/members` and `/api/me` were fetched online (200) and are **not** in any cache.
  - Offline, with the API and preview server stopped and the browser offline, a reload shows the shell, the cached public programa and the notice.
  - Offline, `/members` and `/me` fail with a network error; nothing is served from cache.
  - The purge message empties `cuencada-public-api` and keeps the precache.
  - A byte-changed `sw.js` shows the banner. Actualizar → Recargar ahora reloads once onto the new worker, and the banner is gone afterwards.
  - `/mas` shows the iOS hint, the dismissal persists across a reload, and the Android card appears via a synthetic `beforeinstallprompt`.
  - The console shows **no CSP violations**. The only errors are the expected 401 from `/auth/refresh` (anonymous) and `ERR_INTERNET_DISCONNECTED` while offline.
- **Screenshots** in `docs/ux/screenshots/t9/`: `update-banner-375`, `update-confirm-375`, `offline-programa-375`, `offline-home-375`, `install-ios-375`, `install-android-375` (webp). _(WP-0.8a: `apps/web/public/images/fotos/` was removed; real family photos are members-only, and these screenshots were deleted pending a re-take with placeholders.)_

## Requests
1. **TL / CI:** done (approved): `pnpm --filter @cuencada/web check:sw` runs after the `size` step in `.github/workflows/ci.yml`.
2. **T4-FE (gallery):** expose a non-creating `hasUploadsInFlight(store): boolean` from `features/gallery/index.ts`. It would wrap the existing `UploadManager.hasInFlight()` without instantiating the manager. The update prompt could then skip the "¿Recargar ahora?" step when idle and refuse to reload mid-upload. Until then it always confirms, and `beforeunload` is the backstop.
3. **Orchestrator:** approved: the one-line `MorePage.tsx` mount of `<InstallAppCard />`.
4. **WP-2.4:** the nginx headers above.
5. **UX / WP-0.6 owner (optional):** offline, WP-0.6's top `OFFLINE_NOTICE` ("Sin conexión. Reintentaremos…") and T9's bottom "mostrando la última versión guardada" both show. They don't conflict, but one combined banner may read better.

## Open questions
- Decided: `GET /api/cuencadas` (the PII-free edition list) is cached too, in the same NetworkFirst rule (orchestrator, after the TL review of PR #29).
- Backlog for WP-2.4: if public assets (`heroImageUrl`, `songUrl`) ever move to presigned URLs, the cached JSON would hold expiring URLs. Keep public assets on stable public URLs.

## Review log
- PR #29, TL approved. Follow-up before merge (orchestrator):
  - The navigation fallback no longer answers real files (`/canciones/`, `/images/`, `/icons/`, any path ending in a file extension).
  - `GET /api/cuencadas` (exact, no query) joins the public NetworkFirst rule.
  - Unit tests and `check:sw` cover both, positive and negative cases.
