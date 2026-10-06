/**
 * The only place that registers the service worker [SEC]: from our own
 * bundled module via `workbox-window`, never an injected inline script
 * (`injectRegister: null`), so the CSP keeps `script-src 'self'` with no
 * hashes or `unsafe-inline`.
 *
 * Prompt mode: a new worker waits until the user taps "Recargar ahora"; then
 * it gets `SKIP_WAITING`, takes control, and the page reloads once.
 */
import type { Workbox } from "workbox-window";

/** The generated worker (vite-plugin-pwa `generateSW`). */
export const SW_URL = "/sw.js";
/** How often an open tab asks the server for a newer `sw.js`. */
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** Callbacks for {@link registerServiceWorker}. */
export interface ServiceWorkerCallbacks {
  /** A new version is waiting. `applyUpdate` activates it; the page reloads when it takes control. */
  onNeedRefresh: (applyUpdate: () => Promise<void>) => void;
  /** Registration or an update check failed. */
  onError: (error: unknown) => void;
}

/** Test seams for {@link registerServiceWorker}. */
export interface RegisterOptions {
  /** Register at all. Defaults to production builds only: dev has no `sw.js`. */
  enabled?: boolean;
  /** Creates the Workbox instance (tests inject a fake). */
  createWorkbox?: (url: string) => Promise<Pick<Workbox, "addEventListener" | "messageSkipWaiting" | "register" | "update">>;
  /** Reloads the page (tests inject a spy). */
  reload?: () => void;
}

async function defaultCreateWorkbox(url: string): Promise<Workbox> {
  const { Workbox: WorkboxClass } = await import("workbox-window");
  return new WorkboxClass(url, { scope: "/" });
}

/**
 * Registers {@link SW_URL} and checks for updates hourly while online.
 * No-op outside production builds and where service workers are unavailable.
 *
 * @param callbacks - Update and error hooks.
 * @param options - Test seams.
 * @returns Resolves once registration was attempted.
 */
export async function registerServiceWorker(callbacks: ServiceWorkerCallbacks, options: RegisterOptions = {}): Promise<void> {
  const { enabled = import.meta.env.PROD, createWorkbox = defaultCreateWorkbox, reload = () => window.location.reload() } = options;
  if (!enabled || !("serviceWorker" in navigator)) return;

  const wb = await createWorkbox(SW_URL);
  let reloading = false;

  const applyUpdate = async (): Promise<void> => {
    wb.addEventListener("controlling", () => {
      // Once only, even if `controlling` fires twice.
      if (reloading) return;
      reloading = true;
      reload();
    });
    wb.messageSkipWaiting();
  };

  // `waiting` covers both a new version found while open and one that was already waiting at load.
  wb.addEventListener("waiting", () => callbacks.onNeedRefresh(applyUpdate));

  try {
    await wb.register();
  } catch (error) {
    callbacks.onError(error);
    return;
  }
  setInterval(() => {
    if (navigator.onLine) wb.update().catch(callbacks.onError);
  }, UPDATE_CHECK_INTERVAL_MS);
}
