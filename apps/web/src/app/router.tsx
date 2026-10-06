/**
 * App router (Phase 0 owned; frozen). Composes every feature's
 * {@link FeatureRoutes} under the matching guard. Phase-1 tracks add routes
 * in `features/<f>/routes.tsx` only. See docs/coordination/WP-0.6.md.
 */
import { createBrowserRouter, type RouteObject } from "react-router-dom";
import { adminRoutes } from "../features/admin/routes";
import { RequireAdmin, RequireAuth, RequirePasswordChanged } from "../features/auth/guards";
import { authRoutes } from "../features/auth/routes";
import { chatRoutes } from "../features/chat/routes";
import { cuencadasRoutes } from "../features/cuencadas/routes";
import { directoryRoutes } from "../features/directory/routes";
import { familyRoutes } from "../features/family/routes";
import { galleryRoutes } from "../features/gallery/routes";
import { profileRoutes } from "../features/profile/routes";
import { pwaRoutes } from "../features/pwa/routes";
import { rsvpRoutes } from "../features/rsvp/routes";
import type { FeatureRoutes } from "../shared/lib/featureRoutes";
import { AppLayout } from "./AppLayout";
import { NotFoundPage, RouteErrorPage, RouteSpinner } from "./fallbacks";

/** Every feature's routes, in one place. Order does not matter: React Router ranks paths. */
export const featureRoutes: readonly FeatureRoutes[] = [
  authRoutes,
  cuencadasRoutes,
  rsvpRoutes,
  galleryRoutes,
  profileRoutes,
  directoryRoutes,
  familyRoutes,
  chatRoutes,
  adminRoutes,
  pwaRoutes
];

function collect(level: keyof FeatureRoutes): RouteObject[] {
  return featureRoutes.flatMap((feature) => feature[level] ?? []);
}

// Dev-only living style guide (WP-0.7). Statically dropped from production builds.
const devRoutes: RouteObject[] = import.meta.env.DEV
  ? [{ path: "/_ui", lazy: async () => ({ Component: (await import("../shared/ui/StyleGuide")).StyleGuide }) }]
  : [];

/**
 * The full route tree:
 * `AppLayout` > public | RequireAuth > (session | RequirePasswordChanged > (member | RequireAdmin > admin)).
 *
 * Exported for tests (`createMemoryRouter(appRoutes)`).
 */
export const appRoutes: RouteObject[] = [
  {
    Component: AppLayout,
    ErrorBoundary: RouteErrorPage,
    HydrateFallback: RouteSpinner,
    children: [
      ...collect("public"),
      ...devRoutes,
      {
        Component: RequireAuth,
        children: [
          ...collect("session"),
          // App-owned mobile "Más" menu (session level: reachable during a forced password change).
          { path: "/mas", lazy: async () => ({ Component: (await import("./MorePage")).MorePage }) },
          {
            Component: RequirePasswordChanged,
            children: [...collect("member"), { Component: RequireAdmin, children: collect("admin") }]
          }
        ]
      },
      { path: "*", Component: NotFoundPage }
    ]
  }
];

/**
 * Creates the browser router. Called once by `App`.
 *
 * @returns A data router over {@link appRoutes}.
 */
export function createAppRouter(): ReturnType<typeof createBrowserRouter> {
  return createBrowserRouter(appRoutes);
}
