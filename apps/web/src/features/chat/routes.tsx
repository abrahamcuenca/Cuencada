import type { FeatureRoutes } from "../../shared/lib/featureRoutes";

/** Chat routes, owned by T7. Every page is lazy-loaded. */
export const chatRoutes: FeatureRoutes = {
  member: [
    { path: "/chat/:roomId?", lazy: async () => ({ Component: (await import("./pages/ChatPage")).ChatPage }) }
  ]
};
