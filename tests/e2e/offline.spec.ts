/**
 * Journey 10: the PWA installs its service worker; offline, the cached
 * public programa renders with the offline notice, and member pages show
 * the offline state instead of cached member data (T9: `/api/**` member
 * endpoints are never cached).
 */
import type { Page } from "@playwright/test";
import { SEEDED_YEAR } from "./harness/people.js";
import { CastRole, expect, journeyShot, login, test } from "./support/fixtures.js";

/** Wait until the service worker is active and controls this page. */
async function waitForServiceWorker(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  if (!(await page.evaluate(() => navigator.serviceWorker.controller !== null))) {
    // The first load is not controlled until the SW claims it; reload once.
    await page.reload();
  }
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
}

test.describe("offline", () => {
  test("10 · the SW caches the public programa for offline; member pages show the offline state @desktop", async ({
    page,
    context,
    cast
  }, testInfo) => {
    const programa = `Programa Cuencada ${SEEDED_YEAR}`;
    await page.goto(`/cuencada/${SEEDED_YEAR}`);
    await waitForServiceWorker(page);
    // A controlled, online visit fills the runtime cache (NetworkFirst) for the public edition.
    await page.reload();
    await expect(page.getByRole("region", { name: programa })).toBeVisible();

    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole("heading", { name: `Cuencada ${SEEDED_YEAR}`, level: 1 })).toBeVisible();
    await expect(page.getByRole("region", { name: programa })).toBeVisible();
    await expect(page.getByText("Sin conexión — mostrando la última versión guardada")).toBeVisible();
    await journeyShot(page, testInfo, "10-offline-programa");

    // Member pages: logged in online, then offline. Nothing member-only is served from cache.
    await context.setOffline(false);
    await login(page, cast(CastRole.Ana));
    await page.goto("/directorio");
    await expect(page.getByRole("heading", { name: "Directorio familiar", level: 1 })).toBeVisible();

    await context.setOffline(true);
    await page.reload();
    const offline = page.getByRole("alert").filter({ has: page.getByRole("heading", { name: "Sin conexión" }) });
    await expect(offline).toBeVisible();
    await expect(offline.getByRole("button", { name: "Reintentar" })).toBeVisible();
    await expect(page.getByRole("list", { name: "Familiares" })).toHaveCount(0);
    await journeyShot(page, testInfo, "10-offline-member");

    // Back online, the session check retries by itself (`online` event) and the page recovers.
    await context.setOffline(false);
    await expect(page.getByRole("heading", { name: "Directorio familiar", level: 1 })).toBeVisible({ timeout: 20_000 });
  });
});
