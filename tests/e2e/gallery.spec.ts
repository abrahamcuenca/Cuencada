/**
 * Journey 5: upload a generated JPEG (abstract shapes, no people) →
 * processing → grid → lightbox → caption edit → delete. The bytes go
 * browser → presigned PUT → the harness' local object store; the real API
 * job pipeline (sharp) makes the thumbnails.
 */
import type { Page } from "@playwright/test";
import { FUTURE_YEAR } from "./harness/people.js";
import { CastRole, expect, journeyShot, login, test } from "./support/fixtures.js";

/** Draw an 800×600 abstract JPEG in the page (no people, nothing identifying). */
async function generateJpeg(page: Page, seed: string): Promise<Buffer> {
  const base64 = await page.evaluate(async (label) => {
    const canvas = document.createElement("canvas");
    canvas.width = 800;
    canvas.height = 600;
    const ctx = canvas.getContext("2d");
    if (ctx === null) throw new Error("no 2d context");
    const gradient = ctx.createLinearGradient(0, 0, 800, 600);
    gradient.addColorStop(0, "#0b5e55");
    gradient.addColorStop(1, "#e8b84a");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 800, 600);
    for (let i = 0; i < 12; i += 1) {
      ctx.fillStyle = `hsla(${(i * 37) % 360}, 70%, 60%, 0.6)`;
      ctx.beginPath();
      ctx.arc(80 + i * 60, 300 + Math.sin(i) * 150, 40 + (i % 4) * 15, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "#fff8ec";
    ctx.font = "bold 48px sans-serif";
    ctx.fillText(label, 40, 80);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (blob === null) throw new Error("toBlob failed");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }, seed);
  return Buffer.from(base64, "base64");
}

test.describe("gallery", () => {
  test("5 · upload a photo, see it processed in the grid, open it, edit the caption and delete it @desktop", async ({
    page,
    cast,
    project
  }, testInfo) => {
    test.setTimeout(120_000);
    await login(page, cast(CastRole.Fede));
    await page.goto(`/galeria/${FUTURE_YEAR}`);
    await expect(page.getByRole("heading", { name: `Álbum vivo ${FUTURE_YEAR}`, level: 1 })).toBeVisible();

    const jpeg = await generateJpeg(page, "e2e");
    const caption = `Atardecer de prueba (${project})`;
    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Subir fotos y videos" }).first().click();
    const chooser = await chooserPromise;
    expect(chooser.isMultiple()).toBe(true);
    await chooser.setFiles({ name: "atardecer-e2e.jpg", mimeType: "image/jpeg", buffer: jpeg });

    const staging = page.getByRole("dialog", { name: "Subir 1 archivo" });
    await staging.getByRole("textbox", { name: /Descripción/ }).fill(caption);
    await journeyShot(page, testInfo, "05-upload-sheet");
    await staging.getByRole("button", { name: "Subir", exact: true }).click();

    // Processing → ready (the job runs in the API; the grid refreshes itself).
    const tile = page.getByRole("button", { name: `Ver foto: ${caption}` });
    await expect(tile).toBeVisible({ timeout: 60_000 });
    await expect(tile.locator("img")).toHaveJSProperty("complete", true);
    await journeyShot(page, testInfo, "05-grid");

    await tile.click();
    const viewer = page.getByRole("dialog").filter({ has: page.getByRole("button", { name: "Cerrar visor" }) });
    await expect(viewer).toBeVisible();
    await expect(viewer.getByRole("img", { name: caption })).toBeVisible();
    await journeyShot(page, testInfo, "05-lightbox");

    const newCaption = `Atardecer editado (${project})`;
    await viewer.getByRole("button", { name: "Editar descripción" }).click();
    const captionDialog = page.getByRole("dialog", { name: "Editar descripción" });
    await captionDialog.getByRole("textbox", { name: /Descripción/ }).fill(newCaption);
    await captionDialog.getByRole("button", { name: "Guardar" }).click();
    await expect(page.getByText("Descripción guardada.")).toBeVisible();
    await expect(viewer.getByRole("img", { name: newCaption })).toBeVisible();

    await viewer.getByRole("button", { name: "Eliminar" }).click();
    const confirm = page.getByRole("alertdialog", { name: /¿Eliminar/ });
    await confirm.getByRole("button", { name: "Eliminar" }).click();
    await expect(page.getByText("Foto eliminada.")).toBeVisible();
    await expect(page.getByRole("button", { name: `Ver foto: ${newCaption}` })).toHaveCount(0);
    await expect(page.getByRole("button", { name: `Ver foto: ${caption}` })).toHaveCount(0);
  });
});
