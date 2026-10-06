# WP-0.6 Web foundation [SEC]
Owner: Frontend · Reviewers: TL, Sec · Branch: wp/0.6-web-foundation · PR: # (not opened)

Stacked on `wp/0.1-test-infra`, `wp/0.2-contracts` (revised, 4e882d7) and `wp/0.7-design-system`.

## Scope
- **Dependencies (all planned web deps):**
  - runtime: `@reduxjs/toolkit`, `react-redux`, `workbox-window`
  - dev: `vite`, `@vitejs/plugin-react` (moved from dependencies) and `vite-plugin-pwa` (not configured; T9 owns it)
  - root dev: `@playwright/test` for Phase 2 (no browsers downloaded)
- **Store** `src/app/store.ts`: `auth` + `api` reducers. A listener resets the RTK Query cache on `loggedOut`. `makeStore()` gives tests an isolated store.
- **Auth core** `src/features/auth/`:
  - `authSlice.ts`: `{ accessToken, user, status: idle|restoring|authenticated|anonymous, passwordChangeRequired, isOffline }`. It is **memory only**.
  - `session.ts`: the `restoreSession()` and `logout()` thunks.
  - `authSync.ts`: cross-tab logout over `BroadcastChannel('cuencada-auth')`.
  - `guards.tsx`: `RequireAuth`, `RequirePasswordChanged`, `RequireAdmin`.
  - `redirect.ts`: `safeRedirectPath` for the post-login redirect.
  - `legacy.ts`: removes the `cuencada-demo-user` key.
- **API** `src/shared/api/`:
  - `baseApi.ts`: one `createApi`, every tag type, no endpoints.
  - `reauth.ts`: `rawBaseQuery`, `baseQueryWithReauth`, `refreshAccessToken`, `withRefreshLock`.
  - `errors.ts`: `parseApiError` / `getApiErrorCode` / `getApiErrorMessage`, built on the contract `apiErrorSchema`.
- **Router** `src/app/router.tsx`: `createBrowserRouter` over every feature's `routes.tsx`. Every route is lazy. There is a 404 page and an error boundary, and `/_ui` mounts the WP-0.7 `StyleGuide` in dev only.
- **Layout** `src/app/AppLayout.tsx`: built from the WP-0.7 `PageShell` + `TopNav` + `BottomNav` (Inicio, Programa, Fotos, Chat, Más). `layout.module.css` only styles the brand link.
- **Boot** `src/app/bootstrap.ts`, called from `main.tsx` before render:
  1. remove the legacy key
  2. start the cross-tab sync
  3. run the silent `/auth/refresh`
- **Libs:**
  - `src/shared/lib/dates.ts`: `formatDate`, `formatTime`, `toZonedParts`, `computeCountdown` (`es-MX`, Cuencada IANA timezone)
  - `src/shared/lib/env.ts`: validated `VITE_API_BASE_URL`
  - `src/shared/lib/featureRoutes.ts`: the `FeatureRoutes` type
- **Feature stubs** for auth, cuencadas, rsvp, gallery, profile, directory, family, chat, admin and pwa. Each has a `routes.tsx` and an `api.ts` with an empty `injectEndpoints`. The old pages moved into `features/<f>/pages/`.
- **Removed:**
  - `src/app/auth.tsx` (the fake demo auth, `loginAsDemoAdmin`)
  - `PanelPage` (`/panel` is not in the route plan; its links now go to `/entrar` or `/cuencada/2026`)
  - `components/SiteHeader` (replaced by `AppLayout`; its smoke test moved to `AppLayout.test.tsx`)
- **Vite:**
  - `/api` is proxied to `127.0.0.1:3006` with `ws: true`
  - `CUENCADA_DEV_HOST=1` (or an IP) opts the dev server into LAN access for phone testing
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
| `logout()` thunk | `POST /auth/logout` with CSRF, then `loggedOut`, then broadcast to other tabs. Resolves `{ serverConfirmed }` |
| `restoreSession()` thunk | Boot only (already wired) |
| `redirectPathFromState(location.state)` | Where `/entrar` should send the user after login. Never navigate to an unvalidated `from` |

Selectors: `selectCurrentUser`, `selectIsOffline`, `selectAccessToken`, `selectAuthStatus`, `selectPasswordChangeRequired`, `selectIsAdmin` (a UX hint only). Typed hooks are `useAppDispatch` and `useAppSelector` from `src/app/hooks.ts`.

### baseQueryWithReauth behaviour
1. Every request sends `credentials: "include"` plus `Authorization: Bearer <memory token>`.
2. **401 `TOKEN_EXPIRED`:** one refresh runs, then the original request is retried **once**.
   - The refresh is single-flight in the tab and runs under `navigator.locks.request("cuencada-refresh")` (or directly when Web Locks is missing).
   - It sends `POST /auth/refresh` with `X-Cuencada-CSRF: 1`.
   - On 409 `REFRESH_RACE` the refresh is retried once, after 150 ms.
   - On success the response is validated with `refreshResponseSchema`, then `tokenRefreshed` is dispatched.
   - **No HTTP answer (offline, DNS, timeout) or a 5xx:** the session is kept, `refreshDeferredOffline` sets `isOffline`, and the refresh is retried on the next `online` event. The original 401 is returned to the caller. At boot, `status` stays `restoring`, and guarded routes show "Sin conexión" with a Reintentar button instead of redirecting. While `isOffline`, the layout shows an offline banner.
   - **Any other answer** (401, 403 `CSRF_FAILED`, 409 after the retry, malformed body) dispatches `loggedOut`.
   - `loggedOut` from any source cancels the pending online retry, so a logout made while offline is never undone by a later refresh.
3. **403 `PASSWORD_CHANGE_REQUIRED`:** dispatches `passwordChangeRequired()`, and the router moves the user to `/cambiar-contrasena`.
4. **401 `UNAUTHENTICATED` while holding a token** (revoked session, disabled user): dispatches `loggedOut`.
5. `loggedOut` resets the whole RTK Query cache. This **aborts in-flight requests**: callers see an `AbortError` rather than the 401, and the guards redirect anyway.

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

**4. Fragment tokens [SEC].** Invite, magic-link, reset and verify links put their token in `#t=…`. In those pages, read it with `useFragmentToken()` (`features/auth/useFragmentToken.ts`). It wraps `readAndScrubFragmentToken()` from `shared/lib/fragmentToken.ts`, which reads `t` and immediately calls `history.replaceState` to drop the fragment. The token stays in memory for that page only; call `clearFragmentToken()` after the POST consumes it. Never put a token in a query string, a log or web storage. `index.html` sets `<meta name="referrer" content="strict-origin-when-cross-origin">`.

**5. Dates.** Use `formatDate`, `formatTime` and `toZonedParts` from `shared/lib/dates.ts` with `cuencada.timezone`. Never use the device timezone.

**6. Tests.** Use `renderApp(path, preloadedState)` from `apps/web/test/renderApp.tsx` (the real router, guards and layout) and the fixtures in `apps/web/test/auth.ts`: `makeUser`, `authenticatedState`, `statusState`, `tokenBody`, `errorBody`, `apiUrl`. Mock HTTP with MSW, using `setupServer` per file and `apiUrl("/directory")` in handlers.

## Decisions
- **`passwordChangeRequired` is a 4th field in `authSlice`.** It's set from `user.mustChangePassword` and from 403 `PASSWORD_CHANGE_REQUIRED`, so the guard reacts to both.
- **`status` stays `authenticated` during a mid-session refresh.** Only the boot refresh shows `restoring`, so pages never unmount for a token refresh.
- **Only a server refusal logs out.** A refresh the server refuses (401, CSRF failure, 409 after the retry, malformed body) dispatches `loggedOut` but does **not** broadcast, because the other tabs share the cookie and will find out on their own refresh. An explicit `logout()` does broadcast. Network errors and 5xx keep the session (`isOffline`) and retry on `online`; 5xx is grouped with network errors because a down server or proxy is not a reason to sign anyone out.
- **Known limitation, offline logout.** A `logout()` while offline clears this browser's memory, but the server never revoked the refresh cookie (`serverConfirmed: false`), so a later reload restores the session. T1's UI should tell the user to log out again once online, or T9 can queue the logout.
- **The shared refresh uses a detached abort signal**, so unmounting the component that triggered it never aborts the refresh for everyone else.
- **Boot runs outside React** (`bootstrapApp` in `main.tsx`), so StrictMode can't run it twice. If something unexpected goes wrong, the session is cleared and the error goes to `reportError`; the app is never stuck in `restoring`.
- **`VITE_API_BASE_URL`** must be a same-origin path or an absolute `http(s)` URL without credentials, query or hash. It is resolved against `window.location.origin`.
- **Feature routes are `{ public, session, member, admin }` objects.** The router owns the guard tree, so features never import the guards.
- **AppLayout imports `shared/ui` primitives by file, not through the barrel.** This keeps unused primitives' CSS out of the initial chunk.
- **The legacy demo key is removed by `bootstrapApp`.** Nothing else in the app uses web storage for auth.
- **`src/data/cuencada2026.ts` is kept.** `HomePage` and `CuencadaYearPage` still use it. There's a `TODO(T2)` at each import.

### Changes outside my folders
- **`apps/web/test/setup.ts` (WP-0.1) was edited.** I added a `Request` subclass that drops the abort signal. jsdom's `AbortSignal` fails Node undici's brand check, and RTK Query always passes a signal. Without this, every `fetchBaseQuery` call in jsdom throws `Expected signal to be an instance of AbortSignal`. The cost is that tests can't exercise aborting an in-flight fetch; nothing currently needs that.
- **`shared/ui/**` and `shared/styles/**`:** no edits.
- **WP-0.7 test setup reconciliation:** the WP-0.7 UI tests keep their `// @vitest-environment jsdom` docblock and their `import "./testing"`. Both are redundant but harmless under the root `web` project (jsdom + `test/setup.ts`), and all 32 pass there. I left them alone because `shared/ui/**` is off-limits. WP-0.7 can drop them, and `shared/ui/testing.ts`, in a follow-up.

## Verification (2026-10-06)
- `pnpm lint`: biome, 0 diagnostics.
- `pnpm typecheck`: 4/4 tasks succeed.
- `pnpm vitest run --project web`: 16 files, 115 tests pass. That's 83 new tests plus the 32 WP-0.7 tests.
- `pnpm build`: succeeds. The initial JS chunk is **511.6 kB raw / 164.1 kB gzip**, under the 200 KB budget. All pages are split into chunks of 0.2–1.5 KB gzip. CSS is 6.4 KB gzip. `/_ui` (StyleGuide) is absent from the production build.
- Approximate breakdown of the initial chunk, from a one-off `manualChunks` build (gzip):

  | Part | Size |
  |---|---|
  | react-dom + react-router | ≈96 KB |
  | Redux Toolkit + RTK Query | ≈28 KB |
  | zod (for `apiErrorSchema` / `refreshResponseSchema`) | ≈25 KB |
  | app code | ≈8.5 KB |
  | `@cuencada/types` | ≈2.5 KB |
  | other | ≈5 KB |

## Open questions (→ orchestrator)
1. **Zod is about 25 KB gzip of the initial chunk.** It's only there to validate error and refresh bodies. That's acceptable today, but if the budget gets tight, the auth path could use hand-written guards and lazy-load zod with the forms.
2. **Coordination board status row.** I didn't edit `docs/coordination/README.md`, to avoid conflicts with the other WPs. Please mark 0.6 as in review.

### Answered
- **Offline refresh (orchestrator):** a network error must not log out. Implemented as above (`isOffline` plus a retry on `online`), with tests for both the network-error case and the 401 case.
- **Dev Origin through the Vite proxy:** noted for WP-0.4 (dev origin allowlist).
- **Duplicate countdown helpers:** T2 standardizes on `computeCountdown`. Both stay for now.
- **`/perfil/sesiones`:** stays in the auth feature (T1).

## Review log
- (pending TL + Security review)
