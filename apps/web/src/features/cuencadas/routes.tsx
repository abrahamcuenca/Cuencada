import type { FeatureRoutes } from "../../shared/lib/featureRoutes";

/** Cuencadas routes, owned by T2. Every page is lazy-loaded. */
export const cuencadasRoutes: FeatureRoutes = {
  public: [
    { path: "/", lazy: async () => ({ Component: (await import("./pages/HomePage")).HomePage }) },
    { path: "/cuencada/:year", lazy: async () => ({ Component: (await import("./pages/CuencadaYearPage")).CuencadaYearPage }) }
  ]
};
