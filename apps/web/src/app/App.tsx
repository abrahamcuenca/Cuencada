import { type ReactNode, useState } from "react";
import { RouterProvider } from "react-router-dom";
import { AppProviders } from "./providers";
import { createAppRouter } from "./router";
import type { AppStore } from "./store";

/** Props of {@link App}. */
export interface AppProps {
  store: AppStore;
}

/** Root component: providers plus the lazy data router. */
export function App({ store }: AppProps): ReactNode {
  const [router] = useState(createAppRouter);
  return (
    <AppProviders store={store}>
      <RouterProvider router={router} />
    </AppProviders>
  );
}
