import { render } from "@testing-library/react";
import { createMemoryRouter, matchRoutes, RouterProvider } from "react-router-dom";
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

/**
 * Loads the lazy route modules (pages, their CSS and imports) that `paths`
 * match, so the first test of a file does not pay Vite's cold transform
 * inside its `findBy*` timeout. Call it from `beforeAll` (with a generous
 * hook timeout) in files whose first test renders a lazy page.
 *
 * @param paths - App paths, e.g. `"/cuencada/2026"`.
 */
export async function warmRoutes(...paths: string[]): Promise<void> {
  const loads: Array<Promise<unknown>> = [];
  for (const path of paths) {
    for (const match of matchRoutes(appRoutes, path) ?? []) {
      const { lazy } = match.route;
      if (typeof lazy === "function") loads.push(lazy());
    }
  }
  await Promise.all(loads);
}
