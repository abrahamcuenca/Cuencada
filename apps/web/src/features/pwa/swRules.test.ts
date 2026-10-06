import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { manifest, pwaOptions } from "./pwaConfig";
import {
  isPublicCuencadaRead,
  NAVIGATE_FALLBACK_DENYLIST,
  PRECACHE_GLOBS,
  PRECACHE_IGNORES,
  PUBLIC_API_CACHE,
  publicApiSourcePlugin,
  RUNTIME_CACHE_NAMES,
  SW_PURGE_MESSAGE,
  SW_SOURCE_MESSAGE
} from "./swRules";

const ORIGIN = "https://cuencada.com";

function matches(href: string, method = "GET"): boolean {
  const url = new URL(href, ORIGIN);
  return isPublicCuencadaRead({ url, request: { method }, sameOrigin: url.origin === ORIGIN });
}

describe("isPublicCuencadaRead", () => {
  it.each(["/api/cuencadas/home", "/api/cuencadas/2026", "/api/cuencadas/1998"])("caches the public read %s", (path) => {
    expect(matches(path)).toBe(true);
  });

  it.each([
    "/api/cuencadas/2026/members",
    "/api/cuencadas",
    "/api/cuencadas/home/",
    "/api/cuencadas/20261",
    "/api/cuencadas/home?debug=1",
    "/api/me",
    "/api/auth/refresh",
    "/api/announcements",
    "/api/directory",
    "/api/profile",
    "/api/media/2026",
    "/api/chat/messages",
    "/api/chat/ticket",
    "/api/chat/ws?ticket=abc123",
    "/api/admin/cuencadas",
    "/canciones/Cancion_Oficial.mp3",
    "/cuencada/2026"
  ])("does not cache %s", (path) => {
    expect(matches(path)).toBe(false);
  });

  it("does not cache presigned S3 URLs, the weather widget or any other origin, even on an /api path", () => {
    expect(matches("https://cuencada.us-east-1.linodeobjects.com/media/a.jpg?X-Amz-Signature=abc")).toBe(false);
    expect(matches("https://cuencada.us-east-1.linodeobjects.com/api/cuencadas/home")).toBe(false);
    expect(matches("https://weatherwidget.io/w/")).toBe(false);
  });

  it("never intercepts chat: the ticket POST or the WebSocket path", () => {
    expect(matches("/api/chat/ticket", "POST")).toBe(false);
    expect(matches("/api/chat/ws?ticket=abc123")).toBe(false);
    expect(matches("wss://cuencada.com/api/chat/ws?ticket=abc123")).toBe(false);
  });

  it("does not cache writes", () => {
    expect(matches("/api/cuencadas/home", "POST")).toBe(false);
    expect(matches("/api/cuencadas/2026", "PATCH")).toBe(false);
  });
});

describe("NAVIGATE_FALLBACK_DENYLIST", () => {
  const denied = (path: string): boolean => NAVIGATE_FALLBACK_DENYLIST.some((pattern) => pattern.test(path));

  it("keeps the SPA fallback away from /api, chat included", () => {
    for (const path of ["/api", "/api/", "/api/me", "/api/cuencadas/2026/members", "/api/chat/ws?ticket=abc123", "/api/chat/ticket"]) {
      expect(denied(path)).toBe(true);
    }
  });

  it("never answers a URL carrying a ticket with the shell (Workbox matches pathname + search)", () => {
    for (const path of ["/chat?ticket=abc123", "/?a=1&ticket=abc123"]) expect(denied(path)).toBe(true);
  });

  it("lets app routes fall back to the shell", () => {
    for (const path of ["/", "/cuencada/2026", "/entrar", "/galeria", "/apiary"]) expect(denied(path)).toBe(false);
  });
});

describe("pwaOptions", () => {
  it("uses generateSW in prompt mode with no injected registration script", () => {
    expect(pwaOptions.strategies).toBe("generateSW");
    expect(pwaOptions.registerType).toBe("prompt");
    expect(pwaOptions.injectRegister).toBeNull();
    expect(pwaOptions.workbox.skipWaiting).toBe(false);
  });

  it("declares exactly one runtime route, NetworkFirst into the public cache", () => {
    expect(pwaOptions.workbox.runtimeCaching).toHaveLength(1);
    const [rule] = pwaOptions.workbox.runtimeCaching;
    if (rule === undefined) throw new Error("no runtime rule");
    expect(rule.urlPattern).toBe(isPublicCuencadaRead);
    expect(rule.handler).toBe("NetworkFirst");
    expect(rule.options.cacheName).toBe(PUBLIC_API_CACHE);
    expect(rule.options.cacheableResponse.statuses).toEqual([200]);
  });

  it("never precaches the song or the API", () => {
    expect(PRECACHE_GLOBS.join()).not.toMatch(/mp3|jpe?g|vtt/);
    expect(PRECACHE_IGNORES).toEqual(expect.arrayContaining(["**/canciones/**", "**/api/**"]));
    expect(pwaOptions.workbox.navigateFallbackDenylist).toBe(NAVIGATE_FALLBACK_DENYLIST);
  });

  it("has the WP-0.7 manifest: Spanish, standalone, brand colours and maskable icons", () => {
    expect(manifest).toMatchObject({
      name: "Cuencada",
      short_name: "Cuencada",
      lang: "es-MX",
      start_url: "/",
      display: "standalone",
      theme_color: "#0b5e55",
      background_color: "#fffaf0"
    });
    expect(manifest.icons.filter((icon) => icon.purpose === "maskable").map((icon) => icon.sizes)).toEqual(["192x192", "512x512"]);
  });
});

describe("public/sw-purge.js", () => {
  const source = readFileSync(join(import.meta.dirname, "../../../public/sw-purge.js"), "utf8");

  it("deletes every runtime cache on the purge message", () => {
    expect(source).toContain(`"${SW_PURGE_MESSAGE}"`);
    for (const name of RUNTIME_CACHE_NAMES) expect(source).toContain(`"${name}"`);
  });
});

describe("publicApiSourcePlugin", () => {
  afterEach(() => {
    Reflect.deleteProperty(window, "clients");
  });

  function stubClients(): ReturnType<typeof vi.fn> {
    const postMessage = vi.fn();
    Object.defineProperty(window, "clients", {
      configurable: true,
      value: { get: vi.fn(async () => ({ postMessage })) }
    });
    return postMessage;
  }

  it("tells the requesting page that the answer came from the cache", async () => {
    const postMessage = stubClients();
    const cached = new Response("{}");

    await expect(publicApiSourcePlugin.cachedResponseWillBeUsed({ cachedResponse: cached, event: { clientId: "tab-1" } })).resolves.toBe(cached);
    expect(postMessage).toHaveBeenCalledWith({ type: SW_SOURCE_MESSAGE, source: "cache" });
  });

  it("says nothing on a cache miss", async () => {
    const postMessage = stubClients();

    await expect(publicApiSourcePlugin.cachedResponseWillBeUsed({ cachedResponse: undefined, event: { clientId: "tab-1" } })).resolves.toBeUndefined();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("reports a network answer", async () => {
    const postMessage = stubClients();
    const response = new Response("{}", { status: 200 });

    await expect(publicApiSourcePlugin.fetchDidSucceed({ response, event: { clientId: "tab-1" } })).resolves.toBe(response);
    expect(postMessage).toHaveBeenCalledWith({ type: SW_SOURCE_MESSAGE, source: "network" });
  });
});
