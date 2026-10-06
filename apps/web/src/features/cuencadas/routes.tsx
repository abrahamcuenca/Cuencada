import type { FeatureRoutes } from "../../shared/lib/featureRoutes";

/**
 * Cuencadas routes, owned by T2. Every page is lazy-loaded.
 *
 * The admin screens use absolute paths under `/admin/cuencadas`. React Router
 * ranks them above the admin feature's `/admin/*` catch-all, so they mount
 * inside the same `RequireAdmin` guard without editing the admin feature.
 */
export const cuencadasRoutes: FeatureRoutes = {
  public: [
    { path: "/", lazy: async () => ({ Component: (await import("./pages/HomePage")).HomePage }) },
    { path: "/cuencada/:year", lazy: async () => ({ Component: (await import("./pages/CuencadaYearPage")).CuencadaYearPage }) }
  ],
  admin: [
    {
      path: "/admin/cuencadas",
      lazy: async () => ({ Component: (await import("./admin/pages/AdminCuencadasPage")).AdminCuencadasPage })
    },
    {
      path: "/admin/cuencadas/:id",
      lazy: async () => ({ Component: (await import("./admin/pages/AdminCuencadaEditPage")).AdminCuencadaEditPage })
    }
  ]
};
