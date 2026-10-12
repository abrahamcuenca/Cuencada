/**
 * WP-5.4 Eventos, the combined pass of the plan (WP-5 "Sequencing" 4):
 * - a member creates a participants-only trip and adds two relatives from the
 *   directory; they get the consent notice, chat and upload to the album;
 * - a non-participant can't see it (list, URL → the same 404 screen);
 * - an admin opens it;
 * - an all-members event: "Me apunto" → its chat room appears.
 *
 * Runs against the WP-5.3 server (merged with #54). Fictional data only.
 */
import type { Page } from "@playwright/test";
import { ProjectKey } from "./harness/people.js";
import { CastRole, docShot, expect, login, test } from "./support/fixtures.js";
import { generateJpeg } from "./support/images.js";

async function createEvent(page: Page, title: string, visibility: "Todos los miembros" | "Solo participantes"): Promise<string> {
  await page.goto("/eventos");
  await page.getByRole("button", { name: /Crear evento/ }).first().click();
  const sheet = page.getByRole("dialog", { name: "Crear evento" });
  await sheet.getByRole("textbox", { name: /Título/ }).fill(title);
  await expect(sheet.getByTestId("slug-preview")).toContainText("la dirección lleva un código corto");
  await sheet.getByRole("textbox", { name: /Resumen/ }).fill("Salimos temprano; cada familia lleva algo.");
  // Tap the label (no `force`): Playwright scrolls the sheet and waits until nothing (the sticky
  // footer) covers it, which a forced tap on the small native radio did not on short phones.
  await sheet.locator("label", { hasText: visibility }).click();
  await expect(sheet.getByRole("radio", { name: visibility })).toBeChecked();
  await sheet.getByRole("button", { name: "Crear evento" }).click();
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  // Member slugs always carry the random code (Security M1).
  await expect(page).toHaveURL(/\/eventos\/\d{4}\/[a-z0-9-]+-[a-z2-7]{4}$/);
  return new URL(page.url()).pathname;
}

test.describe("eventos", () => {
  test("5.4 · a participants-only trip: add relatives, notice, chat, album; hidden from others; admin can open it @desktop", async ({
    page,
    cast,
    project,
    newPhone
  }, testInfo) => {
    // Carla organizes: Ana's account is already near the per-account login limit across the journeys.
    const carla = cast(CastRole.Carla);
    const beto = cast(CastRole.Beto);
    const elena = cast(CastRole.Elena);
    const title = `Viaje a Ciudad de México (${project})`;
    await login(page, carla);
    const path = await createEvent(page, title, "Solo participantes");
    await docShot(page, testInfo, "eventos", "evento-creado", page.getByRole("heading", { level: 1 }));

    // Add two relatives from the directory.
    await page.getByRole("button", { name: /Personas/ }).click();
    const sheet = page.getByRole("dialog", { name: "Personas del evento" });
    await expect(sheet.getByText("Les avisaremos y podrán salir cuando quieran.")).toBeVisible();
    for (const member of [beto, elena]) {
      await sheet.getByRole("searchbox", { name: /Buscar en el directorio/ }).fill(member.firstName);
      // Several fictional people share a first name: pick the exact one. Tap its label (the full-row
      // target), which also works inside the scrolling sheet on short phones.
      const picker = sheet.getByRole("list", { name: "Personas del directorio" });
      await picker.getByText(member.displayName, { exact: true }).click();
      await expect(picker.getByRole("checkbox", { name: member.displayName, exact: true })).toBeChecked();
    }
    await sheet.getByRole("button", { name: "Agregar (2)" }).click();
    await expect(page.getByText("Agregaste a 2 personas.")).toBeVisible();
    await sheet.getByRole("button", { name: "Cerrar" }).click();

    // Beto gets the consent notice, opens the event and chats.
    const betoPhone = await newPhone();
    await login(betoPhone, beto);
    await betoPhone.goto("/eventos");
    await expect(betoPhone.getByText(new RegExp(`te agregó a «${title.replace(/[()]/g, "\\$&")}»`))).toBeVisible();
    await betoPhone.goto(`${path}?vista=chat`);
    const hello = `¿A qué hora salimos? (${Date.now() % 100_000})`;
    await betoPhone.getByRole("textbox", { name: "Mensaje" }).fill(hello);
    await betoPhone.getByRole("button", { name: "Enviar" }).click();
    await page.goto(`${path}?vista=chat`);
    await expect(page.getByRole("log").getByText(hello)).toBeVisible();

    // Carla uploads a photo to the default album.
    await page.goto(`${path}?vista=fotos`);
    const jpeg = await generateJpeg(page, "evento");
    await page.getByTestId("gallery-file-input").setInputFiles({ name: "evento.jpg", mimeType: "image/jpeg", buffer: jpeg });
    await page.getByRole("dialog", { name: /Subir/ }).getByRole("button", { name: /^Subir/ }).click();
    await expect(page.getByText(/Lista|Enviada/).first()).toBeVisible({ timeout: 30_000 });

    // A non-participant: not in the list, and the URL is the same 404 as a missing event.
    const darioPhone = await newPhone();
    await login(darioPhone, cast(CastRole.Dario));
    await darioPhone.goto("/eventos");
    await expect(darioPhone.getByRole("link", { name: title })).toHaveCount(0);
    await darioPhone.goto(path);
    await expect(darioPhone.getByRole("heading", { level: 1, name: "No encontramos ese evento" })).toBeVisible();
    await darioPhone.goto(path.replace(/-[a-z2-7]{4}$/, "-zzzz"));
    await expect(darioPhone.getByRole("heading", { level: 1, name: "No encontramos ese evento" })).toBeVisible();

    // An admin opens it (audited server-side). Desktop only: the iPhone cast's admin also serves the
    // 320/375 gates, and one more login there trips the per-account login limit (10 per 15 min).
    if (project !== ProjectKey.Desktop) return;
    const adminPhone = await newPhone();
    await login(adminPhone, cast(CastRole.Admin));
    await adminPhone.goto(path);
    await expect(adminPhone.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await adminPhone.goto("/admin/eventos");
    await expect(adminPhone.getByRole("link", { name: title })).toBeVisible();
  });

  test("5.4 · an all-members event: Me apunto opens its chat @desktop", async ({ page, cast, project, newPhone }) => {
    const title = `Carne asada (${project})`;
    await login(page, cast(CastRole.Carla));
    const path = await createEvent(page, title, "Todos los miembros");

    const betoPhone = await newPhone();
    await login(betoPhone, cast(CastRole.Beto));
    await betoPhone.goto(path);
    await betoPhone.getByRole("button", { name: /Me apunto/ }).click();
    await expect(betoPhone.getByText(/Te apuntaste a/)).toBeVisible();
    await betoPhone.goto("/chat");
    await expect(betoPhone.getByRole("list", { name: "Salas" }).getByRole("link", { name: new RegExp(title.replace(/[()]/g, "\\$&")) })).toBeVisible();
  });
});
