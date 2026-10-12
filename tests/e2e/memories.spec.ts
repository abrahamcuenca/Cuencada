/**
 * WP-6.3 Baúl de recuerdos:
 * - a member opens the seeded published box from `/recuerdos` (and from
 *   Más), adds a photo with the gallery's own uploader (presigned PUT to
 *   `memories/{id}`, the real sharp job), opens it in the lightbox; another
 *   member sees it;
 * - the seeded hidden box is not listed and its URL shows the same
 *   "No encontramos ese baúl" as a missing one;
 * - an admin creates a box in the panel and publishes it (desktop only).
 *
 * Fictional data only (seed: `tests/e2e/harness/seed.ts`).
 */
import { HIDDEN_MEMORY_BOX_ID, MEMORY_BOX_ID, MEMORY_BOX_TITLE, ProjectKey } from "./harness/people.js";
import { CastRole, docShot, expect, login, test } from "./support/fixtures.js";
import { generateJpeg } from "./support/images.js";

test.describe("baúl de recuerdos", () => {
  test("6.3 · a member adds a photo to a published box, another member sees it; a hidden box is a 404 @desktop", async ({
    page,
    cast,
    project,
    newPhone
  }, testInfo) => {
    test.setTimeout(120_000);
    await login(page, cast(CastRole.Fede));
    await page.goto("/recuerdos");
    await expect(page.getByRole("heading", { level: 1, name: "Baúl de recuerdos" })).toBeVisible();
    const boxes = page.getByRole("list", { name: "Baúles" });
    await expect(boxes.getByRole("link", { name: MEMORY_BOX_TITLE })).toBeVisible();
    await expect(boxes.getByRole("link", { name: "Baúl oculto de prueba" })).toHaveCount(0);
    await docShot(page, testInfo, "recuerdos", "lista");

    await boxes.getByRole("link", { name: MEMORY_BOX_TITLE }).click();
    await expect(page).toHaveURL(new RegExp(`/recuerdos/${MEMORY_BOX_ID}$`));
    await expect(page.getByRole("heading", { level: 1, name: MEMORY_BOX_TITLE })).toBeVisible();
    await expect(page.getByText("Fotos escaneadas de los álbumes de la Rama Norte.", { exact: false })).toBeVisible();

    const caption = `Recuerdo de prueba (${project})`;
    const jpeg = await generateJpeg(page, "baul");
    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Subir fotos y videos" }).first().click();
    const chooser = await chooserPromise;
    await chooser.setFiles({ name: "recuerdo-e2e.jpg", mimeType: "image/jpeg", buffer: jpeg });
    const staging = page.getByRole("dialog", { name: "Subir 1 archivo" });
    await staging.getByRole("textbox", { name: /Descripción/ }).fill(caption);
    await staging.getByRole("button", { name: "Subir", exact: true }).click();

    const tile = page.getByRole("button", { name: `Ver foto: ${caption}` });
    await expect(tile).toBeVisible({ timeout: 60_000 });
    await expect(tile.locator("img")).toHaveJSProperty("complete", true);
    await docShot(page, testInfo, "recuerdos", "baul", page.getByRole("heading", { level: 1 }));
    await tile.click();
    const viewer = page.getByRole("dialog").filter({ has: page.getByRole("button", { name: "Cerrar visor" }) });
    await expect(viewer.getByRole("img", { name: caption })).toBeVisible();
    await viewer.getByRole("button", { name: "Cerrar visor" }).click();

    // Another member: through Más on phones (the menu entry on desktop), then the photo.
    const other = await newPhone();
    await login(other, cast(CastRole.Dario));
    if (project === ProjectKey.Desktop) {
      await other.goto("/recuerdos");
    } else {
      await other.goto("/mas");
      await other.getByRole("main").getByRole("link", { name: /Baúl de recuerdos/ }).click();
    }
    await other.getByRole("list", { name: "Baúles" }).getByRole("link", { name: MEMORY_BOX_TITLE }).click();
    await expect(other.getByRole("button", { name: `Ver foto: ${caption}` })).toBeVisible();

    // The hidden box: the same screen as a missing one.
    for (const id of [HIDDEN_MEMORY_BOX_ID, "66666666-0000-4000-8000-0000000000ff"]) {
      await other.goto(`/recuerdos/${id}`);
      await expect(other.getByRole("heading", { name: "No encontramos ese baúl" })).toBeVisible();
      await expect(other.getByText("Baúl oculto de prueba")).toHaveCount(0);
    }
  });

  test("6.3 · an admin creates and publishes a box in the panel @desktop", async ({ page, cast, project }, testInfo) => {
    // The iPhone cast's admin also serves the 320/375 gates; one more login there trips the per-account limit.
    test.skip(project !== ProjectKey.Desktop, "admin journey on desktop only");
    await login(page, cast(CastRole.Admin));
    await page.goto("/admin");
    await page.getByRole("navigation", { name: "Secciones de administración" }).getByRole("link", { name: /Baúl de recuerdos/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Baúl de recuerdos" })).toBeVisible();

    const title = "Bodas de la familia (e2e)";
    await page.getByRole("button", { name: /Nuevo baúl/ }).click();
    const sheet = page.getByRole("dialog", { name: "Nuevo baúl" });
    await sheet.getByRole("textbox", { name: /Título/ }).fill(title);
    await sheet.getByRole("textbox", { name: /Descripción/ }).fill("De 1960 en adelante.");
    await sheet.getByRole("button", { name: "Crear baúl" }).click();
    await expect(page.getByText(`Creaste ${title}.`)).toBeVisible();

    const row = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: title }) });
    await expect(row.getByText("Borrador")).toBeVisible();
    await row.getByRole("button", { name: "Publicar" }).click();
    await expect(page.getByText(`Publicaste ${title}.`)).toBeVisible();
    await expect(row.getByText("Publicado")).toBeVisible();
    await docShot(page, testInfo, "recuerdos", "panel");

    await page.goto("/recuerdos");
    await expect(page.getByRole("list", { name: "Baúles" }).getByRole("link", { name: title })).toBeVisible();
  });
});
