/**
 * Journey 7: family tree navigation (re-centre on a relative and back via
 * the breadcrumbs) and an admin adding a relationship that members then see.
 */
import { familyNames } from "./harness/people.js";
import { CastRole, expect, journeyShot, login, test } from "./support/fixtures.js";

test.describe("family tree", () => {
  test("7 · navigate and re-centre the tree; an admin adds a partner and the member sees it @desktop", async ({
    page,
    cast,
    project,
    newPhone
  }, testInfo) => {
    const { parent, partner } = familyNames(project);
    const ana = cast(CastRole.Ana);
    const beto = cast(CastRole.Beto);

    await login(page, ana);
    await page.goto("/arbol");
    await expect(page.getByRole("heading", { name: "Árbol familiar", level: 1 })).toBeVisible();
    await expect(page.getByRole("article", { name: ana.displayName })).toBeVisible();
    await expect(page.getByRole("region", { name: "Padres" }).getByRole("button", { name: `Ver a ${parent}` })).toBeVisible();
    await expect(page.getByRole("region", { name: /Hermanos/ }).getByRole("button", { name: `Ver a ${beto.displayName}` })).toBeVisible();
    await journeyShot(page, testInfo, "07-tree-me");

    // Re-centre on the parent: Ana and Beto are now the children.
    await page.getByRole("button", { name: `Ver a ${parent}` }).click();
    await expect(page.getByRole("article", { name: parent })).toBeVisible();
    const children = page.getByRole("region", { name: "Hijos" });
    await expect(children.getByRole("button", { name: `Ver a ${ana.displayName}` })).toBeVisible();
    await expect(children.getByRole("button", { name: `Ver a ${beto.displayName}` })).toBeVisible();
    await expect(page.getByRole("region", { name: /Parejas?/ }).getByText("Aún no hay pareja registrada.")).toBeVisible();

    // Back to Ana through the breadcrumbs.
    await page.getByRole("navigation", { name: "Personas visitadas" }).getByRole("button", { name: ana.displayName }).click();
    await expect(page.getByRole("article", { name: ana.displayName })).toBeVisible();

    // An admin links the parent and the partner.
    const adminPhone = await newPhone();
    await login(adminPhone, cast(CastRole.Admin));
    await adminPhone.goto("/admin/familia");
    await adminPhone.getByRole("searchbox", { name: "Buscar persona" }).fill(parent);
    await adminPhone.getByRole("region", { name: "Lista de personas" }).getByRole("link", { name: new RegExp(parent) }).click();
    await adminPhone.getByRole("button", { name: "Agregar pareja" }).click();
    const picker = adminPhone.getByRole("dialog", { name: "Agregar pareja" });
    await picker.getByRole("searchbox", { name: "Buscar persona" }).fill(partner);
    await picker.getByRole("button", { name: `Elegir a ${partner}` }).click();
    await expect(adminPhone.getByText(`Agregamos a ${partner}.`)).toBeVisible();
    await journeyShot(adminPhone, testInfo, "07-admin-relationship");

    // The member sees the new partner after re-centring on the parent.
    await page.reload();
    await page.getByRole("button", { name: `Ver a ${parent}` }).click();
    await expect(page.getByRole("region", { name: "Pareja" }).getByRole("button", { name: `Ver a ${partner}` })).toBeVisible();
    await journeyShot(page, testInfo, "07-tree-parent");
  });
});
