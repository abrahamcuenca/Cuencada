/**
 * Journey WP-4.4: directory contact information. Darío fills in his contacts
 * in "Mi perfil" → Contacto and shows exactly three of them; Ana sees exactly
 * those three in the directory (list chips and detail), and the hidden ones
 * are absent from the API response itself. Fictional data only.
 */
import type { Locator } from "@playwright/test";
import { CastRole, docShot, expect, login, test } from "./support/fixtures.js";

/**
 * Like `setControl`, but scrolls instantly: the app scrolls smoothly, and the
 * Contacto switches can be a whole screen apart, so a smooth scroll would
 * still be moving when the tap lands.
 */
async function setSwitch(control: Locator, checked: boolean): Promise<void> {
  await control.evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" }));
  await control.setChecked(checked, { force: true });
}

/** The part of `DirectoryEntry` this journey reads. */
interface EntryContacts {
  contacts?: Array<{ kind: string }>;
}

const PHONE = "555 010 0144";
const PHONE_E164 = "+525550100144";
const INSTAGRAM = "dario.ejemplo";
/** Filled in but kept hidden: must never reach another member. */
const HIDDEN_GITHUB = "dario-ejemplo-oculto";
const HIDDEN_WEBSITE = "https://example.com/dario-oculto";

test.describe("directory contacts", () => {
  test("a member shows 3 contacts and another member sees exactly those 3 @desktop", async ({ page, cast, newPhone }, testInfo) => {
    const dario = cast(CastRole.Dario);

    // ---------------------------------------------------- Darío edits his contacts
    const darioPhone = await newPhone();
    await login(darioPhone, dario);
    await darioPhone.goto("/perfil");
    const form = darioPhone.getByRole("form", { name: "Contacto" });
    await expect(form).toBeVisible();

    // A pasted profile link gets the Spanish error instead of being saved.
    const instagram = form.getByRole("textbox", { name: /^Instagram/ });
    await instagram.fill(`https://www.instagram.com/${INSTAGRAM}/`);
    await expect(form.getByText("Escribe solo tu usuario, sin el enlace.")).toBeVisible();
    await instagram.fill(INSTAGRAM);
    await expect(form.getByText("Escribe solo tu usuario, sin el enlace.")).toHaveCount(0);

    await expect(form.getByRole("combobox", { name: "País (lada) de teléfono" })).toHaveValue("52");
    await form.getByRole("textbox", { name: /^Teléfono/ }).fill(PHONE);
    await setSwitch(form.getByRole("checkbox", { name: "Usar mi teléfono" }), true);
    await form.getByRole("textbox", { name: /^GitHub/ }).fill(HIDDEN_GITHUB);
    await form.getByRole("textbox", { name: /^Sitio web/ }).fill(HIDDEN_WEBSITE);

    // Exactly three switches on: phone, WhatsApp, Instagram. Everything else stays hidden.
    for (const [label, on] of [
      ["Correo", false],
      ["Teléfono", true],
      ["WhatsApp", true],
      ["Instagram", true],
      ["Facebook", false],
      ["TikTok", false],
      ["LinkedIn", false],
      ["GitHub", false],
      ["Sitio web", false]
    ] as const) {
      await setSwitch(form.getByRole("switch", { name: `Mostrar a la familia (${label})` }), on);
    }
    await docShot(darioPhone, testInfo, "t5", "perfil-contacto", form.getByRole("textbox", { name: /^Instagram/ }));

    const save = form.getByRole("button", { name: "Guardar contacto" });
    // On a retry the values may already be stored (nothing to save).
    if (await save.isEnabled()) {
      await save.click();
      await expect(darioPhone.getByText("Contacto guardado.")).toBeVisible();
    }
    await expect(save).toBeDisabled();

    // ----------------------------------------------------- Ana opens the directory
    await login(page, cast(CastRole.Ana));
    await page.goto("/directorio");
    await page.getByRole("searchbox", { name: "Buscar por nombre o ciudad" }).fill(dario.displayName);
    const results = page.getByRole("list", { name: "Familiares" });
    const chips = results.getByRole("list", { name: /^Contacto de/ });
    await expect(chips.getByRole("link")).toHaveCount(3);
    await expect(chips.getByRole("link").nth(0)).toHaveAttribute("href", `tel:${PHONE_E164}`);
    await expect(chips.getByRole("link").nth(1)).toHaveAttribute("href", `https://wa.me/${PHONE_E164.slice(1)}`);
    await expect(chips.getByRole("link").nth(2)).toHaveAttribute("href", `https://instagram.com/${INSTAGRAM}`);
    await docShot(page, testInfo, "t5", "directorio-contactos");

    // The detail: the JSON carries exactly the three switched-on contacts; hidden ones are absent.
    const detailResponse = page.waitForResponse((response) => /\/api\/directory\/[0-9a-f-]{36}$/.test(new URL(response.url()).pathname));
    await results.getByRole("link", { name: new RegExp(`^${dario.displayName}`) }).click();
    const response = await detailResponse;
    expect(response.status()).toBe(200);
    const body = await response.text();
    const entry = JSON.parse(body) as EntryContacts; // the server serializes through directoryEntrySchema
    expect(entry.contacts?.map((item) => item.kind)).toEqual(["phone", "whatsapp", "instagram"]);
    expect(body).not.toContain(HIDDEN_GITHUB);
    expect(body).not.toContain("dario-oculto");
    expect(body).not.toContain(dario.email);
    expect(body).not.toContain("contactVisibility");

    const card = page.getByRole("article", { name: dario.displayName });
    const contacts = card.getByRole("list", { name: /^Contacto de/ });
    await expect(contacts.getByRole("link")).toHaveCount(3);
    await expect(contacts.getByRole("link", { name: /Instagram/ })).toHaveAttribute("rel", "noopener noreferrer nofollow");
    await expect(contacts.getByRole("link", { name: /Instagram/ })).toHaveAttribute("target", "_blank");
    await expect(contacts.getByRole("link", { name: /Teléfono/ })).not.toHaveAttribute("target", /.+/);
    await expect(card).not.toContainText(HIDDEN_GITHUB);
    await docShot(page, testInfo, "t5", "directorio-detalle-contactos", contacts);
  });
});
