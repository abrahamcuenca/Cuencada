/**
 * Journey 4: the year page, public vs member view, the RSVP save and the
 * attendees list.
 */
import { ANNOUNCED_YEAR, FUTURE_YEAR } from "./harness/people.js";
import { CastRole, expect, journeyShot, login, setControl, test } from "./support/fixtures.js";

test.describe("cuencada year page", () => {
  test("4 · public visitors see the programa only; members RSVP and appear among the attendees @desktop", async ({ page, cast }, testInfo) => {
    await page.goto(`/cuencada/${FUTURE_YEAR}`);
    await expect(page.getByRole("heading", { name: `Cuencada ${FUTURE_YEAR}`, level: 1 })).toBeVisible();
    await expect(page.getByRole("region", { name: `Programa Cuencada ${FUTURE_YEAR}` })).toBeVisible();
    const family = page.getByRole("region", { name: "Para la familia" });
    await expect(family.getByRole("heading", { name: "Solo para la familia" })).toBeVisible();
    await expect(family.getByRole("link", { name: "Entrar" })).toBeVisible();
    // No member data for anonymous visitors.
    await expect(page.getByRole("heading", { name: "Confirmar asistencia" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "¿Quién va?" })).toHaveCount(0);
    await journeyShot(page, testInfo, "04-year-public");

    const ana = cast(CastRole.Ana);
    await login(page, ana);
    await page.goto(`/cuencada/${FUTURE_YEAR}`);
    const rsvp = page.getByRole("region", { name: "Para la familia" });
    await expect(rsvp.getByRole("heading", { name: "Confirmar asistencia" })).toBeVisible();

    await setControl(rsvp.getByRole("radio", { name: "Sí" }), true);
    await rsvp.getByRole("textbox", { name: /Notas para los organizadores/ }).fill("Llegamos en la tarde.");
    await journeyShot(page, testInfo, "04-rsvp-form");
    await rsvp.getByRole("button", { name: "Guardar respuesta" }).click();
    await expect(page.getByText("¡Listo! Confirmaste tu asistencia.")).toBeVisible();

    // Ana is now among the confirmed attendees, listed first with "Tú".
    const attendees = page.getByRole("button", { name: /confirmados?\s*:\s*ver la lista/ });
    await expect(attendees).toBeVisible();
    await attendees.click();
    const dialog = page.getByRole("dialog", { name: new RegExp(`Cuencada ${FUTURE_YEAR}`) });
    await expect(dialog.getByRole("listitem").first()).toContainText(ana.displayName);
    await expect(dialog.getByRole("listitem").first()).toContainText("Tú");
    await expect(dialog.getByText(cast(CastRole.Beto).displayName)).toBeVisible();
    await journeyShot(page, testInfo, "04-attendees");

    // The answer survives a reload.
    await page.reload();
    await expect(page.getByRole("button", { name: /confirmados?\s*:\s*ver la lista/ })).toBeVisible();
    await expect(page.getByText("¡Vas!")).toBeVisible();
    await expect(page.getByRole("button", { name: "Cambiar respuesta" })).toBeVisible();
  });

  test("4 · an announced edition shows Por anunciar, no countdown and no RSVP form", async ({ page, cast }) => {
    await page.goto(`/cuencada/${ANNOUNCED_YEAR}`);
    await expect(page.getByRole("heading", { name: `Cuencada ${ANNOUNCED_YEAR}`, level: 1 })).toBeVisible();
    await expect(page.getByText("Fecha y lugar por anunciar")).toBeVisible();
    await expect(page.getByTestId("pending-facts")).toContainText("Por anunciar");
    await expect(page.getByRole("timer")).toHaveCount(0);
    await expect(page.getByRole("region", { name: `Programa Cuencada ${ANNOUNCED_YEAR}` })).toHaveCount(0);

    await login(page, cast(CastRole.Ana));
    await page.goto(`/cuencada/${ANNOUNCED_YEAR}`);
    const family = page.getByRole("region", { name: "Para la familia" });
    await expect(family.getByText("Las confirmaciones abren cuando se anuncie la fecha.")).toBeVisible();
    await expect(family.getByRole("radio")).toHaveCount(0);
  });
});
