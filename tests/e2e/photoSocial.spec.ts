/**
 * WP-6.2 journey: hearts, comments and tags in the lightbox, the `?foto=`
 * deep link and tag consent. Fede uploads a generated (abstract) photo,
 * gives it a heart, comments and tags Ana (linked to an account, so the tag
 * waits for her approval, but Fede cannot tell); Ana opens the deep link on
 * her phone and approves; Fede deletes his comment (tombstone).
 */
import { CastRole, docShot, expect, login, test } from "./support/fixtures.js";
import { FUTURE_YEAR } from "./harness/people.js";
import { generateJpeg } from "./support/images.js";

test.describe("photo social", () => {
  test("6.2 · heart, comment and tag a photo; the tagged member approves from the deep link @desktop", async ({
    page,
    cast,
    project,
    newPhone
  }, testInfo) => {
    test.setTimeout(180_000);
    const fede = cast(CastRole.Fede);
    const ana = cast(CastRole.Ana);
    const caption = `Fogata de prueba (${project})`;
    const comment = `¡Qué bonita noche! (${project})`;

    await login(page, fede);
    await page.goto(`/galeria/${FUTURE_YEAR}`);
    const jpeg = await generateJpeg(page, "e2e-62", 1200, 900);
    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Subir fotos y videos" }).first().click();
    await (await chooserPromise).setFiles({ name: "fogata-e2e.jpg", mimeType: "image/jpeg", buffer: jpeg });
    const staging = page.getByRole("dialog", { name: "Subir 1 archivo" });
    await staging.getByRole("textbox", { name: /Descripción/ }).fill(caption);
    await staging.getByRole("button", { name: "Subir", exact: true }).click();

    const tile = page.getByRole("button", { name: `Ver foto: ${caption}` });
    await expect(tile).toBeVisible({ timeout: 60_000 });
    await tile.click();
    await expect(page).toHaveURL(/[?&]foto=[0-9a-f-]{36}/);
    const photoUrl = new URL(page.url());
    const viewer = page.getByRole("dialog").filter({ has: page.getByRole("button", { name: "Cerrar visor" }) });
    await expect(viewer.getByRole("img", { name: caption })).toBeVisible();

    // Heart.
    await viewer.getByRole("button", { name: "Me gusta", exact: true }).click();
    await expect(viewer.getByRole("button", { name: "Quitar me gusta" })).toHaveAttribute("aria-pressed", "true");

    // Tag Ana: the tagger sees a plain chip (no "Esperando aprobación", ADR 0001 §8).
    await viewer.getByRole("button", { name: /Etiquetar/ }).click();
    const picker = page.getByRole("dialog", { name: "Etiquetar a alguien" });
    await picker.getByRole("searchbox", { name: "Nombre de la persona" }).fill(ana.displayName);
    await picker.getByRole("button", { name: ana.displayName, exact: true }).click();
    await expect(picker).toBeHidden();
    const chips = viewer.getByRole("list", { name: "Personas etiquetadas" });
    await expect(chips.getByText(ana.displayName)).toBeVisible();
    await expect(chips.getByText(/Esperando aprobación/)).toHaveCount(0);
    await docShot(page, testInfo, "w62", "lightbox-social", chips);

    // Comment.
    await viewer.getByRole("button", { name: /Comentarios/ }).click();
    const sheet = page.getByRole("dialog", { name: "Comentarios" });
    await sheet.getByRole("textbox", { name: "Escribe un comentario" }).fill(comment);
    await sheet.getByRole("button", { name: "Publicar" }).click();
    await expect(sheet.getByRole("list", { name: "Lista de comentarios" }).getByText(comment)).toBeVisible();
    await docShot(page, testInfo, "w62", "comentarios", sheet);

    // Ana opens the deep link on her phone and approves the tag.
    const anaPage = await newPhone();
    await login(anaPage, ana);
    await anaPage.goto(`${photoUrl.pathname}${photoUrl.search}`);
    const banner = anaPage.getByRole("region", { name: "Etiqueta por aprobar" });
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(anaPage.getByText(/Esperando aprobación/)).toBeVisible();
    await docShot(anaPage, testInfo, "w62", "aprobar-etiqueta", banner);
    await banner.getByRole("button", { name: "Aprobar" }).click();
    await expect(anaPage.getByText("Listo, aprobaste la etiqueta.")).toBeVisible();
    await expect(banner).toBeHidden();
    await expect(anaPage.getByRole("button", { name: "Quitar mi etiqueta" })).toBeVisible();

    // Fede deletes his comment: it stays as a tombstone.
    const row = sheet.getByRole("listitem").filter({ hasText: comment });
    await row.getByRole("button", { name: "Eliminar" }).click();
    await row.getByRole("button", { name: "Sí, eliminar" }).click();
    await expect(sheet.getByText("Comentario eliminado", { exact: true })).toBeVisible();
    await expect(sheet.getByText(comment)).toHaveCount(0);
  });

  test("6.2 · a deep link to a photo that does not exist shows the not-found state", async ({ page, cast }) => {
    await login(page, cast(CastRole.Elena));
    await page.goto(`/galeria/${FUTURE_YEAR}?foto=00000000-0000-4000-8000-000000000062`);
    await expect(page.getByRole("dialog", { name: "No encontramos esa foto" })).toBeVisible({ timeout: 30_000 });
  });
});
