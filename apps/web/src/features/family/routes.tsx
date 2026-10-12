import type { FeatureRoutes } from "../../shared/lib/featureRoutes";

/**
 * Family tree routes, owned by T6. Every page is lazy-loaded.
 * `/admin/familia/*` paths are more specific than T8's `/admin/*`, so React
 * Router ranks them first inside the same `RequireAdmin` guard.
 */
export const familyRoutes: FeatureRoutes = {
  member: [
    {
      // WP-6.4: static segments rank above `:personId`.
      path: "/arbol/completo",
      lazy: async () => ({
        Component: (await import("./oneTree/FullTreePage")).FullTreePage
      })
    },
    {
      path: "/arbol/propuestas",
      lazy: async () => ({
        Component: (await import("./oneTree/MyProposalsPage")).MyProposalsPage
      })
    },
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
      // Static segment: ranks above `:personId`.
      path: "/admin/familia/actividad",
      lazy: async () => ({
        Component: (await import("./admin/pages/FamilyActivityPage")).FamilyActivityPage
      })
    },
    {
      path: "/admin/familia/propuestas",
      lazy: async () => ({
        Component: (await import("./oneTree/admin/TreeProposalsPage")).TreeProposalsPage
      })
    },
    {
      path: "/admin/familia/ramas",
      lazy: async () => ({
        Component: (await import("./oneTree/admin/BranchesPage")).BranchesPage
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
