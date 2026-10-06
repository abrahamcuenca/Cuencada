/**
 * Runtime-cache purge on logout and user switch [SEC].
 *
 * The runtime cache only ever holds public, PII-free Cuencada reads, but a
 * shared device must not keep anything the previous session fetched. Both
 * sides act, so the purge happens even when the page has no controlling
 * worker yet or the worker is being replaced:
 * - the page deletes the caches itself (CacheStorage is per origin);
 * - the active service worker gets {@link SW_PURGE_MESSAGE} (`public/sw-purge.js`).
 * The precache (app shell, no user data) is kept so the app still opens offline.
 */
import type { AuthState } from "../auth/authSlice";
import { RUNTIME_CACHE_NAMES, SW_PURGE_MESSAGE } from "./swRules";

/**
 * Deletes every runtime cache and asks the service worker to do the same.
 * Safe where `caches` or service workers are unavailable.
 *
 * @returns Resolves once the page-side deletes finished.
 */
export async function purgeRuntimeCaches(): Promise<void> {
  if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
    const message = { type: SW_PURGE_MESSAGE };
    navigator.serviceWorker.controller?.postMessage(message);
    const registration = await navigator.serviceWorker.getRegistration();
    // The active worker may not control this tab yet (first visit before clientsClaim settles).
    if (registration?.active && registration.active !== navigator.serviceWorker.controller) {
      registration.active.postMessage(message);
    }
  }
  if (typeof caches === "undefined") return;
  await Promise.all(RUNTIME_CACHE_NAMES.map((name) => caches.delete(name)));
}

/** The store surface {@link watchSessionEpoch} needs (keeps tests store-agnostic). */
export interface AuthStoreLike {
  getState: () => { auth: Pick<AuthState, "sessionEpoch"> };
  subscribe: (listener: () => void) => () => void;
}

/**
 * Calls `onChange` whenever `auth.sessionEpoch` moves: every `loggedOut`
 * (this tab, another tab's broadcast, a refused refresh) and every account
 * switch A → B (see `authSlice`).
 *
 * @param store - The app store.
 * @param onChange - Called once per epoch change.
 * @returns Unsubscribe.
 */
export function watchSessionEpoch(store: AuthStoreLike, onChange: () => void): () => void {
  let epoch = store.getState().auth.sessionEpoch;
  return store.subscribe(() => {
    const next = store.getState().auth.sessionEpoch;
    if (next === epoch) return;
    epoch = next;
    onChange();
  });
}
