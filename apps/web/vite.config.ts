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
      proxy: {
        "/api": {
          target: "http://127.0.0.1:3006",
          // WebSocket upgrades for /api/chat/ws.
          ws: true
        }
      }
    }
  };
});
