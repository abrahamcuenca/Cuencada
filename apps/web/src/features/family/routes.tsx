import type { FeatureRoutes } from "../../shared/lib/featureRoutes";

/**
 * Family tree routes, owned by T6. Every page is lazy-loaded.
 * `/admin/familia/*` paths are more specific than T8's `/admin/*`, so React
 * Router ranks them first inside the same `RequireAdmin` guard.
 */
export const familyRoutes: FeatureRoutes = {
  member: [
    {
      path: "/arbol/:personId?",
      lazy: async () => ({
        Component: (await import("./pages/FamilyTreePage")).FamilyTreePage
      })
    }
  ],
  admin: [
    {
      path: "/admin/familia",
      lazy: async () => ({
        Component: (await import("./admin/pages/AdminFamilyPage")).AdminFamilyPage
      })
    },
    {
      path: "/admin/familia/:personId",
      lazy: async () => ({
        Component: (await import("./admin/pages/AdminPersonPage")).AdminPersonPage
      })
    }
  ]
};
