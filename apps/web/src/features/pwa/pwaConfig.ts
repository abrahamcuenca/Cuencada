/**
 * `vite-plugin-pwa` options (T9). Imported by `apps/web/vite.config.ts`; kept
 * here so the manifest and caching policy are unit-tested with the rules.
 * See `swRules.ts` for the security policy.
 */
import type { VitePWAOptions } from "vite-plugin-pwa";
import {
  isPublicCuencadaRead,
  NAVIGATE_FALLBACK_DENYLIST,
  PRECACHE_GLOBS,
  PRECACHE_IGNORES,
  PUBLIC_API_CACHE,
  publicApiSourcePlugin
} from "./swRules";

/** Seconds NetworkFirst waits for the network before answering from the cache (spotty trip coverage). */
export const PUBLIC_API_NETWORK_TIMEOUT_S = 6;

/** Web app manifest (WP-0.7 icons and colours). */
export const manifest = {
  id: "/",
  name: "Cuencada",
  short_name: "Cuencada",
  description: "Portal oficial de la Familia Cuenca y las Cuencadas.",
  lang: "es-MX",
  dir: "ltr",
  start_url: "/",
  scope: "/",
  display: "standalone",
  orientation: "portrait",
  theme_color: "#0b5e55",
  background_color: "#fffaf0",
  icons: [
    { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/icons/maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
    { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
  ]
} satisfies Partial<VitePWAOptions["manifest"]>;

/**
 * Plugin options: `generateSW` + `registerType: 'prompt'`, registered by our
 * own module (`registerServiceWorker.ts`), never by an injected inline script
 * (`injectRegister: null`), so the strict `script-src 'self'` CSP holds.
 */
export const pwaOptions = {
  strategies: "generateSW",
  registerType: "prompt",
  injectRegister: null,
  // Dev keeps no service worker: HMR and the /api proxy stay untouched.
  devOptions: { enabled: false },
  includeAssets: [],
  // Icons are already matched by PRECACHE_GLOBS.
  includeManifestIcons: false,
  manifest,
  workbox: {
    globPatterns: PRECACHE_GLOBS,
    globIgnores: PRECACHE_IGNORES,
    // Prompt mode: the new worker waits for "Actualizar" (SKIP_WAITING message).
    skipWaiting: false,
    // First install controls the open tab at once (there is no older worker to replace).
    clientsClaim: true,
    cleanupOutdatedCaches: true,
    navigateFallback: "index.html",
    navigateFallbackDenylist: NAVIGATE_FALLBACK_DENYLIST,
    // Logout / user-switch purge handler (static file in public/, same origin).
    importScripts: ["/sw-purge.js"],
    runtimeCaching: [
      {
        urlPattern: isPublicCuencadaRead,
        handler: "NetworkFirst",
        method: "GET",
        options: {
          cacheName: PUBLIC_API_CACHE,
          networkTimeoutSeconds: PUBLIC_API_NETWORK_TIMEOUT_S,
          cacheableResponse: { statuses: [200] },
          expiration: { maxEntries: 12, maxAgeSeconds: 60 * 60 * 24 * 30 },
          plugins: [publicApiSourcePlugin]
        }
      }
    ]
  }
} satisfies Partial<VitePWAOptions>;
