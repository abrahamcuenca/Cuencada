#!/usr/bin/env node
/**
 * Asserts the caching rules of the *built* service worker [SEC] (T9).
 *
 * Runs `dist/sw.js` (and the `importScripts`'d `dist/sw-purge.js`) in a Node
 * `vm` sandbox with a fake Workbox, then exercises the routes it registered.
 * This tests the code that actually ships: Workbox serializes our matcher
 * functions with `toString()` and minifies them, which has broken them before
 * (destructured parameters were mangled away).
 *
 *   pnpm --filter @cuencada/web build && pnpm --filter @cuencada/web check:sw
 *   node apps/web/scripts/check-sw.mjs [distDir]
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const distDir = resolve(process.argv[2] ?? join(fileURLToPath(new URL(".", import.meta.url)), "..", "dist"));
const ORIGIN = "https://cuencada.com";
const PUBLIC_API_CACHE = "cuencada-public-api";
const PURGE_MESSAGE = "cuencada:purge-runtime-caches";
const SOURCE_MESSAGE = "cuencada:public-api-source";

const failures = [];
/** Records a failed assertion (all checks run; the exit code reports them together). */
function check(condition, message) {
  if (!condition) failures.push(message);
}

function read(file) {
  try {
    return readFileSync(join(distDir, file), "utf8");
  } catch {
    process.stderr.write(`Missing ${join(distDir, file)}. Run "pnpm --filter @cuencada/web build" first.\n`);
    process.exit(2);
  }
}

const swSource = read("sw.js");
const purgeSource = read("sw-purge.js");
const indexHtml = read("index.html");

/* ------------------------------------------------------------------ fake SW */
const routes = [];
const precached = [];
const imported = [];
const listeners = new Map();
const posted = [];
const deletedCaches = [];
let skipWaitingCalls = 0;

class Strategy {
  constructor(options = {}) {
    this.options = options;
  }
}
class NetworkFirst extends Strategy {}
class NavigationRoute {
  constructor(handler, options = {}) {
    this.handler = handler;
    this.options = options;
  }
}
class Plugin {
  constructor(options) {
    this.options = options;
  }
}
const workbox = {
  NetworkFirst,
  NavigationRoute,
  CacheableResponsePlugin: class extends Plugin {},
  ExpirationPlugin: class extends Plugin {},
  clientsClaim() {},
  cleanupOutdatedCaches() {},
  createHandlerBoundToURL: (url) => ({ boundTo: url }),
  precacheAndRoute(entries) {
    precached.push(...entries.map((entry) => (typeof entry === "string" ? entry : entry.url)));
  },
  registerRoute(matcher, handler, method = "GET") {
    routes.push({ matcher, handler, method });
  }
};

const sandbox = {
  location: new URL(`${ORIGIN}/sw.js`),
  addEventListener(type, listener) {
    listeners.set(type, [...(listeners.get(type) ?? []), listener]);
  },
  skipWaiting() {
    skipWaitingCalls += 1;
  },
  clients: {
    async get(id) {
      return { postMessage: (message) => posted.push({ id, message }) };
    }
  },
  caches: {
    async delete(name) {
      deletedCaches.push(name);
      return true;
    }
  },
  importScripts(...urls) {
    for (const url of urls) {
      imported.push(url);
      if (url === "/sw-purge.js") vm.runInContext(purgeSource, context, { filename: "sw-purge.js" });
    }
  },
  define(_deps, factory) {
    factory(workbox);
  },
  URL,
  Promise,
  console
};
sandbox.self = sandbox;
const context = vm.createContext(sandbox);
vm.runInContext(swSource, context, { filename: "sw.js" });

/* -------------------------------------------------------------- precache */
check(precached.includes("index.html"), "index.html must be precached (offline shell).");
check(precached.includes("manifest.webmanifest"), "manifest.webmanifest must be precached.");
check(precached.includes("icons/maskable-512.png"), "maskable icons must be precached.");
check(precached.some((url) => /^assets\/index-.*\.js$/.test(url)), "the entry chunk must be precached.");
for (const url of precached) {
  check(!/canciones\/|\.mp3$|\.mp4$|\.vtt$/.test(url), `media must not be precached: ${url}`);
  check(!/(^|\/)api\//.test(url), `API must never be precached: ${url}`);
  check(!/\.jpe?g$/.test(url), `JPEG photos are not precached: ${url}`);
}

/* ------------------------------------------------------------ navigation */
const navigation = routes.filter((route) => route.matcher instanceof NavigationRoute);
check(navigation.length === 1, `expected 1 NavigationRoute, found ${navigation.length}`);
const nav = navigation[0]?.matcher;
check(nav?.handler?.boundTo === "index.html", "navigation fallback must be index.html");
const denylist = nav?.options?.denylist ?? [];
const denied = (path) => denylist.some((pattern) => pattern.test(path));
for (const path of ["/api", "/api/", "/api/me", "/api/cuencadas/2026", "/api/auth/magic-link", "/api/chat/ws?ticket=abc123", "/api/chat/ticket", "/chat?ticket=abc123"]) {
  check(denied(path), `navigation fallback must not answer ${path}`);
}
for (const path of ["/", "/cuencada/2026", "/entrar", "/galeria", "/apiary"]) {
  check(!denied(path), `navigation fallback should answer ${path}`);
}

/* --------------------------------------------------------- runtime routes */
const runtime = routes.filter((route) => !(route.matcher instanceof NavigationRoute));
check(runtime.length === 1, `expected exactly 1 runtime route (public Cuencada reads), found ${runtime.length}`);
const publicRoute = runtime[0];
check(publicRoute?.method === "GET", "the public route must be GET only");
check(publicRoute?.handler instanceof NetworkFirst, "the public route must be NetworkFirst");
check(publicRoute?.handler?.options?.cacheName === PUBLIC_API_CACHE, `the public route must use cache "${PUBLIC_API_CACHE}"`);
const plugins = publicRoute?.handler?.options?.plugins ?? [];
const cacheable = plugins.find((plugin) => plugin instanceof workbox.CacheableResponsePlugin);
check(JSON.stringify(cacheable?.options?.statuses) === "[200]", "only 200 responses may be cached");
check(plugins.some((plugin) => plugin instanceof workbox.ExpirationPlugin), "the public cache must expire");

function matches(href, { method = "GET" } = {}) {
  const url = new URL(href, ORIGIN);
  return publicRoute?.matcher({ url, request: { method }, sameOrigin: url.origin === ORIGIN, event: {} }) === true;
}
for (const path of ["/api/cuencadas/home", "/api/cuencadas/2026", "/api/cuencadas/1998"]) {
  check(matches(path), `public read must be cached: ${path}`);
}
const neverCached = [
  "/api/cuencadas/2026/members",
  "/api/cuencadas",
  "/api/cuencadas/home?debug=1",
  "/api/cuencadas/20261",
  "/api/me",
  "/api/auth/refresh",
  "/api/announcements",
  "/api/directory",
  "/api/profile",
  "/api/media/2026",
  "/api/chat/messages",
  "/api/chat/ticket",
  "/api/chat/ws?ticket=abc123",
  "wss://cuencada.com/api/chat/ws?ticket=abc123",
  "/api/admin/cuencadas",
  "/canciones/Cancion_Oficial.mp3",
  "https://cuencada.us-east-1.linodeobjects.com/media/2026/foto.jpg?X-Amz-Signature=abc",
  "https://cuencada.us-east-1.linodeobjects.com/api/cuencadas/home",
  "https://weatherwidget.io/w/",
  "https://www.google.com/maps/place/Merida"
];
for (const href of neverCached) check(!matches(href), `must NOT be cached: ${href}`);
check(!matches("/api/cuencadas/home", { method: "POST" }), "a POST must never be cached");
check(!matches("/api/chat/ticket", { method: "POST" }), "the chat ticket POST must never be intercepted");

/* --------------------------------------------- source plugin (serialized) */
const sourcePlugin = plugins.find((plugin) => typeof plugin.cachedResponseWillBeUsed === "function");
check(sourcePlugin !== undefined, "the public route must carry the source plugin");
if (sourcePlugin) {
  const cachedResponse = { ok: true, tag: "cached" };
  const fromCache = await sourcePlugin.cachedResponseWillBeUsed({ cachedResponse, event: { clientId: "tab-1" } });
  check(fromCache === cachedResponse, "cachedResponseWillBeUsed must return the cached response unchanged");
  const missing = await sourcePlugin.cachedResponseWillBeUsed({ cachedResponse: undefined, event: { clientId: "tab-1" } });
  check(missing === undefined, "a cache miss must stay a miss");
  const network = { ok: true, tag: "network" };
  const fromNetwork = await sourcePlugin.fetchDidSucceed({ response: network, event: { clientId: "tab-1" } });
  check(fromNetwork === network, "fetchDidSucceed must return the response unchanged");
  check(
    JSON.stringify(posted) ===
      JSON.stringify([
        { id: "tab-1", message: { type: SOURCE_MESSAGE, source: "cache" } },
        { id: "tab-1", message: { type: SOURCE_MESSAGE, source: "network" } }
      ]),
    `unexpected source messages: ${JSON.stringify(posted)}`
  );
}

/* ------------------------------------------------- purge + update prompt */
check(imported.includes("/sw-purge.js"), "sw.js must import /sw-purge.js");
const messageListeners = listeners.get("message") ?? [];
async function sendMessage(data, origin = ORIGIN) {
  const pending = [];
  for (const listener of messageListeners) listener({ data, origin, waitUntil: (promise) => pending.push(promise) });
  await Promise.all(pending);
}
await sendMessage({ type: PURGE_MESSAGE }, "https://evil.example");
check(deletedCaches.length === 0, "a purge message from another origin must be ignored");
await sendMessage({ type: PURGE_MESSAGE });
check(JSON.stringify(deletedCaches) === JSON.stringify([PUBLIC_API_CACHE]), `purge must delete the runtime cache, got ${JSON.stringify(deletedCaches)}`);
check(skipWaitingCalls === 0, "prompt mode: the worker must not skip waiting on its own");
await sendMessage({ type: "SKIP_WAITING" });
check(skipWaitingCalls === 1, "SKIP_WAITING (\"Actualizar\") must activate the waiting worker");

/* ------------------------------------------------------------ html + CSP */
for (const match of indexHtml.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
  check(/\bsrc=/.test(match[1] ?? "") && (match[2] ?? "").trim() === "", "index.html must have no inline scripts (CSP script-src 'self')");
}
check(!/registerSW\.js/.test(indexHtml), "registration must come from our bundle, not an injected registerSW.js");
check(/<link rel="manifest" href="\/manifest\.webmanifest"/.test(indexHtml), "index.html must link the manifest");
for (const host of ["weatherwidget", "linodeobjects", "amazonaws"]) {
  check(!swSource.includes(host), `sw.js must not mention ${host}`);
}

if (failures.length > 0) {
  process.stderr.write(`Service worker check failed (${failures.length}):\n${failures.map((f) => `  - ${f}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(
  `Service worker OK: ${precached.length} precached, 1 navigation fallback (denies /api), 1 runtime route (${PUBLIC_API_CACHE}), purge + prompt wired.\n`
);
