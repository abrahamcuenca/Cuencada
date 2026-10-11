/**
 * WP-5.1: an admin adds a Cuencada that happened before the portal, without
 * dates. It shows up in Home's "Cuencadas anteriores", its page carries the
 * before-the-portal note, and it can be picked in the gallery's year switcher
 * even though it has no photos yet. Fictional data only.
 */
import { pastYear } from "./harness/people.js";
import { CastRole, docShot, expect, login, test } from "./support/fixtures.js";

test.describe("past Cuencadas", () => {
  test("5.1 · an admin adds an undated past Cuencada; it is listed, explained and selectable in the gallery @desktop", async ({
    page,
    cast,
    project
  }, testInfo) => {
    const year = pastYear(project);
    await login(page, cast(CastRole.Admin));
    await page.goto("/admin/cuencadas");
    await page.getByRole("button", { name: "Agregar Cuencada anterior" }).click();
    const form = page.getByRole("form", { name: "Cuencada anterior" });
    await expect(form.getByText("Si no recuerdas las fechas exactas, déjalas vacías").first()).toBeVisible();
    await form.getByRole("textbox", { name: /^Año/ }).fill(String(year));
    await form.getByRole("textbox", { name: /^Descripción/ }).fill("Nos reunimos en la casa de la abuela, en Pueblo Ejemplo.");
    await docShot(page, testInfo, "wp5", "cuencada-anterior-form", form.getByRole("textbox", { name: /^Año/ }));
    await form.getByRole("button", { name: "Agregar y publicar" }).click();

    const added = page.getByText(`Cuencada ${year} agregada`);
    await expect(added).toBeVisible();
    await expect(page.getByRole("link", { name: /Asistencia/ })).toHaveAttribute("href", /\/admin\/cuencadas\/[0-9a-f-]+\/asistencia$/);
    await docShot(page, testInfo, "wp5", "cuencada-anterior-agregada", added);
    const list = page.getByRole("region", { name: "Lista de Cuencadas" });
    await expect(list.getByRole("link", { name: new RegExp(`^${year} · `) })).toContainText("Anterior");

    // Home: listed under "Cuencadas anteriores".
    await page.goto("/");
    const past = page.getByRole("region", { name: /Cuencadas anteriores/ });
    await expect(past.getByRole("link", { name: String(year), exact: true })).toBeVisible();
    await docShot(page, testInfo, "wp5", "home-anteriores", past);

    // Year page: the historical note, nothing "por anunciar", no empty programa.
    await past.getByRole("link", { name: String(year), exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/cuencada/${year}$`));
    await expect(page.getByRole("heading", { name: `Cuencada ${year}`, level: 1 })).toBeVisible();
    await expect(page.getByTestId("historical-note")).toHaveText("Esta Cuencada ocurrió antes del portal.");
    await expect(page.getByText(/por anunciar/i)).toHaveCount(0);
    await expect(page.getByRole("region", { name: `Programa Cuencada ${year}` })).toHaveCount(0);
    await expect(page.getByRole("timer")).toHaveCount(0);
    await docShot(page, testInfo, "wp5", "cuencada-anterior-pagina", page.getByTestId("historical-note"));

    // Gallery: the empty past year is in the switcher and opens.
    await page.goto("/galeria");
    const switcher = page.getByRole("combobox", { name: "Año del álbum" });
    await expect(switcher.locator("option", { hasText: String(year) })).toHaveCount(1);
    await switcher.selectOption(String(year));
    await expect(page).toHaveURL(new RegExp(`/galeria/${year}$`));
    await expect(page.getByRole("heading", { name: `Álbum vivo ${year}`, level: 1 })).toBeVisible();
  });
});
