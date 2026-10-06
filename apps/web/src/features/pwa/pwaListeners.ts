/**
 * Page-level PWA listeners, installed when the initial chunk evaluates
 * (from `PwaStatusMount`), before React renders and before the first API
 * request. Both events can fire before the lazy `PwaStatus` chunk loads:
 * - the service worker's "answered from cache" message for the very first
 *   public read (the client message queue opens at DOMContentLoaded, and a
 *   message with no listener yet is dropped);
 * - Chromium's one-shot `beforeinstallprompt`.
 */
import { type BeforeInstallPromptEvent, updatePwaState } from "./pwaState";
import { type PublicApiSource, SW_SOURCE_MESSAGE } from "./swRules";

/**
 * Validates a message from the service worker.
 *
 * @param data - `MessageEvent.data`.
 * @returns The public API source it reports, or `null` for anything else.
 */
export function parseSourceMessage(data: unknown): PublicApiSource | null {
  if (typeof data !== "object" || data === null) return null;
  const { type, source } = data as { type?: unknown; source?: unknown }; // Narrowed field by field below.
  if (type !== SW_SOURCE_MESSAGE) return null;
  return source === "cache" || source === "network" ? source : null;
}

function isBeforeInstallPrompt(event: Event): event is BeforeInstallPromptEvent {
  return "prompt" in event && typeof event.prompt === "function";
}

function onBeforeInstallPrompt(event: Event): void {
  if (!isBeforeInstallPrompt(event)) return;
  // Keep Chrome's mini-infobar away; the "Más" card offers the install instead.
  event.preventDefault();
  updatePwaState({ installPrompt: event });
}

function onAppInstalled(): void {
  updatePwaState({ installPrompt: null });
}

function onWorkerMessage(event: MessageEvent): void {
  // Messages from our own service worker carry our origin.
  if (event.origin !== "" && event.origin !== window.location.origin) return;
  const source = parseSourceMessage(event.data);
  if (source !== null) updatePwaState({ publicApiSource: source });
}

let installed = false;

/**
 * Installs the listeners once per page. Idempotent.
 *
 * @returns Removes them again (tests).
 */
export function installPwaListeners(): () => void {
  const container = typeof navigator !== "undefined" && "serviceWorker" in navigator ? navigator.serviceWorker : null;
  if (!installed && typeof window !== "undefined") {
    installed = true;
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onAppInstalled);
    container?.addEventListener("message", onWorkerMessage);
  }
  return () => {
    installed = false;
    window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.removeEventListener("appinstalled", onAppInstalled);
    container?.removeEventListener("message", onWorkerMessage);
  };
}
