import type { FeatureRoutes } from "../../shared/lib/featureRoutes";

/**
 * RSVP and attendance routes, owned by T3. The member UI lives in the
 * Cuencada page slots; only the admin screen is a route. Its absolute path is
 * more specific than T2's `/admin/cuencadas/:id` and T8's `/admin/*`, so
 * React Router ranks it first inside the same `RequireAdmin` guard.
 */
export const rsvpRoutes: FeatureRoutes = {
  admin: [
    {
      path: "/admin/cuencadas/:id/asistencia",
      lazy: async () => ({ Component: (await import("./admin/AdminAttendancePage")).AdminAttendancePage })
    }
  ]
};
