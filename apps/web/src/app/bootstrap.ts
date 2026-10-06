import { startAuthSync } from "../features/auth/authSync";
import { removeLegacyDemoSession } from "../features/auth/legacy";
import { restoreSession } from "../features/auth/session";
import type { AppStore } from "./store";

/**
 * One-time app start-up, run before the first render:
 * 1. delete the scaffold's fake `cuencada-demo-user` localStorage entry;
 * 2. listen for logouts from other tabs;
 * 3. start the silent `POST /auth/refresh` (status `restoring`), so guarded
 *    routes show a spinner until the session is known.
 *
 * Runs outside React so StrictMode's double effects cannot start it twice.
 * An unexpected failure is reported through `reportError` (it reaches
 * window `error` listeners and, later, Sentry); the session is already
 * cleared by then, so the app keeps working as anonymous.
 *
 * @param store - The app store.
 * @returns A function that stops the cross-tab listener (tests, HMR).
 */
export function bootstrapApp(store: AppStore): () => void {
  removeLegacyDemoSession();
  const stopAuthSync = startAuthSync(store.dispatch);
  store.dispatch(restoreSession()).catch((error: unknown) => {
    globalThis.reportError(error);
  });
  return stopAuthSync;
}
