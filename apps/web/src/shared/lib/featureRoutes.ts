import type { RouteObject } from "react-router-dom";

/**
 * Routes a feature contributes, grouped by access level. `app/router.tsx`
 * mounts each group under the matching guard, so a feature never imports the
 * guards or edits the router.
 *
 * Access levels mirror the API's (see docs/coordination/WP-0.2.md); in the
 * browser they are **UX only**, the server enforces them:
 * - `public`: anyone (P).
 * - `session`: logged in, allowed while `mustChangePassword` is set (U*).
 * - `member`: logged in and password already changed (U).
 * - `admin`: admin role (A).
 *
 * Every route must be lazy (`lazy: async () => ({ Component })`) so its code
 * stays out of the initial bundle. Paths are absolute and in Spanish.
 */
export interface FeatureRoutes {
  public?: RouteObject[];
  session?: RouteObject[];
  member?: RouteObject[];
  admin?: RouteObject[];
}

/**
 * Route `handle` that asks the app layout for minimal chrome: no BottomNav
 * under 900px (wireframes §3, auth screens). Set it on a route object:
 * `{ path: "/entrar", handle: MINIMAL_CHROME, lazy }`.
 */
export const MINIMAL_CHROME = { chrome: "minimal" } as const;

/**
 * @param handle - A route match's `handle` (unknown by design).
 * @returns Whether the route asked for minimal chrome.
 */
export function wantsMinimalChrome(handle: unknown): boolean {
  return typeof handle === "object" && handle !== null && "chrome" in handle && handle.chrome === MINIMAL_CHROME.chrome;
}
