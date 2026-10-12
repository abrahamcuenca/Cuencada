/**
 * WP-7 e2e helpers: walk the enrollment wizard (reading the manual key from
 * the screen, so the secret never has to be known in advance) and log out
 * through the account menu.
 */
import { expect, type Locator, type Page } from "@playwright/test";
import { freshCode, withAccountLock } from "./totp.js";

/** What the wizard produced. */
export interface Enrollment {
  /** The secret read from the screen (base32, no spaces). */
  secret: string;
  /** The recovery codes shown once. */
  codes: string[];
}

/**
 * Complete the "Activar" wizard inside `scope` (the gate page or the dialog).
 *
 * @param scope - Page or dialog that holds the wizard.
 * @param account - Tracker key for the codes (the email).
 * @param password - The current password.
 */
export async function enrollInWizard(scope: Page | Locator, account: string, password: string): Promise<Enrollment> {
  await scope.getByRole("textbox", { name: "Contraseña actual" }).fill(password);
  await scope.getByRole("button", { name: "Continuar", exact: true }).click();
  await expect(scope.getByRole("img", { name: /Código QR/ })).toBeVisible();
  const secret = ((await scope.getByLabel("Clave para escribir a mano").textContent()) ?? "").replaceAll(/\s+/g, "");
  expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
  const list = scope.getByRole("list", { name: "Códigos de recuperación" });
  await withAccountLock(account, async () => {
    await scope.getByRole("textbox", { name: /Código de 6 números/ }).fill(await freshCode(account, secret));
    await scope.getByRole("button", { name: "Activar", exact: true }).click();
    await expect(list.getByRole("listitem")).toHaveCount(10);
  });
  const codes = (await list.getByRole("listitem").allTextContents()).map((code) => code.trim());
  await scope.getByRole("button", { name: "Ya los guardé" }).click();
  return { secret, codes };
}

/**
 * Log out with the account menu and wait for the anonymous state.
 *
 * @param page - A logged-in page.
 */
export async function logoutFromMenu(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^Mi cuenta/ }).click();
  await page.getByRole("button", { name: "Cerrar sesión", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Mi cuenta/ })).toHaveCount(0);
}
