/**
 * Journey 6: directory search + detail, and the profile switch "Aparecer en
 * el directorio" hiding a member from the directory.
 */
import { CastRole, expect, journeyShot, login, setControl, test } from "./support/fixtures.js";

test.describe("directory", () => {
  test("6 · search the directory, open a detail, and a member who opts out disappears from it @desktop", async ({
    page,
    cast,
    newPhone
  }, testInfo) => {
    const beto = cast(CastRole.Beto);
    const carla = cast(CastRole.Carla);
    await login(page, cast(CastRole.Ana));
    await page.goto("/directorio");
    await expect(page.getByRole("heading", { name: "Directorio familiar", level: 1 })).toBeVisible();

    const search = page.getByRole("searchbox", { name: "Buscar por nombre o ciudad" });
    await search.fill(beto.displayName);
    const results = page.getByRole("list", { name: "Familiares" });
    await expect(results.getByRole("link")).toHaveCount(1);
    await journeyShot(page, testInfo, "06-directory-search");
    await results.getByRole("link", { name: new RegExp(beto.displayName) }).click();
    await expect(page).toHaveURL(/\/directorio\/[0-9a-f-]{36}/);
    await expect(page.getByRole("heading", { name: beto.displayName, level: 2 })).toBeVisible();
    await journeyShot(page, testInfo, "06-directory-detail");

    // Carla is listed until she switches "Aparecer en el directorio" off.
    await page.goto("/directorio");
    await page.getByRole("searchbox", { name: "Buscar por nombre o ciudad" }).fill(carla.displayName);
    await expect(page.getByRole("list", { name: "Familiares" }).getByRole("link")).toHaveCount(1);

    const carlaPhone = await newPhone();
    await login(carlaPhone, carla);
    await carlaPhone.goto("/perfil");
    const listed = carlaPhone.getByRole("switch", { name: "Aparecer en el directorio" });
    await expect(listed).toBeChecked();
    await setControl(listed, false);
    await expect(listed).not.toBeChecked();
    await journeyShot(carlaPhone, testInfo, "06-profile-privacy");
    await carlaPhone.getByRole("button", { name: "Guardar cambios" }).click();
    await expect(carlaPhone.getByRole("button", { name: "Guardar cambios" })).toBeDisabled();

    await page.reload();
    await page.getByRole("searchbox", { name: "Buscar por nombre o ciudad" }).fill(carla.displayName);
    await expect(page.getByRole("heading", { name: `No encontramos a nadie con "${carla.displayName}"` })).toBeVisible();
    await journeyShot(page, testInfo, "06-directory-hidden");
  });
});
