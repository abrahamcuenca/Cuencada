/**
 * Journey 11 (WP-3.1b): navigation by session state.
 * - Anonymous: Inicio, Programa, Entrar; Home's member links become one
 *   "Inicia sesión…" teaser.
 * - Member: the member nav; `/admin` says "Acceso restringido" instead of
 *   silently bouncing home; `/mas` has no admin entry.
 * - Admin: the member nav plus "Panel".
 */
import type { Locator, Page } from "@playwright/test";
import { CastRole, docShot, expect, login, test } from "./support/fixtures.js";

const TEASER = "Inicia sesión para ver el directorio, el árbol familiar, las fotos y el chat";
const MEMBER_BOTTOM = ["Inicio", "Programa", "Fotos", "Chat", "Más"];
const MEMBER_TOP = ["Programa", "Galería", "Directorio", "Árbol", "Chat"];

/** Visible link labels of a nav, in order (icons and unread-badge text dropped). */
async function linkLabels(nav: Locator): Promise<string[]> {
  const texts = await nav.getByRole("link").allInnerTexts();
  return texts.map((text) =>
    text
      .split(/[\n,]/)
      // Drop the unread badge ("3", "99+") and its screen-reader text ("1 mensaje sin leer").
      .filter((part) => /\p{L}/u.test(part) && !/sin leer/.test(part))
      .join(" ")
      .replace(/[^\p{L}\s]/gu, "")
      .trim()
  );
}

function isDesktop(page: Page): boolean {
  return (page.viewportSize()?.width ?? 0) >= 900;
}

const topNav = (page: Page): Locator => page.getByRole("navigation", { name: "Navegación principal" });
const bottomNav = (page: Page): Locator => page.getByRole("navigation", { name: "Navegación inferior" });

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
    } else {
      await expect.poll(() => linkLabels(bottomNav(page))).toEqual(MEMBER_BOTTOM);
      await page.goto("/mas");
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
      await expect.poll(() => linkLabels(topNav(page))).toEqual([...MEMBER_TOP, "Panel"]);
      await docShot(page, testInfo, "nav", "admin");
      await topNav(page).getByRole("link", { name: "Panel" }).click();
    } else {
      await expect.poll(() => linkLabels(bottomNav(page))).toEqual(MEMBER_BOTTOM);
      await bottomNav(page).getByRole("link", { name: /Más/ }).click();
      await docShot(page, testInfo, "nav", "admin");
      await page.getByRole("main").getByRole("link", { name: /Panel de administración/ }).click();
    }
    await expect(page.getByRole("heading", { name: "Panel de administración", level: 1 })).toBeVisible();
  });
});
