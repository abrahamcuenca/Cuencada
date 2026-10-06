/**
 * Starts the PWA runtime for the page: registers the service worker (once per
 * page) and, while mounted, purges the runtime caches on every logout or
 * account switch. The early page listeners live in `pwaListeners.ts`.
 */
import { reportUnexpected } from "../../shared/lib/reportUnexpected";
import { updatePwaState } from "./pwaState";
import { type AuthStoreLike, purgeRuntimeCaches, watchSessionEpoch } from "./purge";
import { registerServiceWorker } from "./registerServiceWorker";

let registered = false;

/**
 * Wires the PWA runtime to the app store.
 *
 * @param store - The app store (its `auth.sessionEpoch` drives the purge).
 * @returns Cleanup for the epoch watch (the registration itself stays).
 */
export function startPwa(store: AuthStoreLike): () => void {
  if (!registered) {
    registered = true;
    registerServiceWorker({
      onNeedRefresh: (applyUpdate) => updatePwaState({ applyUpdate }),
      onError: reportUnexpected
    }).catch(reportUnexpected);
  }

  return watchSessionEpoch(store, () => {
    updatePwaState({ publicApiSource: null });
    purgeRuntimeCaches().catch(reportUnexpected);
  });
}
