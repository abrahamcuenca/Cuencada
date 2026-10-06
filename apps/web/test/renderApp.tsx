import { render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { AppProviders } from "../src/app/providers";
import { appRoutes } from "../src/app/router";
import { type AppStore, makeStore, type RootState } from "../src/app/store";

/** What {@link renderApp} returns. */
export interface RenderAppResult {
  store: AppStore;
  router: ReturnType<typeof createMemoryRouter>;
}

/**
 * Renders the real route tree (guards, layout, lazy pages) at `path` with an
 * isolated store. No boot refresh runs: preload the auth state you need.
 */
export function renderApp(path: string, preloadedState?: Partial<RootState>): RenderAppResult {
  const store = makeStore(preloadedState);
  const router = createMemoryRouter(appRoutes, { initialEntries: [path] });
  render(
    <AppProviders store={store}>
      <RouterProvider router={router} />
    </AppProviders>
  );
  return { store, router };
}
