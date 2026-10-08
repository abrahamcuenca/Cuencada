/**
 * Journey 13 (WP-4.1): family editing. An admin adds Beto's wife, daughter
 * and mother (no accounts), then the mother's parents and two more
 * generations up; Beto (a member) adds his own child; the admin sees it in
 * "Actividad del árbol" and undoes it. Fictional people only.
 */
import type { Page } from "@playwright/test";
import { familyEditingNames } from "./harness/people.js";
import { CastRole, docShot, expect, login, test } from "./support/fixtures.js";

/** Open the sheet for `label`, create `name` (admins go through "Crear nueva persona"), and wait for the toast. */
async function addRelative(page: Page, label: string, name: string, options: { admin: boolean; deceased?: boolean }): Promise<void> {
  await page.getByRole("button", { name: label }).click();
  const sheet = page.getByRole("dialog", { name: label });
  await expect(sheet).toBeVisible();
  if (options.admin) {
    await sheet.getByRole("searchbox", { name: "Buscar persona" }).fill(name);
    await sheet.getByRole("button", { name: "Crear nueva persona" }).click();
    await expect(sheet.getByLabel(/^Nombre completo/)).toHaveValue(name);
  } else {
    await sheet.getByLabel(/^Nombre completo/).fill(name);
  }
  if (options.deceased === true) await sheet.getByLabel("Ya falleció").check({ force: true });
  await sheet.getByRole("button", { name: "Crear nueva persona" }).click();
  await expect(page.getByText(`Agregamos a ${name}.`)).toBeVisible();
  await expect(sheet).toBeHidden();
}

/** Re-centre the tree on a relative shown in a band. */
async function openRelative(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: new RegExp(`^Ver a ${name}`) }).first().click();
  await expect(page.getByRole("article", { name: new RegExp(`^${name}`) })).toBeVisible();
}

test.describe("family editing", () => {
  test("13 · an admin builds Beto's family up to his great-great-grandparents; a member adds a child; the admin undoes it @desktop", async ({
    page,
    cast,
    project,
    newPhone
  }, testInfo) => {
    test.setTimeout(150_000);
    const names = familyEditingNames(project);
    const beto = cast(CastRole.Beto);

    // The admin finds Beto in the tree.
    await login(page, cast(CastRole.Admin));
    await page.goto("/arbol");
    await page.getByRole("searchbox", { name: "Buscar a un familiar" }).fill(beto.displayName);
    await page.getByRole("button", { name: `Ver a ${beto.displayName}` }).click();
    await expect(page.getByRole("article", { name: beto.displayName })).toBeVisible();
    await docShot(page, testInfo, "t6", "editar-arbol", page.getByRole("region", { name: "Padres" }));

    await addRelative(page, "Agregar pareja", names.wife, { admin: true });
    await page.getByRole("button", { name: "Agregar hijo/a" }).click();
    const sheet = page.getByRole("dialog", { name: "Agregar hijo/a" });
    await sheet.getByRole("searchbox", { name: "Buscar persona" }).fill(names.daughter);
    await docShot(page, testInfo, "t6", "agregar-admin", sheet);
    await sheet.getByRole("button", { name: "Crear nueva persona" }).click();
    await docShot(page, testInfo, "t6", "agregar-formulario", sheet.getByLabel(/^Nombre completo/));
    await sheet.getByRole("button", { name: "Crear nueva persona" }).click();
    await expect(page.getByText(`Agregamos a ${names.daughter}.`)).toBeVisible();
    await addRelative(page, "Agregar padre o madre", names.mother, { admin: true });
    await expect(page.getByRole("region", { name: /^Pareja/ }).getByRole("button", { name: `Ver a ${names.wife}` })).toBeVisible();
    await expect(page.getByRole("region", { name: /^Hijos/ }).getByRole("button", { name: `Ver a ${names.daughter}` })).toBeVisible();
    // Two parents now: no third.
    await expect(page.getByRole("button", { name: "Agregar padre o madre" })).toHaveCount(0);

    // Up the mother's line: her parents, then two more generations.
    await openRelative(page, names.mother);
    await addRelative(page, "Agregar padre o madre", names.grandfather, { admin: true, deceased: true });
    await addRelative(page, "Agregar padre o madre", names.grandmother, { admin: true, deceased: true });
    await openRelative(page, names.grandfather);
    await addRelative(page, "Agregar padre o madre", names.greatGrandparent, { admin: true, deceased: true });
    await openRelative(page, names.greatGrandparent);
    await addRelative(page, "Agregar padre o madre", names.greatGreatGrandparent, { admin: true, deceased: true });

    // Back on Beto, "Ver más" reaches four generations up.
    await page.getByRole("navigation", { name: "Personas visitadas" }).getByRole("button", { name: beto.displayName }).click();
    await expect(page.getByRole("article", { name: beto.displayName })).toBeVisible();
    await page.getByRole("button", { name: "Ver más: abuelos y nietos" }).click();
    await expect(page.getByRole("region", { name: /^Tatarabuelos/ }).getByRole("button", { name: new RegExp(names.greatGreatGrandparent) })).toBeVisible();
    await expect(page.getByRole("region", { name: /^Bisabuelos/ }).getByRole("button", { name: new RegExp(names.greatGrandparent) })).toBeVisible();
    await docShot(page, testInfo, "t6", "tatarabuelos", page.getByRole("region", { name: /^Tatarabuelos/ }));

    // Beto, a member, adds his own child (no search: members only create).
    const betoPhone = await newPhone();
    await login(betoPhone, beto);
    await betoPhone.goto("/arbol");
    await expect(betoPhone.getByRole("article", { name: beto.displayName })).toBeVisible();
    await betoPhone.getByRole("button", { name: "Agregar hijo/a" }).click();
    const memberSheet = betoPhone.getByRole("dialog", { name: "Agregar hijo/a" });
    await expect(memberSheet.getByText("¿Ya está en el árbol? Pídele a un administrador que los conecte.")).toBeVisible();
    await expect(memberSheet.getByRole("searchbox")).toHaveCount(0);
    await memberSheet.getByLabel(/^Nombre completo/).fill(names.memberChild);
    await memberSheet.getByLabel(/^Año de nacimiento/).fill("2020");
    await docShot(betoPhone, testInfo, "t6", "agregar-miembro", memberSheet.getByLabel(/^Nombre completo/));
    await memberSheet.getByRole("button", { name: "Crear nueva persona" }).click();
    await expect(betoPhone.getByText(`Agregamos a ${names.memberChild}.`)).toBeVisible();
    await expect(betoPhone.getByRole("region", { name: /^Hijos/ }).getByRole("button", { name: `Ver a ${names.memberChild}` })).toBeVisible();

    // The new child's details: the member who added it can edit or remove it.
    await openRelative(betoPhone, names.memberChild);
    await betoPhone.getByText("Detalles").click();
    await expect(betoPhone.getByText("2020", { exact: true })).toBeVisible();
    await expect(betoPhone.getByRole("button", { name: "Eliminar" })).toBeVisible();
    await docShot(betoPhone, testInfo, "t6", "detalles", betoPhone.getByText("Detalles"));

    // The admin sees it in "Actividad del árbol" and undoes it.
    await page.goto("/admin");
    await page.getByRole("link", { name: /Actividad del árbol/ }).first().click();
    await expect(page.getByRole("heading", { name: "Actividad del árbol", level: 1 })).toBeVisible();
    const changes = page.getByRole("region", { name: "Cambios" });
    const undo = changes.getByRole("button", { name: `Deshacer: Agregó a una persona de ${names.memberChild}` });
    await expect(undo).toBeVisible();
    await docShot(page, testInfo, "t6", "actividad", undo);
    await undo.click();
    await expect(page.getByText("Deshicimos el cambio.")).toBeVisible();
    await expect(undo).toHaveCount(0);

    // Gone from Beto's tree.
    await betoPhone.goto("/arbol");
    await expect(betoPhone.getByRole("article", { name: beto.displayName })).toBeVisible();
    await expect(betoPhone.getByRole("region", { name: /^Hijos/ }).getByRole("button", { name: `Ver a ${names.memberChild}` })).toHaveCount(0);
    await expect(betoPhone.getByRole("region", { name: /^Hijos/ }).getByRole("button", { name: `Ver a ${names.daughter}` })).toBeVisible();

    // The admin's per-person history shows the mother's additions.
    await page.goto("/admin/familia");
    await page.getByRole("searchbox", { name: "Buscar persona" }).fill(names.mother);
    await page.getByRole("region", { name: "Lista de personas" }).getByRole("link", { name: new RegExp(names.mother) }).click();
    await page.getByRole("tab", { name: "Historial" }).click();
    await expect(page.getByRole("region", { name: "Historial" }).getByText("Agregó a una persona")).toBeVisible();
    await docShot(page, testInfo, "t6", "historial", page.getByRole("region", { name: "Historial" }));
  });
});
