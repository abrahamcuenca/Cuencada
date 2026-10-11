/**
 * WP-5.4 Eventos, the combined pass of the plan (WP-5 "Sequencing" 4):
 * - a member creates a participants-only trip and adds two relatives from the
 *   directory; they get the consent notice, chat and upload to the album;
 * - a non-participant can't see it (list, URL → the same 404 screen);
 * - an admin opens it;
 * - an all-members event: "Me apunto" → its chat room appears.
 *
 * `test.fixme` until WP-5.3 (the events server) is on main: written against
 * the WP-5.2 contracts and the WP-5.3 notice contract. Fictional data only.
 */
import type { Page } from "@playwright/test";
import { CastRole, docShot, expect, login, setControl, test } from "./support/fixtures.js";
import { generateJpeg } from "./support/images.js";

/** Flip to `false` once WP-5.3 is merged (the events routes exist in the harness API). */
const EVENTS_SERVER_PENDING = true;

async function createEvent(page: Page, title: string, visibility: "Todos los miembros" | "Solo participantes"): Promise<string> {
  await page.goto("/eventos");
  await page.getByRole("button", { name: /Crear evento/ }).first().click();
  const sheet = page.getByRole("dialog", { name: "Crear evento" });
  await sheet.getByRole("textbox", { name: /Título/ }).fill(title);
  await expect(sheet.getByTestId("slug-preview")).toContainText("la dirección lleva un código corto");
  await sheet.getByRole("textbox", { name: /Resumen/ }).fill("Salimos temprano; cada familia lleva algo.");
  await setControl(sheet.getByRole("radio", { name: visibility }), true);
  await sheet.getByRole("button", { name: "Crear evento" }).click();
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  // Member slugs always carry the random code (Security M1).
  await expect(page).toHaveURL(/\/eventos\/\d{4}\/[a-z0-9-]+-[a-z2-7]{4}$/);
  return new URL(page.url()).pathname;
}

test.describe("eventos", () => {
  test.fixme(EVENTS_SERVER_PENDING, "WP-5.3 (events server) is not merged yet");

  test("5.4 · a participants-only trip: add relatives, notice, chat, album; hidden from others; admin can open it @desktop", async ({
    page,
    cast,
    project,
    newPhone
  }, testInfo) => {
    const ana = cast(CastRole.Ana);
    const beto = cast(CastRole.Beto);
    const elena = cast(CastRole.Elena);
    const title = `Viaje a Ciudad de México (${project})`;
    await login(page, ana);
    const path = await createEvent(page, title, "Solo participantes");
    await docShot(page, testInfo, "eventos", "evento-creado", page.getByRole("heading", { level: 1 }));

    // Add two relatives from the directory.
    await page.getByRole("button", { name: /Personas/ }).click();
    const sheet = page.getByRole("dialog", { name: "Personas del evento" });
    await expect(sheet.getByText("Les avisaremos y podrán salir cuando quieran.")).toBeVisible();
    for (const member of [beto, elena]) {
      await sheet.getByRole("searchbox", { name: /Buscar en el directorio/ }).fill(member.firstName);
      await setControl(sheet.getByRole("checkbox", { name: new RegExp(member.firstName) }), true);
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

    // Ana uploads a photo to the default album.
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

    // An admin opens it (audited server-side).
    const adminPhone = await newPhone();
    await login(adminPhone, cast(CastRole.Admin));
    await adminPhone.goto(path);
    await expect(adminPhone.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await adminPhone.goto("/admin/eventos");
    await expect(adminPhone.getByRole("link", { name: title })).toBeVisible();
  });

  test("5.4 · an all-members event: Me apunto opens its chat @desktop", async ({ page, cast, project, newPhone }) => {
    const title = `Carne asada (${project})`;
    await login(page, cast(CastRole.Ana));
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
