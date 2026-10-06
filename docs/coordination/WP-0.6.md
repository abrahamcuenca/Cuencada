# WP-0.6 Web foundation [SEC]
Owner: Frontend · Reviewers: TL, Sec · Branch: wp/0.6-web-foundation · PR: # (not opened)

Stacked on `wp/0.1-test-infra`, `wp/0.2-contracts` (revised, 4e882d7) and `wp/0.7-design-system`; `origin/main` (#1, #2, #3, #5) merged in for the review round.

## Scope
- **Dependencies (all planned web deps):**
  - runtime: `@reduxjs/toolkit`, `react-redux`, `workbox-window`
  - dev: `vite`, `@vitejs/plugin-react` (moved from dependencies) and `vite-plugin-pwa` (not configured; T9 owns it)
  - root dev: `@playwright/test` for Phase 2 (no browsers downloaded)
- **Store** `src/app/store.ts`: `auth` + `api` reducers. On `loggedOut` a listener resets the RTK Query cache, cancels the online refresh retry and (for an authenticated session) forgets a stashed fragment token. On `credentialsReceived` it drops an unconfirmed-logout marker. Redux DevTools is on only in dev (`devTools: import.meta.env.DEV`). `makeStore()` gives tests an isolated store.
- **Auth core** `src/features/auth/`:
  - `authSlice.ts`: `{ accessToken, user, status: idle|restoring|authenticated|anonymous, passwordChangeRequired, isOffline, sessionEpoch, logoutPending }`. It is **memory only**.
  - `session.ts`: the `restoreSession()`, `logout()` and `completePendingLogout()` thunks.
  - `pendingLogout.ts`: the non-secret `cuencada-pending-logout` localStorage marker (an ISO timestamp, nothing else).
  - `useFragmentToken.ts`: reads the stashed `#t=` token for the current page and keeps the router location hash-free.
  - `authSync.ts`: cross-tab logout over `BroadcastChannel('cuencada-auth')`.
  - `guards.tsx`: `RequireAuth`, `RequirePasswordChanged`, `RequireAdmin`.
  - `redirect.ts`: `safeRedirectPath` for the post-login redirect.
  - `legacy.ts`: removes the `cuencada-demo-user` key.
- **API** `src/shared/api/`:
  - `baseApi.ts`: one `createApi`, every tag type, no endpoints.
  - `reauth.ts`: `rawBaseQuery`, `baseQueryWithReauth`, `refreshAccessToken`, `withRefreshLock`.
  - `errors.ts`: `parseApiError` / `getApiErrorCode` / `getApiErrorMessage`, built on the contract `apiErrorSchema`, plus `isAbortError`.
- **Router** `src/app/router.tsx`: `createBrowserRouter` over every feature's `routes.tsx`. Every route is lazy. There is a 404 page and an error boundary, and `/_ui` mounts the WP-0.7 `StyleGuide` in dev only.
- **Layout** `src/app/AppLayout.tsx`: built from the WP-0.7 `PageShell` + `TopNav` + `BottomNav` (Inicio, Programa, Fotos, Chat, Más). The banner slot shows the offline notice or the unconfirmed-logout notice. `layout.module.css` only styles the brand link.
- **`/mas`** `src/app/MorePage.tsx`: the mobile "Más" tab, a session-level route owned by the app. Large rows (WP-0.7 `Button`, `size="lg"`, `fullWidth`): Directorio, Árbol familiar, Mi perfil, Sesiones, Administración (admins only), then Cerrar sesión. At ≥900px the TopNav shows the links directly.
- **Boot** `src/app/bootstrap.ts`, called from `main.tsx` before the router is created:
  1. scrub a `#t=` fragment token from the URL and history, stashing it in memory for its path
  2. remove the legacy key
  3. start the cross-tab sync and RTK Query's `setupListeners` (for `refetchOnReconnect`)
  4. finish an unconfirmed logout if the marker is set, **instead of** refreshing; otherwise run the silent `/auth/refresh`
- **Libs:**
  - `src/shared/lib/dates.ts`: `formatDate`, `formatTime`, `toZonedParts`, `computeCountdown` (`es-MX`, Cuencada IANA timezone)
  - `src/shared/lib/env.ts`: validated `VITE_API_BASE_URL`
  - `src/shared/lib/featureRoutes.ts`: the `FeatureRoutes` type
  - `src/shared/lib/fragmentToken.ts`: `readAndScrubFragmentToken` / `clearFragmentToken`
  - `src/shared/lib/reportUnexpected.ts`: `reportError` with a fallback for Safari < 15.4 (rethrow in a microtask); the hook point for Sentry
- **Feature stubs** for auth, cuencadas, rsvp, gallery, profile, directory, family, chat, admin and pwa. Each has a `routes.tsx` and an `api.ts` with an empty `injectEndpoints`. The old pages moved into `features/<f>/pages/`.
- **Removed:**
  - `src/app/auth.tsx` (the fake demo auth, `loginAsDemoAdmin`)
  - `PanelPage` (`/panel` is not in the route plan; its links now go to `/entrar` or `/cuencada/2026`)
  - `components/SiteHeader` (replaced by `AppLayout`; its smoke test moved to `AppLayout.test.tsx`)
- **Vite:**
  - `/api` is proxied to `127.0.0.1:3006` with `ws: true`
  - `CUENCADA_DEV_HOST=1` (or an IP) opts the dev server into LAN access for phone testing. Use it only on trusted networks: anyone on that Wi-Fi reaches the dev API through the proxy.
- **CI size gate:** `scripts/check-bundle-size.mjs` sums the gzip size of the entry script plus every `modulepreload` in `dist/index.html` and fails above **190 KB** (KB = 1000 bytes, like Vite's report). Run it with `pnpm --filter @cuencada/web size`. `.github/workflows/ci.yml` now runs `pnpm build` and then the size check.
- **WP-0.7 hand-offs done:**
  - `main.tsx` imports `tokens.css` then `base.css` (then the legacy `styles.css`)
  - `index.html` has `viewport-fit=cover`, the favicon and `apple-touch-icon`
  - `ToastProvider` is in `AppProviders`
  - the header logo is `/images/logo-96.webp`

## Interfaces exposed

### Routes and guards
| Path | Feature (track) | Level |
|---|---|---|
| `/`, `/cuencada/:year` | cuencadas (T2) | public |
| `/entrar`, `/entrar/enlace`, `/invitacion`, `/recuperar`, `/restablecer`, `/verificar` | auth (T1) | public |
| `/cambiar-contrasena` | auth (T1) | session (logged in, allowed while `mustChangePassword`) |
| `/mas` | app (WP-0.6) | session |
| `/perfil/sesiones` | auth (T1) | member |
| `/perfil` | profile (T5) | member |
| `/directorio` | directory (T5) | member |
| `/arbol/:personId?` | family (T6) | member |
| `/galeria/:year?` | gallery (T4) | member |
| `/chat/:roomId?` | chat (T7) | member |
| `/admin/*` | admin (T8) | admin |
| `/_ui` | WP-0.7 style guide | dev only |
| `*` | 404 | public |

Guard nesting is `RequireAuth > (session | RequirePasswordChanged > (member | RequireAdmin > admin))`.
- While `status` is `idle` or `restoring`, guarded routes show a spinner and never redirect.
- Anonymous users go to `/entrar` with `location.state = { from: pathname + search }`. The hash is never included because it may carry tokens.
- The guards are **UX only**. The server enforces every rule.

### Auth state and actions (for T1 and others)
| Action / thunk | Use |
|---|---|
| `credentialsReceived({ accessToken, user })` | After login, magic-link consume, invite accept and change-password (the `AuthTokenResponse`) |
| `tokenRefreshed(...)` | Dispatched by the base query or boot. Tracks don't dispatch it |
| `refreshDeferredOffline()` | Dispatched by the base query when the refresh can't reach the server. Read it with `selectIsOffline` |
| `passwordChangeRequired()` | Dispatched by the base query on 403 `PASSWORD_CHANGE_REQUIRED` |
| `loggedOut()` | Local logout only. Use the `logout()` thunk for the user action |
| `logout()` thunk | `loggedOut` (bumps the epoch), broadcast to other tabs, write the pending-logout marker, then `POST /auth/logout` with CSRF under the refresh lock. Resolves `{ serverConfirmed }`. If unconfirmed, the layout shows the notice and the call is retried on `online` and at the next boot |
| `restoreSession()` thunk | Boot only (already wired) |
| `completePendingLogout()` thunk | Retries an unconfirmed logout. Wired to `online` and boot; tracks don't call it |
| `redirectPathFromState(location.state)` | Where `/entrar` should send the user after login. Never navigate to an unvalidated `from` |

Selectors: `selectCurrentUser`, `selectIsOffline`, `selectLogoutPending`, `selectSessionEpoch`, `selectAccessToken`, `selectAuthStatus`, `selectPasswordChangeRequired`, `selectIsAdmin` (a UX hint only). Typed hooks are `useAppDispatch` and `useAppSelector` from `src/app/hooks.ts`.

### baseQueryWithReauth behaviour
1. Every request sends `credentials: "include"` plus `Authorization: Bearer <memory token>`.
2. **401 `TOKEN_EXPIRED`:** one refresh runs, then the original request is retried **once**.
   - The refresh is single-flight in the tab and runs under `navigator.locks.request("cuencada-refresh")` (or directly when Web Locks is missing).
   - It sends `POST /auth/refresh` with `X-Cuencada-CSRF: 1`.
   - On 409 `REFRESH_RACE` the refresh is retried once, after 150 ms.
   - On success the response is validated with `refreshResponseSchema`, then `tokenRefreshed` is dispatched.
   - **No usable answer** (no HTTP response, a 5xx, or a 200 that isn't our JSON or fails the schema, e.g. a hotel captive portal): the session is kept, `refreshDeferredOffline` sets `isOffline`, and the refresh is retried on the next `online` event. The original 401 is returned to the caller. At boot, `status` stays `restoring`, and guarded routes show "Sin conexión" with a Reintentar button instead of redirecting. While `isOffline`, the layout shows an offline banner.
   - **A refusal** (401, 403 `CSRF_FAILED`, 409 after the retry, other 4xx) dispatches `loggedOut`.
   - **Logout epoch [SEC]:** the refresh captures `auth.sessionEpoch` before its request. Every `loggedOut` (this tab, or a broadcast from another tab) increments it. A refresh result that lands after the epoch changed is discarded, so a logout always sticks.
   - `loggedOut` from any source cancels the pending online retry, so a logout made while offline is never undone by a later refresh.
3. **403 `PASSWORD_CHANGE_REQUIRED`:** dispatches `passwordChangeRequired()`, and the router moves the user to `/cambiar-contrasena`.
4. **401 `UNAUTHENTICATED` while holding a token** (revoked session, disabled user): dispatches `loggedOut`.
5. `loggedOut` resets the whole RTK Query cache. This **aborts in-flight queries and mutations**: `.unwrap()` rejects with `name: "AbortError"`, and the guards redirect anyway. Use `isAbortError(error)` to skip error toasts for it.
6. `refetchOnReconnect: true`: when the browser comes back online, active queries refetch by themselves (they join the single-flight refresh if their token expired).

Error bodies are parsed with the contract `apiErrorSchema`. Branch on `getApiErrorCode(error)`, never on the message. Show `getApiErrorMessage(error)` to the user.

## How Phase-1 tracks add routes, endpoints and tags
You only touch `features/<f>/**` (and your `packages/types/src/<m>.ts`). **Never edit** `router.tsx`, `store.ts`, `baseApi.ts` or `reauth.ts`.

**1. Add a page and route.** Put it in `features/<f>/routes.tsx` under the right level (`public`, `session`, `member` or `admin`). Every route must be lazy, and paths are absolute and in Spanish:
```tsx
// features/directory/routes.tsx
export const directoryRoutes: FeatureRoutes = {
  member: [
    { path: "/directorio", lazy: async () => ({ Component: (await import("./pages/DirectoryPage")).DirectoryPage }) },
    { path: "/directorio/:id", lazy: async () => ({ Component: (await import("./pages/DirectoryEntryPage")).DirectoryEntryPage }) }
  ]
};
```
For nested admin screens, `admin/pages/AdminPage.tsx` owns `/admin/*`. Use descendant `<Routes>` inside it, or change the admin entry to `{ path: "/admin", lazy, children: [...] }` in `features/admin/routes.tsx`.

**2. Add endpoints.** Put them in `features/<f>/api.ts` with `injectEndpoints`. Use the `XxxRequest` (`z.input`) types for args and the response interfaces for results. Use only the tag types already declared in `API_TAG_TYPES`:
```ts
// features/directory/api.ts
import type { DirectoryEntry, DirectoryQueryRequest, Page } from "@cuencada/types";
import { baseApi } from "../../shared/api/baseApi";

export const directoryApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    listDirectory: build.query<Page<DirectoryEntry>, DirectoryQueryRequest>({
      query: (params) => ({ url: "/directory", params }),
      providesTags: (result) => [
        { type: "Directory", id: "LIST" },
        ...(result?.items ?? []).map((entry) => ({ type: "Directory" as const, id: entry.userId }))
      ]
    })
  })
});

export const { useListDirectoryQuery } = directoryApi;
```
- URLs are relative to the API base (`/api`), so write `"/directory"`, not `"/api/directory"`.
- Don't add auth headers or retry logic; the base query does that.
- **Never toast on an abort.** In `catch` blocks and error UIs, check `isAbortError(error)` from `shared/api/errors.ts` first and render nothing for it; the logout that caused it already moves the user.
- For cookie-auth endpoints other than refresh/logout, ask first.

**3. Tags.** All tags are declared up front:
- T1: `CurrentUser`, `Session`, `Invite`
- T2: `Cuencada`, `CuencadaHome`, `Itinerary`, `Location`, `DailyMessage`, `Announcement`
- T3: `Rsvp`, `RsvpSummary`, `Attendee`, `Attendance`
- T4: `Media`, `MediaReport`
- T5: `Profile`, `Directory`
- T6: `Person`, `Relationship`, `FamilyTree`
- T7: `ChatRoom`, `ChatMessage`
- T8: `AdminUser`, `AuditLog`

If you need a new tag, ask the orchestrator; it's a Phase-0 change to `baseApi.ts`.

**4. Fragment tokens [SEC].** Invite, magic-link, reset and verify links put their token in `#t=…` (`t` is the canonical name; the ADR is being aligned). `bootstrapApp` scrubs it with `history.replaceState` before the router is created, so a failed chunk or a 404 never leaves it in the URL, and stashes it in memory for that path. In those pages, read it with `useFragmentToken()` (`features/auth/useFragmentToken.ts`), which also replaces the router location without the hash if an in-app navigation carried one. Call `clearFragmentToken()` after the POST consumes it; logout of an authenticated session clears it too. Never put a token in a query string, a log or web storage. `index.html` sets `<meta name="referrer" content="strict-origin-when-cross-origin">`.

**5. Dates.** Use `formatDate`, `formatTime` and `toZonedParts` from `shared/lib/dates.ts` with `cuencada.timezone`. Never use the device timezone.

**6. Tests.** Use `renderApp(path, preloadedState)` from `apps/web/test/renderApp.tsx` (the real router, guards and layout) and the fixtures in `apps/web/test/auth.ts`: `makeUser`, `authenticatedState`, `statusState`, `tokenBody`, `errorBody`, `apiUrl`. Mock HTTP with MSW, using `setupServer` per file and `apiUrl("/directory")` in handlers.

## Decisions
- **`passwordChangeRequired` is a 4th field in `authSlice`.** It's set from `user.mustChangePassword` and from 403 `PASSWORD_CHANGE_REQUIRED`, so the guard reacts to both.
- **`status` stays `authenticated` during a mid-session refresh.** Only the boot refresh shows `restoring`, so pages never unmount for a token refresh.
- **Only a server refusal logs out.** A refresh the server refuses (401, CSRF failure, 409 after the retry, malformed body) dispatches `loggedOut` but does **not** broadcast, because the other tabs share the cookie and will find out on their own refresh. An explicit `logout()` does broadcast. Network errors and 5xx keep the session (`isOffline`) and retry on `online`; 5xx is grouped with network errors because a down server or proxy is not a reason to sign anyone out.
- **Offline logout is completed later [SEC].** `logout()` writes a non-secret `cuencada-pending-logout` marker (ISO timestamp only) **before** calling the server, and clears it only on a 2xx or 401 (the session is already dead). Until then the layout shows "Cerraste sesión en este dispositivo, pero no pudimos confirmarlo con el servidor. Se completará al reconectar.", and the call is retried on `online`. At boot, a set marker makes the app call `/auth/logout` **instead of** refresh and stay anonymous, so the still-valid cookie never logs the previous user back in. A new login on the device drops the marker, because it replaced the cookie.
- **The epoch lives in the auth state** (`sessionEpoch`), not in module state. It's per store, so tests stay isolated, and a broadcast logout bumps it through the same `loggedOut` reducer.
- **Logout clears local state first**, then broadcasts, then sends the server request under the `cuencada-refresh` lock. With the epoch, an in-flight refresh can't revive the session, and the lock means the logout never interleaves with a cookie rotation in another tab.
- **Captive portals count as unreachable.** A 200 that isn't JSON (`PARSING_ERROR`) or fails `refreshResponseSchema` keeps the session (`isOffline`) instead of logging out. Only a JSON refusal (4xx) logs out.
- **The shared refresh uses a detached abort signal**, so unmounting the component that triggered it never aborts the refresh for everyone else.
- **Boot runs outside React** (`bootstrapApp` in `main.tsx`), so StrictMode can't run it twice. If something unexpected goes wrong, the session is cleared and the error goes to `reportUnexpected`; the app is never stuck in `restoring`.
- **`VITE_API_BASE_URL`** must be a same-origin path or an absolute URL without credentials, query or hash, resolved against `window.location.origin`. In production builds an absolute URL must be `https:`.
- **`baseApi` (now frozen) sets `refetchOnReconnect: true`**, with `setupListeners(store.dispatch)` in `bootstrapApp`.
- **"Más" is a page, not a sheet.** `/mas` is a full page of large rows instead of the wireframe's bottom-sheet `Dialog`: it's reachable by URL, works with Back, needs no focus management, and keeps the Dialog code out of the initial chunk. The sheet can replace it later without changing the BottomNav.
- **Feature routes are `{ public, session, member, admin }` objects.** The router owns the guard tree, so features never import the guards.
- **AppLayout imports `shared/ui` primitives by file, not through the barrel.** This keeps unused primitives' CSS out of the initial chunk.
- **The legacy demo key is removed by `bootstrapApp`.** Nothing else in the app uses web storage for auth.
- **`src/data/cuencada2026.ts` is kept.** `HomePage` and `CuencadaYearPage` still use it. There's a `TODO(T2)` at each import.

### Changes outside my folders
- **`apps/web/test/setup.ts` (WP-0.1) was edited.** I added a `Request` subclass that drops the abort signal. jsdom's `AbortSignal` fails Node undici's brand check, and RTK Query always passes a signal. Without this, every `fetchBaseQuery` call in jsdom throws `Expected signal to be an instance of AbortSignal`.
  - **Bridging isn't feasible:** forwarding the jsdom abort to a native controller would need Node's own `AbortController`, but jsdom has already replaced the global, and undici keeps the original class to itself. The file has a `TODO(WP-0.1)`.
  - **Aborts are still tested at the RTK level:** `createAsyncThunk` rejects on abort whatever the fetch does, and `reauth.test.ts` covers `isAbortError` on a mutation aborted by `loggedOut`. Only aborting the underlying fetch is untestable.
  - Also noted in WP-0.1's review log.
- **`shared/ui/**` and `shared/styles/**`:** no edits.
- **WP-0.7 test setup:** resolved on `main`, which already dropped the docblocks and `shared/ui/testing.ts`. All WP-0.7 tests (including Toast, Button and TopNav) run under the root `web` project.
- **`apps/web/src/vite-env.d.ts`:** I kept main's `/// <reference types="vite/client" />` and added the typed `VITE_API_BASE_URL` back. Without it, the env value is `any`.
- **`apps/web/src/styles.css` (legacy):** added `TODO(T1/T2)` comments on the gold `.kicker` (≈1.8:1 on cream) and the white-on-green `.btn.whatsapp` (1.98:1).

## Verification (2026-10-06)
- `pnpm lint`: biome, 0 diagnostics.
- `pnpm typecheck`: 5/5 tasks succeed.
- `pnpm test`: 32 files, 282 passed, 1 todo. The web project alone has 22 files and 160 tests.
- `pnpm build`: succeeds. The initial JS chunk is **517.0 kB raw / 166.0 kB gzip**, under the 200 KB budget and the 190 KB CI gate (`pnpm --filter @cuencada/web size`). `/mas` is a separate 0.6 KB chunk. All pages are split into chunks of 0.2–1.5 KB gzip. CSS is 6.4 KB gzip. `/_ui` (StyleGuide) is absent from the production build.
- Approximate breakdown of the initial chunk, from a one-off `manualChunks` build (gzip):

  | Part | Size |
  |---|---|
  | react-dom + react-router | ≈96 KB |
  | Redux Toolkit + RTK Query | ≈28 KB |
  | zod (for `apiErrorSchema` / `refreshResponseSchema`) | ≈25 KB |
  | app code | ≈8.5 KB |
  | `@cuencada/types` | ≈2.5 KB |
  | other | ≈5 KB |

- **Screenshots:** in `docs/ux/screenshots/web-foundation/`: `layout-anon`, `layout` (admin) and `mas`, each at 375 and 1280. They were taken with headless Chromium against the dev server, with `/api/auth/refresh` stubbed. Measured horizontal overflow is 0 px in all six.

## Open questions (→ orchestrator)
1. **Zod is about 25 KB gzip of the initial chunk.** It's only there to validate error and refresh bodies. That's acceptable today, but if the budget gets tight, the auth path could use hand-written guards and lazy-load zod with the forms.
2. **Coordination board status row.** I didn't edit `docs/coordination/README.md`, to avoid conflicts with the other WPs. Please mark 0.6 as in review.

3. **BottomNav label at 320px.** "Programa" truncates to "Progra…" at 320px. This is a WP-0.7 `BottomNav` concern, since `shared/ui` is off-limits here: either an 11px label below 360px, or a shorter label.
4. **Dev dependency advisories (Security L4):** `vitest@3` pulls `tinypool` and `@vitest/mocker` with advisories, all dev-only. Schedule an upgrade to `vitest ≥ 4.1.11` repo-wide; that's a WP-0.1 decision.

### Answered
- **Offline refresh (orchestrator):** a network error must not log out. Implemented as above (`isOffline` plus a retry on `online`), with tests for both the network-error case and the 401 case.
- **Dev Origin through the Vite proxy:** noted for WP-0.4 (dev origin allowlist).
- **Duplicate countdown helpers:** T2 standardizes on `computeCountdown`. Both stay for now.
- **`/perfil/sesiones`:** stays in the auth feature (T1).

## Review log
- 2026-10-06, PR #6 round 1: changes requested by the TL and Security. Addressed:
  - **B1 (TL), logout vs refresh race:** session epoch in `authSlice` plus logout under the refresh lock. Tests cover the same-tab and cross-tab broadcast cases, and that the lock is taken.
  - **B2 (TL), merge with `main`:** merged; WP-0.7's fixes and tests survive, and the WP-0.7 note above is updated.
  - **M1 (Security), offline logout:** pending-logout marker, completed at boot instead of refresh and retried on `online`; a 401 counts as confirmed; the notice is shown. Tests cover each path.
  - **L1 (Security):** `devTools: import.meta.env.DEV`.
  - **L2 (Security):** fragment scrubbed at boot before the router, stash cleared on logout, router location hash-free; `#t=` is canonical.
  - **L3 (Security):** `https:` required for absolute API bases in production.
  - **L4 (Security):** dev-only advisories, left as an open question.
  - **TL non-blocking items:**
    - `refetchOnReconnect` plus `setupListeners`
    - captive portal treated as unreachable
    - `isAbortError`, with a test and how-to note
    - the `setup.ts` abort bridge is infeasible, explained above with a TODO
    - `reportUnexpected` fallback for missing `reportError`
    - `/mas` page
    - CI build step and the 190 KB size gate
    - the `env.ts` production rule
  - **Nits:**
    - `TODO(T1/T2)` comments in `styles.css`
    - typed `FakeServerState` in `reauth.test.ts` instead of the casts
    - the BottomNav truncation is raised as an open question for WP-0.7
