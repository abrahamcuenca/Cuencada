/**
 * Journey 11 (WP-3.1b): navigation by session state.
 * - Anonymous: Inicio, Programa, Entrar; Home's member links become one
 *   "Inicia sesión…" teaser.
 * - Member: the member nav; `/admin` says "Acceso restringido" instead of
 *   silently bouncing home; `/mas` has no admin entry.
 * - Admin: the member nav; "Panel" lives in the account menu (WP-4.7).
 * - WP-5.4: "Eventos" is in the TopNav from 1000 px, in the account menu
 *   below that, and in Más on phones.
 * - WP-4.7: desktop reaches /perfil#contacto from the account menu; phones
 *   reach Mi perfil from Más. Directorio links to "Editar mi perfil".
 */
import type { Locator, Page } from "@playwright/test";
import { CastRole, docShot, expect, login, test } from "./support/fixtures.js";

const TEASER = "Inicia sesión para ver el directorio, el árbol familiar, las fotos y el chat";
const MEMBER_BOTTOM = ["Inicio", "Programa", "Fotos", "Chat", "Más"];
/** The member TopNav from 1000 px (WP-5.4 "Eventos" shows only there; at 900–999 px it is in the account menu). */
const MEMBER_TOP = ["Programa", "Galería", "Eventos", "Directorio", "Árbol", "Chat"];
const MEMBER_TOP_NARROW = MEMBER_TOP.filter((label) => label !== "Eventos");

/** Visible link labels of a nav, in order (icons and unread-badge text dropped; CSS-hidden links skipped). */
async function linkLabels(nav: Locator): Promise<string[]> {
  const texts = await nav.getByRole("link").allInnerTexts();
  return texts
    .map((text) =>
      text
        .split(/[\n,]/)
        // Drop the unread badge ("3", "99+") and its screen-reader text ("1 mensaje sin leer").
        .filter((part) => /\p{L}/u.test(part) && !/sin leer/.test(part))
        .join(" ")
        .replace(/[^\p{L}\s]/gu, "")
        .trim()
    )
    .filter((label) => label !== "");
}

/**
 * WP-5.4: both sides of the 1000 px breakpoint. At 999 px "Eventos" is not in
 * the TopNav but in the account menu; at 1000 px it is in the TopNav and not
 * in the menu. Restores the original viewport.
 */
async function assertEventsBreakpoint(page: Page): Promise<void> {
  const original = page.viewportSize();
  // The account menu's own list (its id is the button's aria-controls), not the TopNav links.
  const menuId = await accountButton(page).getAttribute("aria-controls");
  const menuLink = page.locator(`[id="${menuId ?? ""}"]`).getByRole("link", { name: /Eventos/ });
  await page.setViewportSize({ width: 999, height: 800 });
  await expect.poll(() => linkLabels(topNav(page))).toEqual(MEMBER_TOP_NARROW);
  await accountButton(page).click();
  await expect(menuLink).toBeVisible();
  await expect(menuLink).toHaveAttribute("href", "/eventos");
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1000, height: 800 });
  await expect.poll(() => linkLabels(topNav(page))).toEqual(MEMBER_TOP);
  await accountButton(page).click();
  await expect(menuLink).toHaveCount(0);
  await page.keyboard.press("Escape");
  if (original !== null) await page.setViewportSize(original);
}

function isDesktop(page: Page): boolean {
  return (page.viewportSize()?.width ?? 0) >= 900;
}

const topNav = (page: Page): Locator => page.getByRole("navigation", { name: "Navegación principal" });
const bottomNav = (page: Page): Locator => page.getByRole("navigation", { name: "Navegación inferior" });
const accountButton = (page: Page): Locator => page.getByRole("banner").getByRole("button", { name: /^Mi cuenta/ });

test.describe("navigation by session", () => {
  test("11 · anonymous visitors get Inicio, Programa and Entrar, and a login teaser on Home @desktop", async ({ page }, testInfo) => {
    await page.goto("/");
    const todo = page.getByRole("region", { name: "Todo en un solo lugar" });
    await expect(todo.getByText(TEASER)).toBeVisible();
    await expect(todo.getByRole("link", { name: /Directorio|Árbol familiar|Álbum vivo/ })).toHaveCount(0);

    if (isDesktop(page)) {
      await expect.poll(() => linkLabels(topNav(page))).toEqual(["Inicio", "Programa"]);
      await expect(page.getByRole("banner").getByRole("link", { name: "Entrar" })).toBeVisible();
    } else {
      await expect.poll(() => linkLabels(bottomNav(page))).toEqual(["Inicio", "Programa", "Entrar"]);
    }
    await docShot(page, testInfo, "nav", "anonymous", todo);

    await todo.getByRole("link", { name: "Entrar" }).click();
    await expect(page).toHaveURL(/\/entrar$/);
  });

  test("11b · a member gets the member nav, and /admin says Acceso restringido @desktop", async ({ page, cast }, testInfo) => {
    await login(page, cast(CastRole.Ana));
    await page.goto("/");
    const todo = page.getByRole("region", { name: "Todo en un solo lugar" });
    await expect(todo.getByRole("link", { name: /Directorio/ })).toBeVisible();
    await expect(todo.getByText(TEASER)).toHaveCount(0);

    if (isDesktop(page)) {
      await expect.poll(() => linkLabels(topNav(page))).toEqual(MEMBER_TOP);
      await assertEventsBreakpoint(page);
    } else {
      await expect.poll(() => linkLabels(bottomNav(page))).toEqual(MEMBER_BOTTOM);
      await page.goto("/mas");
      await expect(page.getByRole("main").getByRole("link", { name: /Eventos/ })).toHaveAttribute("href", "/eventos");
      await expect(page.getByRole("heading", { name: "Más", level: 1 })).toBeVisible();
      await expect(page.getByRole("main").getByRole("link", { name: /Panel de administración/ })).toHaveCount(0);
      await page.goto("/");
    }
    await docShot(page, testInfo, "nav", "member", todo);

    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Acceso restringido", level: 1 })).toBeVisible();
    await expect(page.getByText("Esta sección es solo para administradores.")).toBeVisible();
    await expect(page).toHaveURL(/\/admin$/);
    await docShot(page, testInfo, "nav", "restricted");
    await page.getByRole("main").getByRole("link", { name: "Volver al inicio" }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  test("11c · an admin also gets Panel, which opens the console @desktop", async ({ page, cast }, testInfo) => {
    await login(page, cast(CastRole.Admin));
    await page.goto("/");

    if (isDesktop(page)) {
      await expect.poll(() => linkLabels(topNav(page))).toEqual(MEMBER_TOP);
      await assertEventsBreakpoint(page);
      await accountButton(page).click();
      await docShot(page, testInfo, "nav", "admin");
      await page.getByRole("banner").getByRole("link", { name: /Panel/ }).click();
    } else {
      await expect.poll(() => linkLabels(bottomNav(page))).toEqual(MEMBER_BOTTOM);
      await bottomNav(page).getByRole("link", { name: /Más/ }).click();
      await docShot(page, testInfo, "nav", "admin");
      await page.getByRole("main").getByRole("link", { name: /Panel de administración/ }).click();
    }
    await expect(page.getByRole("heading", { name: "Panel de administración", level: 1 })).toBeVisible();
  });

  test("11d · a member reaches Contacto of Mi perfil from the account menu (desktop) or Más (phones) @desktop", async ({ page, cast }, testInfo) => {
    await login(page, cast(CastRole.Ana));
    await page.goto("/");
    const contacto = page.getByRole("heading", { name: "Contacto", level: 2 });

    if (isDesktop(page)) {
      const button = accountButton(page);
      await button.click();
      await expect(button).toHaveAttribute("aria-expanded", "true");
      const menu = page.getByRole("banner").getByRole("list").filter({ has: page.getByRole("link", { name: /Mi perfil/ }) });
      await expect(menu.getByRole("link", { name: /Mi perfil/ })).toBeVisible();
      await expect(menu.getByRole("link", { name: /Panel/ })).toHaveCount(0);
      await docShot(page, testInfo, "nav", "account-menu");
      // Escape closes and gives focus back; the arrow key reopens on the first entry.
      await page.keyboard.press("Escape");
      await expect(button).toHaveAttribute("aria-expanded", "false");
      await expect(button).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(menu.getByRole("link", { name: /Mi perfil/ })).toBeFocused();
      await menu.getByRole("link", { name: /Contacto/ }).click();
      await expect(page).toHaveURL(/\/perfil#contacto$/);
      await expect(contacto).toBeInViewport();
      await expect(contacto).toBeFocused();
    } else {
      await accountButton(page).click();
      await docShot(page, testInfo, "nav", "account-menu");
      await page.keyboard.press("Escape");
      await bottomNav(page).getByRole("link", { name: /Más/ }).click();
      await page.getByRole("main").getByRole("link", { name: /Mi perfil/ }).click();
      await expect(page).toHaveURL(/\/perfil$/);
      await expect(page.getByRole("heading", { name: "Mi perfil", level: 1 })).toBeVisible();
      await page.goBack();
      await page.getByRole("main").getByRole("link", { name: /Contacto/ }).click();
      await expect(page).toHaveURL(/\/perfil#contacto$/);
      await expect(contacto).toBeInViewport();
    }

    await page.goto("/directorio");
    const edit = page.getByRole("main").getByRole("link", { name: /Editar mi perfil/ }).first();
    await expect(edit).toBeVisible();
    await docShot(page, testInfo, "nav", "directorio-editar-perfil", edit);
    await edit.click();
    await expect(page).toHaveURL(/\/perfil$/);
  });
});
