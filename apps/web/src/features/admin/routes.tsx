import type { FeatureRoutes } from "../../shared/lib/featureRoutes";

/**
 * Admin console routes, owned by T8. Every page is lazy-loaded.
 *
 * `/admin` is a layout route (section nav + `Outlet`) with the T8 pages as
 * children. Other tracks' absolute admin paths (`/admin/cuencadas*`,
 * `/admin/media`, `/admin/familia*`) are more specific than this `*` child,
 * so React Router ranks them first; they render without this layout and
 * link back to `/admin`.
 */
export const adminRoutes: FeatureRoutes = {
  admin: [
    {
      path: "/admin",
      lazy: async () => ({ Component: (await import("./components/AdminLayout")).AdminLayout }),
      children: [
        { index: true, lazy: async () => ({ Component: (await import("./pages/DashboardPage")).DashboardPage }) },
        { path: "invitaciones", lazy: async () => ({ Component: (await import("./pages/InvitesPage")).InvitesPage }) },
        { path: "usuarios", lazy: async () => ({ Component: (await import("./pages/UsersPage")).UsersPage }) },
        { path: "bitacora", lazy: async () => ({ Component: (await import("./pages/AuditLogPage")).AuditLogPage }) },
        { path: "*", lazy: async () => ({ Component: (await import("./pages/AdminNotFoundPage")).AdminNotFoundPage }) }
      ]
    }
  ]
};
