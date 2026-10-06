/**
 * Renders a T3 component in isolation (store, toasts, router), for tests.
 */
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { AppProviders } from "../../../app/providers";
import { type AppStore, makeStore, type RootState } from "../../../app/store";

/**
 * @param ui - The component under test.
 * @param state - Preloaded state (usually `authenticatedState(...)`).
 * @returns The isolated store.
 */
export function renderWithStore(ui: ReactNode, state: Partial<RootState>): AppStore {
  const store = makeStore(state);
  render(
    <AppProviders store={store}>
      <MemoryRouter>{ui}</MemoryRouter>
    </AppProviders>
  );
  return store;
}
