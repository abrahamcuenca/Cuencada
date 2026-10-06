import { type FeatureRoutes, MINIMAL_CHROME } from "../../shared/lib/featureRoutes";

/** The child routes only carry route state; `ChatPage` renders everything. */
function ChatRouteState(): null {
  return null;
}

/**
 * Chat routes, owned by T7. `/chat` is one lazy page that stays mounted while
 * you move between rooms, so the shared socket is not reopened on every tap.
 * A conversation is full screen on phones (minimal chrome: no BottomNav), so
 * the composer owns the bottom edge (wireframes §8.2).
 */
export const chatRoutes: FeatureRoutes = {
  member: [
    {
      path: "/chat",
      lazy: async () => ({ Component: (await import("./pages/ChatPage")).ChatPage }),
      children: [
        { index: true, Component: ChatRouteState },
        { path: ":roomId", handle: MINIMAL_CHROME, Component: ChatRouteState }
      ]
    }
  ]
};
