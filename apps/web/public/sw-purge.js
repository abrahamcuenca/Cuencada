/*
 * Imported by the generated service worker (vite-plugin-pwa `importScripts`).
 * Deletes the runtime caches when a page reports a logout or a user switch
 * (apps/web/src/features/pwa/purge.ts). The precache (app shell) is kept.
 * Keep RUNTIME_CACHES in sync with RUNTIME_CACHE_NAMES in
 * apps/web/src/features/pwa/swRules.ts (checked by apps/web/scripts/check-sw.mjs).
 */
const RUNTIME_CACHES = ["cuencada-public-api"];

self.addEventListener("message", (event) => {
  // Only our own pages may ask (messages from our clients carry our origin).
  if (event.origin !== "" && event.origin !== self.location.origin) return;
  const data = event.data;
  if (data === null || typeof data !== "object" || data.type !== "cuencada:purge-runtime-caches") return;
  event.waitUntil(Promise.all(RUNTIME_CACHES.map((name) => caches.delete(name))));
});
