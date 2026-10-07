import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { pwaOptions } from "./src/features/pwa/pwaConfig";

/**
 * `CUENCADA_DEV_HOST` opts the dev server into listening beyond localhost, so
 * the app can be tested on a phone over the LAN. Off by default.
 *   CUENCADA_DEV_HOST=1 pnpm --filter @cuencada/web dev        # all interfaces
 *   CUENCADA_DEV_HOST=192.168.1.20 pnpm --filter @cuencada/web dev
 * The API stays on 127.0.0.1 and is reached through the proxy below.
 *
 * `CUENCADA_DEV_API_ORIGIN` points that proxy at an API on another port (the
 * default is the server's `PORT` default, 3006) and `CUENCADA_DEV_PORT` moves
 * the dev server off 5173 (strictly: it fails instead of drifting to a port the
 * API's CSRF Origin check doesn't know), e.g. to run a second checkout:
 *   PORT=3016 APP_BASE_URL=http://localhost:5183 CUENCADA_DEV_PORT=5183 \
 *     CUENCADA_DEV_API_ORIGIN=http://127.0.0.1:3016 pnpm dev
 */
function devHost(value: string | undefined): string | boolean | undefined {
  if (value === undefined || value === "" || value === "0" || value === "false") return undefined;
  if (value === "1" || value === "true") return true;
  return value;
}

export default defineConfig(({ mode }) => {
  // Empty prefix: read non-VITE_ vars too. Only used here, never exposed to the client bundle.
  const env = loadEnv(mode, import.meta.dirname, "");

  return {
    // PWA (T9): generateSW + prompt, registered from our own module (no inline script, CSP-safe).
    // Caching policy and its [SEC] constraints: src/features/pwa/swRules.ts, docs/coordination/WP-T9.md.
    plugins: [react(), VitePWA(pwaOptions)],
    server: {
      host: devHost(env.CUENCADA_DEV_HOST),
      ...(env.CUENCADA_DEV_PORT ? { port: Number(env.CUENCADA_DEV_PORT), strictPort: true } : {}),
      proxy: {
        "/api": {
          target: env.CUENCADA_DEV_API_ORIGIN || "http://127.0.0.1:3006",
          // WebSocket upgrades for /api/chat/ws.
          ws: true
        }
      }
    }
  };
});
