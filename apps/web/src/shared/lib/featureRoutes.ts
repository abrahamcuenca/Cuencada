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
