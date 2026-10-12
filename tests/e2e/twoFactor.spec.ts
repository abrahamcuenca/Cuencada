/**
 * Journeys 19 and 19b (WP-7): two-step verification.
 *
 * - 19: a member turns it on from "Sesiones y seguridad", logs in with a
 *   code, trusts the device (the next login skips the code), then removes
 *   the trusted device (the code is back).
 * - 19b: a pre-enrolled member logs in with a recovery code (and gets the
 *   email), then an admin resets her two-step verification: her session
 *   ends and she logs in with the password alone.
 */
import { E2E_RECOVERY_CODES } from "./harness/people.js";
import { answerTwoFactor, CastRole, expect, journeyShot, login, test } from "./support/fixtures.js";
import { waitForMail } from "./support/mail.js";
import { enrollInWizard, logoutFromMenu } from "./support/twoFactor.js";

test.describe("two-step verification", () => {
  test("19 · a member turns on two-step verification, trusts this device, then removes it @desktop", async ({ page, cast }, testInfo) => {
    // Up to three codes; each may wait for the next 30-second step.
    test.setTimeout(240_000);
    const hugo = cast(CastRole.TwoFactor);
    await login(page, hugo);
    await page.goto("/perfil/sesiones");
    const section = page.getByRole("region", { name: "Verificación en dos pasos" });
    await expect(section.getByText("Desactivada")).toBeVisible();
    await section.getByRole("button", { name: "Activar", exact: true }).click();
    const wizard = page.getByRole("dialog", { name: "Activar la verificación en dos pasos" });
    await journeyShot(page, testInfo, "19-2fa-enable-password");
    const since = new Date();
    const { secret } = await enrollInWizard(wizard, hugo.email, hugo.password);
    await expect(section.getByText("Activada", { exact: true })).toBeVisible();
    await waitForMail({ to: hugo.email, category: "two-factor-notice", since });

    // Log out, log in: the code step, and "Confiar en este dispositivo 30 días".
    await logoutFromMenu(page);
    await page.goto("/entrar");
    await page.getByRole("textbox", { name: "Correo electrónico" }).fill(hugo.email);
    await page.getByRole("textbox", { name: "Contraseña", exact: true }).fill(hugo.password);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    const code = page.getByRole("textbox", { name: /Código de 6 números/ });
    await expect(code).toHaveAttribute("autocomplete", "one-time-code");
    await expect(code).toHaveAttribute("inputmode", "numeric");
    await journeyShot(page, testInfo, "19-2fa-code-step");
    await answerTwoFactor(page, hugo.email, secret, true);
    await expect(page.getByRole("button", { name: /^Mi cuenta/ })).toBeVisible();

    // The trusted browser skips the code next time.
    await logoutFromMenu(page);
    await login(page, hugo);

    // Remove the trusted device: the code is asked again.
    await page.goto("/perfil/sesiones");
    const devices = page.getByRole("list", { name: "Dispositivos de confianza" });
    await expect(devices.getByText("Este navegador")).toBeVisible();
    await journeyShot(page, testInfo, "19-2fa-trusted-devices");
    await devices.getByRole("button", { name: /^Quitar / }).click();
    await expect(page.getByText("Ese dispositivo volverá a pedir el código.")).toBeVisible();
    await logoutFromMenu(page);
    await page.goto("/entrar");
    await page.getByRole("textbox", { name: "Correo electrónico" }).fill(hugo.email);
    await page.getByRole("textbox", { name: "Contraseña", exact: true }).fill(hugo.password);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await expect(page.getByRole("textbox", { name: /Código de 6 números/ })).toBeVisible();
  });

  test("19b · recovery-code login, then an admin resets the member's two-step verification @desktop", async ({
    page,
    cast,
    newPhone
  }, testInfo) => {
    test.setTimeout(180_000);
    const ines = cast(CastRole.Recovery);
    const [recoveryCode] = E2E_RECOVERY_CODES;

    await page.goto("/entrar");
    await page.getByRole("textbox", { name: "Correo electrónico" }).fill(ines.email);
    await page.getByRole("textbox", { name: "Contraseña", exact: true }).fill(ines.password);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await page.getByRole("button", { name: "Usar un código de recuperación" }).click();
    await page.getByRole("textbox", { name: /Código de recuperación/ }).fill(recoveryCode.toUpperCase());
    const since = new Date();
    await page.getByRole("button", { name: "Verificar", exact: true }).click();
    await expect(page.getByRole("button", { name: /^Mi cuenta/ })).toBeVisible();
    const notice = await waitForMail({ to: ines.email, category: "two-factor-notice", since });
    expect(notice.subject).toBe("Usaste un código de recuperación");

    // An admin resets her 2FA (lost phone and codes).
    const adminPhone = await newPhone();
    // A separate pre-enrolled admin: the ready admin is already near the per-account login limit.
    await login(adminPhone, cast(CastRole.ResetAdmin));
    await adminPhone.goto("/admin/usuarios");
    await adminPhone.getByRole("searchbox").fill(ines.email);
    await adminPhone.getByRole("button", { name: new RegExp(ines.displayName) }).click();
    const sheet = adminPhone.getByRole("dialog", { name: ines.displayName });
    await expect(sheet.getByText("Verificación en dos pasos", { exact: true })).toBeVisible();
    const resetSince = new Date();
    await sheet.getByRole("button", { name: "Restablecer verificación en dos pasos" }).click();
    const confirm = adminPhone.getByRole("alertdialog", { name: /Restablecer la verificación en dos pasos/ });
    await journeyShot(adminPhone, testInfo, "19b-admin-reset-confirm");
    await confirm.getByRole("button", { name: "Restablecer", exact: true }).click();
    await expect(sheet.getByText(/Restablecimos su verificación en dos pasos/)).toBeVisible();
    const reset = await waitForMail({ to: ines.email, category: "two-factor-notice", since: resetSince });
    expect(reset.subject).toBe("Restablecieron tu verificación en dos pasos");

    // Her session ended; the password alone is enough now.
    await page.reload();
    await expect(page.getByRole("button", { name: /^Mi cuenta/ })).toHaveCount(0);
    await login(page, { email: ines.email, password: ines.password });
  });
});
