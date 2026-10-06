/**
 * Shared e2e settings: ports, origins and directories used by the Playwright
 * config, the harness server and the specs. Every value can be overridden by
 * env so CI and a local run can avoid port clashes.
 *
 * The defaults stay away from the dev API (3006), the deployed backend port
 * (3104) and the Vite dev server (5173).
 */
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Repo root (tests/e2e/harness → ../../..). */
export const REPO_ROOT = resolve(import.meta.dirname, "../../..");

function envPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${name} must be a TCP port`);
  return port;
}

/** Port of the e2e API (the harness process). */
export const API_PORT = envPort("E2E_API_PORT", 3190);
/** Port of the harness' local object store (presigned PUT/GET). */
export const STORAGE_PORT = envPort("E2E_STORAGE_PORT", 3191);
/** Port of `vite preview` serving the e2e build of the SPA. */
export const WEB_PORT = envPort("E2E_WEB_PORT", 4190);

/**
 * The SPA origin the browser uses. HTTPS (self-signed) because production
 * builds only open the chat socket over `wss:`; the API base is same-origin
 * `/api`, so `ws:` would be refused.
 */
export const WEB_ORIGIN = `https://localhost:${WEB_PORT}`;
/** API origin for health checks (the browser always goes through the preview proxy). */
export const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;
/**
 * Object-store origin baked into the e2e build as `VITE_MEDIA_UPLOAD_ORIGIN`.
 * HTTPS (self-signed, generated per run) because production builds refuse a
 * non-https upload origin; Playwright runs with `ignoreHTTPSErrors`.
 */
export const STORAGE_ORIGIN = `https://127.0.0.1:${STORAGE_PORT}`;

/**
 * Postgres URL of the dedicated e2e database. The harness DROPS and recreates
 * it on every start, so it refuses any database whose name does not end in
 * `_e2e` or whose host is not loopback.
 */
export const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? "postgresql://cuencada:cuencada@127.0.0.1:55432/cuencada_e2e";

/** Scratch directory for the run: the mail sink and the object store live here. */
export const E2E_RUN_DIR = process.env.E2E_RUN_DIR ?? join(tmpdir(), "cuencada-e2e");
/** Where the test-only mail sink writes one JSON file per message. */
export const MAIL_DIR = join(E2E_RUN_DIR, "mail");
/** Self-signed TLS key/cert for the local object store. */
export const TLS_DIR = join(E2E_RUN_DIR, "tls");
/** Self-signed TLS key/cert for `vite preview` (outside the run dir, which the harness wipes on start). */
export const PREVIEW_TLS_DIR = `${E2E_RUN_DIR}-preview-tls`;
/** Where the local object store keeps uploaded objects. */
export const STORAGE_DIR = join(E2E_RUN_DIR, "objects");

/** Output directory of the e2e SPA build (separate from `apps/web/dist`). */
export const WEB_DIST_DIR = join(REPO_ROOT, "apps/web/dist-e2e");

/** Committed journey screenshots (375 px, fictional data only). */
export const SCREENSHOT_DIR = join(REPO_ROOT, "docs/ux/screenshots/e2e");
