/**
 * Shared Playwright fixtures and helpers for the e2e journeys.
 *
 * - Each browser context gets its own `X-Forwarded-For` (the harness API
 *   trusts the loopback preview proxy), so per-IP rate limits behave like
 *   separate phones instead of coupling every journey to 127.0.0.1.
 * - Requests to anything but the preview server and the local object store
 *   are aborted (weather widget, fonts): runs are hermetic and offline-safe.
 * - `project` is the Playwright project name, which selects the cast.
 */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { type BrowserContext, test as base, expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { type CastMember, CastRole, castMember, PROJECT_KEYS, type ProjectKey } from "../harness/people.js";
import { REPO_ROOT, SCREENSHOT_DIR, STORAGE_ORIGIN, WEB_ORIGIN } from "../harness/settings.js";

const ALLOWED_ORIGINS = new Set([new URL(WEB_ORIGIN).origin, STORAGE_ORIGIN]);

/** A stable fake client IP (TEST-NET-2, 198.51.100.0/24 + 10/8) per test and context. */
function fakeClientIp(seed: string): string {
  const digest = createHash("sha256").update(seed).digest();
  return `10.${digest[0] ?? 1}.${digest[1] ?? 1}.${(digest[2] ?? 1) % 250 + 1}`;
}

/** Abort every request that leaves the e2e stack. */
async function blockExternal(context: BrowserContext): Promise<void> {
  await context.route(
    (url) => !ALLOWED_ORIGINS.has(url.origin) && (url.protocol === "http:" || url.protocol === "https:"),
    (route) => route.abort("blockedbyclient")
  );
}

function projectOf(testInfo: TestInfo): ProjectKey {
  const name = testInfo.project.name;
  const found = PROJECT_KEYS.find((key) => key === name);
  if (found === undefined) throw new Error(`unknown Playwright project: ${name}`);
  return found;
}

interface Fixtures {
  /** The Playwright project (selects the per-project cast). */
  project: ProjectKey;
  /** Seeded account for a role in this project's cast. */
  cast: (role: CastRole) => CastMember;
  /** Open an extra, isolated browser context (another phone) with the same device settings. */
  newPhone: () => Promise<Page>;
}

export const test = base.extend<Fixtures>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright reads fixture names from the destructuring pattern.
  extraHTTPHeaders: async ({}, use, testInfo) => {
    await use({ "x-forwarded-for": fakeClientIp(`${testInfo.testId}:main:${testInfo.retry}`) });
  },
  ignoreHTTPSErrors: true,
  context: async ({ context }, use) => {
    await blockExternal(context);
    await use(context);
  },
  // biome-ignore lint/correctness/noEmptyPattern: Playwright reads fixture names from the destructuring pattern.
  project: async ({}, use, testInfo) => {
    await use(projectOf(testInfo));
  },
  cast: async ({ project }, use) => {
    await use((role) => castMember(project, role));
  },
  newPhone: async ({ browser, contextOptions, viewport, userAgent, isMobile, hasTouch, deviceScaleFactor, locale, timezoneId }, use, testInfo) => {
    const opened: BrowserContext[] = [];
    await use(async () => {
      const context = await browser.newContext({
        ...contextOptions,
        viewport,
        ...(userAgent === undefined ? {} : { userAgent }),
        ...(deviceScaleFactor === undefined ? {} : { deviceScaleFactor }),
        ...(locale === undefined ? {} : { locale }),
        ...(timezoneId === undefined ? {} : { timezoneId }),
        isMobile,
        hasTouch,
        ignoreHTTPSErrors: true,
        baseURL: WEB_ORIGIN,
        extraHTTPHeaders: { "x-forwarded-for": fakeClientIp(`${testInfo.testId}:phone${opened.length}:${testInfo.retry}`) }
      });
      opened.push(context);
      await blockExternal(context);
      return context.newPage();
    });
    for (const context of opened) await context.close();
  }
});

export { expect };

/**
 * Log in with email + password through the real form and wait for the app
 * to leave `/entrar`.
 */
export async function login(page: Page, member: Pick<CastMember, "email" | "password">): Promise<void> {
  await page.goto("/entrar");
  await page.getByRole("textbox", { name: "Correo electrónico" }).fill(member.email);
  await page.getByRole("textbox", { name: "Contraseña", exact: true }).fill(member.password);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page).not.toHaveURL(/\/entrar/);
  await expect(page.getByRole("button", { name: "Salir" })).toBeVisible();
}

/**
 * Set a radio, checkbox or switch the way a thumb does: scrolled to the
 * middle of the screen (clear of the sticky header and the bottom tab bar),
 * then tapped where it is drawn. `force` because custom radios keep the
 * native input visually hidden under their label.
 */
export async function setControl(control: Locator, checked: boolean): Promise<void> {
  await control.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await control.setChecked(checked, { force: true });
}

/** sharp, borrowed from the server package (test tooling only, never bundled). */
type SharpFactory = (input: Buffer) => { resize: (width: number) => { webp: (options: { quality: number }) => { toFile: (path: string) => Promise<unknown> } } };

/**
 * Save a 375 px screenshot of the current page to
 * `docs/ux/screenshots/e2e/<name>-375.webp` (2x, WebP like the other UX
 * screenshots). Only on the iPhone project and only when
 * `E2E_UPDATE_DOCS=1`, so normal and CI runs never touch docs/.
 */
export async function journeyShot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  if (process.env.E2E_UPDATE_DOCS !== "1" || testInfo.project.name !== "iphone-13") return;
  const previous = page.viewportSize();
  await page.setViewportSize({ width: 375, height: 812 });
  // Let layout settle after the resize.
  await page.waitForTimeout(300);
  const png = await page.screenshot({ animations: "disabled" });
  if (previous !== null) await page.setViewportSize(previous);
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const sharp = createRequire(join(REPO_ROOT, "apps/server/package.json"))("sharp") as SharpFactory; // CJS export: a callable factory
  await sharp(png).resize(750).webp({ quality: 80 }).toFile(join(SCREENSHOT_DIR, `${name}-375.webp`));
}

export { CastRole };
