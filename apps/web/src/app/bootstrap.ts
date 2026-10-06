import { setupListeners } from "@reduxjs/toolkit/query";
import { startAuthSync } from "../features/auth/authSync";
import { removeLegacyDemoSession } from "../features/auth/legacy";
import { restoreSession } from "../features/auth/session";
import { readAndScrubFragmentToken } from "../shared/lib/fragmentToken";
import { reportUnexpected } from "../shared/lib/reportUnexpected";
import type { AppStore } from "./store";

/**
 * One-time app start-up, run before the router is created and before the
 * first render:
 * 1. scrub a `#t=…` fragment token from the address bar and history, keeping
 *    it in memory for its page [SEC]. Doing it here (not in the lazy page)
 *    means a failed chunk load or a 404 never leaves the token in the URL,
 *    and the router never sees the fragment;
 * 2. delete the scaffold's fake `cuencada-demo-user` localStorage entry;
 * 3. listen for logouts from other tabs;
 * 4. wire RTK Query's focus/online listeners (`refetchOnReconnect`);
 * 5. finish an unconfirmed logout, or start the silent `POST /auth/refresh`.
 *
 * Runs outside React so StrictMode's double effects cannot start it twice.
 * Unexpected failures go to {@link reportUnexpected}; the session is already
 * cleared by then, so the app keeps working as anonymous.
 *
 * @param store - The app store.
 * @returns A function that stops the listeners (tests, HMR).
 */
export function bootstrapApp(store: AppStore): () => void {
  readAndScrubFragmentToken();
  removeLegacyDemoSession();
  const stopAuthSync = startAuthSync(store.dispatch);
  const stopRtkListeners = setupListeners(store.dispatch);
  store.dispatch(restoreSession()).catch(reportUnexpected);
  return () => {
    stopAuthSync();
    stopRtkListeners();
  };
}
