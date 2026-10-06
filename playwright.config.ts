/**
 * Playwright e2e config (WP-2.2). Run with `pnpm e2e` (builds first) or
 * `pnpm e2e:run` (assumes `pnpm e2e:build` already ran).
 *
 * Two web servers: the e2e harness (real API from `apps/server/dist` with a
 * test-only mail sink and object store, fresh `*_e2e` database) and
 * `vite preview` of the e2e SPA build with `/api` (incl. WS) proxied.
 * See docs/coordination/WP-2.2.md.
 */
import { defineConfig, devices } from "@playwright/test";
import { API_ORIGIN, WEB_ORIGIN } from "./tests/e2e/harness/settings.js";

const CI = process.env.CI !== undefined && process.env.CI !== "";

/** Specs that are not journeys and run in their own projects. */
const GATE_SPECS = [/quality\.spec\.ts/, /lighthouse\.spec\.ts/];

/** Mobile profiles run in Chromium (Playwright's iPhone profile defaults to WebKit). */
const chromiumMobile = (name: "iPhone 13" | "Pixel 7") => {
  const { defaultBrowserType: _ignored, ...device } = devices[name];
  return { ...device, browserName: "chromium" as const };
};

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./test-results/e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: Number(process.env.E2E_WORKERS ?? 3),
  reporter: CI ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]] : [["list"]],
  use: {
    baseURL: WEB_ORIGIN,
    locale: "es-MX",
    timezoneId: "America/Merida",
    // Self-signed certs (preview + object store), generated per run.
    ignoreHTTPSErrors: true,
    // Service workers refuse origins with certificate errors unless Chromium ignores them.
    launchOptions: { args: ["--ignore-certificate-errors"] },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off"
  },
  projects: [
    // Journeys (tests/e2e/*.spec.ts): every journey on both phones, the @desktop subset at 1280.
    { name: "iphone-13", use: chromiumMobile("iPhone 13"), testIgnore: GATE_SPECS },
    { name: "pixel-7", use: chromiumMobile("Pixel 7"), testIgnore: GATE_SPECS },
    {
      name: "desktop-1280",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
      testIgnore: GATE_SPECS,
      grep: /@desktop/
    },
    // Quality gates (overflow, touch targets, input fonts, axe) at 320/375 px.
    { name: "mobile-gates", use: chromiumMobile("iPhone 13"), testMatch: /quality\.spec\.ts/ },
    // Lighthouse mobile: opt-in (E2E_LIGHTHOUSE=1), it needs its own Chromium with a debugging port.
    { name: "lighthouse", testMatch: /lighthouse\.spec\.ts/ }
  ],
  webServer: [
    {
      command: "pnpm exec tsx tests/e2e/harness/server.ts",
      url: `${API_ORIGIN}/health/ready`,
      env: { E2E: "1", NODE_ENV: "test" },
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
      stderr: "pipe"
    },
    {
      command: "pnpm --filter @cuencada/web exec vite preview --config ../../tests/e2e/vite.e2e.config.ts",
      url: WEB_ORIGIN,
      ignoreHTTPSErrors: true,
      reuseExistingServer: false,
      timeout: 60_000
    }
  ]
});
