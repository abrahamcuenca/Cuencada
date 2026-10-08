/**
 * WP-4.3 journeys: photos with crop. The picked (generated, abstract) JPEG
 * is framed in the lazy `ImageCropper`, rendered to a 1024² JPEG in the
 * resize worker, PUT to the harness' object store through the presigned URL,
 * and processed by the real API (sharp: 512/256/64 WebP).
 */
import type { Locator, Page } from "@playwright/test";
import { familyNames } from "./harness/people.js";
import { CastRole, docShot, expect, login, test } from "./support/fixtures.js";
import { generateJpeg } from "./support/images.js";

/** Pick `file` through the button that opens the hidden file input. */
async function pickFile(page: Page, button: Locator, name: string, label: string): Promise<void> {
  const jpeg = await generateJpeg(page, label);
  const chooserPromise = page.waitForEvent("filechooser");
  await button.click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name, mimeType: "image/jpeg", buffer: jpeg });
}

/** Wait until an <img> inside `scope` has loaded real pixels. */
async function expectLoadedImage(scope: Locator): Promise<void> {
  const image = scope.locator("img").first();
  await expect(image).toBeVisible();
  await expect.poll(async () => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
}

test.describe("photos with crop", () => {
  test("4.3 · an admin frames a photo for a deceased great-grandparent and it shows in the tree @desktop", async ({
    page,
    cast,
    project
  }, testInfo) => {
    test.setTimeout(120_000);
    const { grandparent, greatGrandparent } = familyNames(project);
    await login(page, cast(CastRole.Admin));
    await page.goto("/arbol");
    await page.getByRole("searchbox", { name: "Buscar a un familiar" }).fill(greatGrandparent);
    await page.getByRole("button", { name: `Ver a ${greatGrandparent}, ya falleció` }).click();
    const focus = page.getByRole("article", { name: greatGrandparent });
    await expect(focus).toBeVisible();

    // The tree-photo controls live in the focus card's "Detalles" panel (WP-4.1 layout).
    await focus.getByText("Detalles", { exact: true }).click();
    // "Agregar foto" on a fresh database ("Cambiar foto" when a retry finds the photo already set).
    await pickFile(page, focus.getByRole("button", { name: /^(Agregar|Cambiar) foto$/ }), "bisabuelo-e2e.jpg", "e2e");
    const cropper = page.getByRole("dialog", { name: "Ajustar foto" });
    await expect(cropper).toBeVisible();
    const save = cropper.getByRole("button", { name: "Guardar" });
    await expect(save).toBeEnabled();
    // Frame it: zoom in twice, drag, rotate a quarter turn.
    await cropper.getByRole("button", { name: "Acercar" }).click();
    await cropper.getByRole("button", { name: "Acercar" }).click();
    const stage = cropper.getByTestId("image-cropper-canvas");
    const box = await stage.boundingBox();
    if (box === null) throw new Error("no cropper stage");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 30, { steps: 5 });
    await page.mouse.up();
    await cropper.getByRole("button", { name: "Girar" }).click();
    await expect(cropper.getByRole("slider", { name: "Zoom" })).toHaveValue("1.5");
    await docShot(page, testInfo, "t6", "foto-recorte", stage);
    await save.click();

    await expect(cropper).toBeHidden();
    await expect(page.getByText("Foto actualizada.")).toBeVisible({ timeout: 30_000 });
    await expectLoadedImage(focus);
    await expect(focus.getByRole("button", { name: "Cambiar foto" })).toBeVisible();

    // It shows in the tree: the grandparent's "Padres" ring pictures the great-grandparent.
    await page.getByRole("region", { name: "Hijos" }).getByRole("button", { name: `Ver a ${grandparent}, ya falleció` }).click();
    await expect(page.getByRole("article", { name: grandparent })).toBeVisible();
    const parentButton = page.getByRole("region", { name: "Padres" }).getByRole("button", { name: `Ver a ${greatGrandparent}, ya falleció` });
    await expectLoadedImage(parentButton);
    await docShot(page, testInfo, "t6", "foto-arbol", parentButton);
  });

  test("4.3 · a member frames their own avatar with the keyboard and saves it @desktop", async ({ page, cast }, testInfo) => {
    test.setTimeout(120_000);
    await login(page, cast(CastRole.Fede));
    await page.goto("/perfil");
    await expect(page.getByRole("heading", { name: "Mi perfil", level: 1 })).toBeVisible();

    await pickFile(page, page.getByRole("button", { name: "Cambiar foto" }), "avatar-e2e.jpg", "yo");
    const cropper = page.getByRole("dialog", { name: "Ajustar foto" });
    await expect(cropper.getByRole("button", { name: "Guardar" })).toBeEnabled();
    const stage = cropper.getByTestId("image-cropper-canvas");
    await stage.focus();
    await page.keyboard.press("+");
    await page.keyboard.press("+");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Shift+ArrowLeft");
    await expect(cropper.getByRole("slider", { name: "Zoom" })).toHaveValue("1.5");
    await docShot(page, testInfo, "t5", "avatar-recorte", stage);
    await cropper.getByRole("button", { name: "Guardar" }).click();

    await expect(page.getByText("Foto actualizada.")).toBeVisible({ timeout: 30_000 });
    const avatar = page.getByRole("img", { name: cast(CastRole.Fede).displayName }).first();
    await expectLoadedImage(avatar);
    await docShot(page, testInfo, "t5", "avatar-guardado", avatar);
  });
});
