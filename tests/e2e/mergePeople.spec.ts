/**
 * Journey 14 (WP-4.5): the invite race. An admin adds "Lucía" to the tree;
 * separately, Lucía joins with a shared link (no tree person named), so she
 * gets a second, linked person. The admin finds the pair in "Posibles
 * duplicados", merges them, and the tree shows one Lucía, linked to her
 * account, with both sets of relationships. Then the admin undoes the merge.
 * Fictional people only.
 */
import type { Page } from "@playwright/test";
import { familyNames, mergeNames } from "./harness/people.js";
import { appLinkIn, waitForMail } from "./support/mail.js";
import { CastRole, docShot, expect, login, test } from "./support/fixtures.js";

/** Open `name` in the tree from the admin's people list. */
async function openInTree(page: Page, name: string): Promise<void> {
  await page.goto("/admin/familia");
  await page.getByRole("searchbox", { name: "Buscar persona" }).fill(name);
  await page.getByRole("region", { name: "Lista de personas" }).getByRole("link", { name: new RegExp(`^${name}`) }).click();
  await page.getByRole("link", { name: "Ver en el árbol" }).click();
  await expect(page.getByRole("article", { name })).toBeVisible();
}

/** "Agregar …" → "Crear nueva persona" as an admin. */
async function addRelative(page: Page, label: string, name: string): Promise<void> {
  await page.getByRole("button", { name: label }).click();
  const sheet = page.getByRole("dialog", { name: label });
  await sheet.getByRole("searchbox", { name: "Buscar persona" }).fill(name);
  await sheet.getByRole("button", { name: "Crear nueva persona" }).click();
  await expect(sheet.getByLabel(/^Nombre completo/)).toHaveValue(name);
  await sheet.getByRole("button", { name: "Crear nueva persona" }).click();
  await expect(page.getByText(`Agregamos a ${name}.`)).toBeVisible();
  await expect(sheet).toBeHidden();
}

test.describe("merge duplicate people", () => {
  test("14 · an invite race leaves two Lucías; the admin merges them from «Posibles duplicados» and undoes it @desktop", async ({
    page,
    cast,
    project,
    newPhone
  }, testInfo) => {
    test.setTimeout(180_000);
    const names = mergeNames(project);
    const { parent } = familyNames(project);

    // The admin adds Lucía to the tree, as the seeded parent's daughter.
    await login(page, cast(CastRole.Admin));
    await openInTree(page, parent);
    await addRelative(page, "Agregar hijo/a", names.treePerson);

    // Meanwhile Lucía joins with a shared link, which names no tree person.
    await page.goto("/admin/invitaciones");
    await page.getByRole("button", { name: "Invitar" }).click();
    const form = page.getByRole("form", { name: "Nueva invitación" });
    await form.getByRole("radio", { name: /Enlace para compartir/ }).check();
    await form.getByRole("spinbutton", { name: /¿Cuántas personas/ }).fill("1");
    await form.getByRole("button", { name: "Crear enlace" }).click();
    const link = await page.getByRole("textbox", { name: "Enlace de invitación" }).inputValue();
    const phone = await newPhone();
    await phone.goto(link);
    await phone.getByRole("textbox", { name: "Nombre completo" }).fill(names.typedName);
    await phone.getByRole("textbox", { name: "Correo electrónico" }).fill(names.email);
    await phone.getByRole("textbox", { name: "Crea una contraseña" }).fill("Lucia-e2e-segura-2027");
    await phone.getByRole("textbox", { name: "Confirma tu contraseña" }).fill("Lucia-e2e-segura-2027");
    await phone.getByRole("button", { name: /Crear (mi )?cuenta/ }).click();
    await expect(phone.getByRole("button", { name: "Salir" })).toBeVisible();

    // An admin relates the new (duplicate) person: her partner.
    await openInTree(page, names.typedName);
    await addRelative(page, "Agregar pareja", names.partner);

    // "Posibles duplicados" shows the pair; "Revisar" opens the preview.
    await page.goto("/admin/familia/actividad");
    await page.getByRole("tab", { name: "Posibles duplicados" }).click();
    const pair = page.getByRole("listitem", { name: `${names.treePerson} y ${names.typedName}` });
    await expect(pair).toBeVisible();
    await expect(pair).toContainText("Nombre parecido");
    await docShot(page, testInfo, "t6", "posibles-duplicados", pair);
    await pair.getByRole("button", { name: /^Revisar/ }).click();
    const sheet = page.getByRole("dialog", { name: "Fusionar personas" });
    await expect(sheet.getByText(`${names.typedName} se combina con ${names.treePerson}, que es quien se queda en el árbol.`)).toBeVisible();
    await expect(sheet.getByRole("list", { name: `Relaciones que pasan a ${names.treePerson}` })).toContainText(`${names.partner} · pareja`);
    await expect(sheet.getByText(new RegExp(`pasa a ${names.treePerson}\\.$`))).toBeVisible();
    await expect(sheet.getByRole("group", { name: "Nombre completo" }).getByRole("radio", { name: new RegExp(`^${names.treePerson}\\s?de ${names.treePerson}`) })).toBeChecked();
    await docShot(page, testInfo, "t6", "fusionar-vista-previa", sheet.getByRole("heading", { name: "Datos" }));
    await sheet.getByRole("button", { name: "Fusionar" }).click();
    const confirm = page.getByRole("alertdialog", { name: `¿Fusionar a ${names.typedName} con ${names.treePerson}?` });
    await expect(confirm).toContainText("Esta acción combina a las dos personas en una sola");
    await docShot(page, testInfo, "t6", "fusionar-confirmar", confirm.getByRole("button", { name: "Fusionar" }));
    await confirm.getByRole("button", { name: "Fusionar" }).click();
    await expect(page.getByText(`Fusionamos a ${names.typedName} con ${names.treePerson}.`)).toBeVisible();
    await expect(page.getByRole("heading", { name: names.treePerson, level: 1 })).toBeVisible();

    // One Lucía left, with her parent and her partner.
    await page.goto("/admin/familia");
    await page.getByRole("searchbox", { name: "Buscar persona" }).fill(`Lucía Arias`);
    const list = page.getByRole("region", { name: "Lista de personas" });
    await expect(list.getByRole("link", { name: new RegExp(names.treePerson) })).toHaveCount(1);
    await expect(list.getByRole("link", { name: new RegExp(names.typedName) })).toHaveCount(0);

    // Lucía confirms her email and sees herself in the tree: linked, both sets of relatives.
    const banner = phone.getByRole("region", { name: "Verifica tu correo" });
    await expect(banner).toBeVisible();
    const since = new Date();
    await banner.getByRole("button", { name: "Reenviar enlace" }).click();
    const mail = await waitForMail({ to: names.email, category: "verify-email", since });
    await phone.goto(appLinkIn(mail, "/verificar"));
    await phone.getByRole("button", { name: "Confirmar mi correo" }).click();
    await expect(phone.getByRole("heading", { name: "Correo verificado" })).toBeVisible();
    await phone.goto("/arbol");
    await expect(phone.getByRole("article", { name: names.treePerson })).toBeVisible();
    await expect(phone.getByRole("region", { name: "Padres" }).getByRole("button", { name: `Ver a ${parent}` })).toBeVisible();
    await expect(phone.getByRole("region", { name: /^Pareja/ }).getByRole("button", { name: `Ver a ${names.partner}` })).toBeVisible();

    // The admin undoes the merge from "Actividad del árbol": two people again.
    await page.goto("/admin/familia/actividad");
    const undo = page
      .getByRole("region", { name: "Cambios" })
      .getByRole("button", { name: `Deshacer: Fusionó a dos personas: «${names.typedName}» en «${names.treePerson}» de ${names.treePerson}` });
    await undo.click();
    const confirmUndo = page.getByRole("alertdialog", { name: "¿Deshacer este cambio?" });
    await expect(confirmUndo).toContainText("vuelven a quedar separadas");
    await confirmUndo.getByRole("button", { name: "Deshacer" }).click();
    await expect(page.getByText("Deshicimos el cambio.")).toBeVisible();
    await page.goto("/admin/familia");
    await page.getByRole("searchbox", { name: "Buscar persona" }).fill(`Lucía Arias`);
    await expect(list.getByRole("link", { name: new RegExp(names.typedName) })).toHaveCount(1);
    await phone.goto("/arbol");
    await expect(phone.getByRole("article", { name: names.typedName })).toBeVisible();
  });
});
