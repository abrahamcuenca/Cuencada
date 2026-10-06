/**
 * Service worker caching rules [SEC], shared by `vite.config.ts` (which hands
 * them to Workbox `generateSW`) and the unit tests.
 *
 * Policy (docs/plan.md → PWA, docs/coordination/WP-T9.md):
 * - Precache: the app shell (HTML, JS, CSS) and small static assets (icons,
 *   webp images, the manifest). Never the 4 MB song, never `/api`.
 * - Runtime, NetworkFirst: only the public, PII-free `GET /api/cuencadas`
 *   (edition list), `GET /api/cuencadas/home` and `GET /api/cuencadas/:year`
 *   (no query string), so the programa still works offline on the trip.
 *   Never `/members` or any other API route.
 * - Everything else is **not routed** by the service worker, so the browser
 *   handles it natively (network only, no SW cache): every other `/api/**`
 *   route (including all of `/api/chat/*`: the ticket POST and the
 *   `/api/chat/ws` WebSocket), presigned S3 URLs and any other cross-origin
 *   request (weather widget iframe, Google Maps), and `/canciones/*`.
 *
 * IMPORTANT: Workbox serializes the matcher and plugin functions with
 * `Function.prototype.toString()` into `sw.js`. They must be **self-contained**:
 * no imports, no references to module-level constants, no helpers. The tests
 * call them directly and `scripts/check-sw.mjs` re-runs the copies inside the
 * built `sw.js`.
 */

/** Cache name of the only runtime cache (public Cuencada reads). Keep in sync with `public/sw-purge.js`. */
export const PUBLIC_API_CACHE = "cuencada-public-api";

/** Every runtime cache the app creates; purged on logout / user switch. Precache is not included. */
export const RUNTIME_CACHE_NAMES: readonly string[] = [PUBLIC_API_CACHE];

/** Message the page sends to the service worker to delete {@link RUNTIME_CACHE_NAMES}. */
export const SW_PURGE_MESSAGE = "cuencada:purge-runtime-caches";

/** Message the service worker sends to a page after answering a public read. */
export const SW_SOURCE_MESSAGE = "cuencada:public-api-source";

/** Where the last public Cuencada read came from. */
export type PublicApiSource = "cache" | "network";

/** The subset of Workbox's `RouteMatchCallbackOptions` the matchers read. */
export interface RouteMatchInput {
  url: URL;
  request: Pick<Request, "method">;
  sameOrigin: boolean;
}

/**
 * Matches the public, PII-free Cuencada reads cached NetworkFirst:
 * `GET /api/cuencadas` (edition list), `GET /api/cuencadas/home` and
 * `GET /api/cuencadas/{4-digit year}` on our own origin, exactly, without a
 * query string or trailing slash. `/api/cuencadas/:year/members` (member
 * links) and every other API route never match.
 *
 * Self-contained: serialized into `sw.js`.
 *
 * @param input - Workbox match callback options.
 * @returns Whether the request may use the public API cache.
 */
export const isPublicCuencadaRead = (options: RouteMatchInput): boolean =>
  // No destructured parameters: the production sw.js build (babel + terser) mangled them away
  // and left the matcher reading the wrong variables. scripts/check-sw.mjs guards this.
  options.sameOrigin === true &&
  options.request.method === "GET" &&
  options.url.search === "" &&
  /^\/api\/cuencadas(?:\/(?:home|\d{4}))?$/.test(options.url.pathname);

/**
 * Navigations the SPA fallback (`index.html`) must never answer. Workbox tests
 * these against `pathname + search`:
 * - the API: a navigation to `/api/...` must reach the server, never get the shell;
 * - any URL carrying a `ticket=` parameter (chat WebSocket tickets): it goes to
 *   the network untouched. (WebSocket upgrades such as `/api/chat/ws` never
 *   reach a service worker `fetch` handler anyway.);
 * - real files: `/canciones/`, `/images/`, `/icons/`, and any path whose last
 *   segment has a file extension (`/sw.js`, `/foo.webmanifest`): a missing
 *   file must 404 from the server, never come back as the HTML shell.
 */
export const NAVIGATE_FALLBACK_DENYLIST: RegExp[] = [
  /^\/api(?:\/|$)/,
  /[?&]ticket=/,
  /^\/canciones\//,
  /^\/images\//,
  /^\/icons\//,
  /\/[^/?]+\.[a-z0-9]{2,12}(?:\?|$)/i
];

/** Precache globs (relative to `dist`). Audio, video, JPEG photos and the VTT are left out on purpose. */
export const PRECACHE_GLOBS: string[] = ["**/*.{js,css,html,svg,png,webp,ico,webmanifest}"];

/** Never precached, even if a glob above would match. */
export const PRECACHE_IGNORES: string[] = ["**/canciones/**", "**/api/**", "**/*.map"];

/** The bits of Workbox's plugin callback arguments {@link publicApiSourcePlugin} reads. */
export interface PluginEventInput {
  event?: { clientId?: string } | undefined;
}

/** `cachedResponseWillBeUsed` arguments read by the plugin. */
export interface CachedResponseInput extends PluginEventInput {
  cachedResponse?: Response | undefined;
}

/** `fetchDidSucceed` arguments read by the plugin. */
export interface FetchDidSucceedInput extends PluginEventInput {
  response: Response;
}

/**
 * Workbox plugin for the public API route: tells the requesting page whether
 * the answer came from the cache (offline / timeout) or the network, so it
 * can show "Sin conexión — mostrando la última versión guardada". Only the
 * page that made the request is told (`event.clientId`); the message carries
 * no data, just the source.
 *
 * Self-contained: serialized into `sw.js`, where `self` is the
 * `ServiceWorkerGlobalScope`.
 */
export const publicApiSourcePlugin = {
  cachedResponseWillBeUsed: async ({ cachedResponse, event }: CachedResponseInput): Promise<Response | undefined> => {
    const clientId = event?.clientId;
    if (cachedResponse !== undefined && cachedResponse !== null && typeof clientId === "string" && clientId !== "") {
      // Runs in the service worker, where `self` is a ServiceWorkerGlobalScope (it has `clients`).
      const scope = self as unknown as {
        clients: { get: (id: string) => Promise<{ postMessage: (message: unknown) => void } | undefined> };
      };
      const client = await scope.clients.get(clientId);
      client?.postMessage({ type: "cuencada:public-api-source", source: "cache" });
    }
    return cachedResponse;
  },
  fetchDidSucceed: async ({ response, event }: FetchDidSucceedInput): Promise<Response> => {
    const clientId = event?.clientId;
    if (response.ok && typeof clientId === "string" && clientId !== "") {
      // Runs in the service worker, where `self` is a ServiceWorkerGlobalScope (it has `clients`).
      const scope = self as unknown as {
        clients: { get: (id: string) => Promise<{ postMessage: (message: unknown) => void } | undefined> };
      };
      const client = await scope.clients.get(clientId);
      client?.postMessage({ type: "cuencada:public-api-source", source: "network" });
    }
    return response;
  }
};
