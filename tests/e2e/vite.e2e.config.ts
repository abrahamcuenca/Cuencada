/**
 * Vite config for the e2e build and `vite preview`: the normal web config,
 * plus
 * - `VITE_MEDIA_UPLOAD_ORIGIN` = the harness' local object store,
 * - output in `apps/web/dist-e2e` (the release build in `dist/` is untouched),
 * - an HTTPS preview server (self-signed, so the production build's `wss:`
 *   chat socket works) on the e2e port, proxying `/api` (incl. the chat
 *   WebSocket) to the harness API.
 *
 * Run through the web package so `vite` resolves:
 *   pnpm --filter @cuencada/web exec vite build --config ../../tests/e2e/vite.e2e.config.ts
 */
import type { ConfigEnv, UserConfig } from "vite";
import baseConfig from "../../apps/web/vite.config.ts";
import { API_PORT, PREVIEW_TLS_DIR, REPO_ROOT, STORAGE_ORIGIN, WEB_DIST_DIR, WEB_PORT } from "./harness/settings.js";
import { createSelfSignedCert } from "./harness/tls.js";

// Read by Vite's env loading (process.env wins over .env files).
process.env.VITE_MEDIA_UPLOAD_ORIGIN = STORAGE_ORIGIN;

const apiProxy = {
  "/api": { target: `http://127.0.0.1:${API_PORT}`, ws: true }
};

export default async (env: ConfigEnv): Promise<UserConfig> => {
  // `baseConfig` is a `defineConfig` function config.
  const base = typeof baseConfig === "function" ? await baseConfig(env) : await baseConfig;
  const preview = env.isPreview === true;
  return {
    ...base,
    root: `${REPO_ROOT}/apps/web`,
    build: { ...base.build, outDir: WEB_DIST_DIR, emptyOutDir: true },
    preview: {
      host: "localhost",
      port: WEB_PORT,
      strictPort: true,
      proxy: apiProxy,
      ...(preview ? { https: createSelfSignedCert(PREVIEW_TLS_DIR) } : {})
    }
  };
};
