import type { ReactNode } from "react";
import { Provider } from "react-redux";
import { ToastProvider } from "../shared/ui/Toast";
import type { AppStore } from "./store";

/** Props of {@link AppProviders}. */
export interface AppProvidersProps {
  store: AppStore;
  children: ReactNode;
}

/**
 * App-wide context: Redux store and toasts. Tests render pages inside this
 * with their own `makeStore()`.
 */
export function AppProviders({ store, children }: AppProvidersProps): ReactNode {
  return (
    <Provider store={store}>
      <ToastProvider>{children}</ToastProvider>
    </Provider>
  );
}
