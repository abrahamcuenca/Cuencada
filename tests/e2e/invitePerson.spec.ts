/**
 * Journey 12 (WP-4.2): an admin invites a tree person by email from their
 * page in the tree; the invitee accepts from the email and their account is
 * linked to that person (same place in the tree, no duplicate person).
 */
import { familyNames, invitedPerson } from "./harness/people.js";
import { appLinkIn, waitForMail } from "./support/mail.js";
import { CastRole, docShot, expect, journeyShot, login, test } from "./support/fixtures.js";

test.describe("invites linked to tree people", () => {
  test("12 · admin invites a tree person by email; the invitee accepts and is linked to that person @desktop", async ({
    page,
    cast,
    project,
    newPhone
  }, testInfo) => {
    const person = invitedPerson(project);
    const { parent } = familyNames(project);

    // The admin finds the person and opens them in the tree.
    await login(page, cast(CastRole.Admin));
    await page.goto("/admin/familia");
    await page.getByRole("searchbox", { name: "Buscar persona" }).fill(person.fullName);
    await page.getByRole("region", { name: "Lista de personas" }).getByRole("link", { name: new RegExp(person.fullName) }).click();
    await page.getByRole("link", { name: "Ver en el árbol" }).click();
    await expect(page.getByRole("article", { name: person.fullName })).toBeVisible();

    // "Invitar" opens the form pre-filled with the person.
    await page.getByRole("link", { name: `Invitar a ${person.fullName}` }).click();
    await expect(page).toHaveURL(/\/admin\/invitaciones\?persona=/);
    const form = page.getByRole("form", { name: "Nueva invitación" });
    await expect(form.getByText(person.fullName)).toBeVisible();
    await form.getByRole("textbox", { name: "Correo" }).fill(person.email);
    await docShot(page, testInfo, "t8", "invite-person-form", form.getByRole("button", { name: "Quitar persona" }));
    const since = new Date();
    await form.getByRole("button", { name: "Enviar invitación" }).click();
    await expect(page.getByText(/Enviamos la invitación/)).toBeVisible();
    const card = page.getByRole("article", { name: person.email });
    await expect(card).toContainText(`Para: ${person.fullName}`);
    await docShot(page, testInfo, "t8", "invite-person-list", card);

    // The invitee accepts from the email on their phone.
    const mail = await waitForMail({ to: person.email, category: "invite", since });
    const phone = await newPhone();
    await phone.goto(appLinkIn(mail, "/invitacion"));
    await expect(phone).toHaveURL(/\/invitacion$/);
    await phone.getByRole("textbox", { name: "Nombre completo" }).fill(person.typedName);
    await phone.getByRole("textbox", { name: "Correo electrónico" }).fill(person.email);
    await phone.getByRole("textbox", { name: "Crea una contraseña" }).fill("Invitada-e2e-segura-2027");
    await phone.getByRole("textbox", { name: "Confirma tu contraseña" }).fill("Invitada-e2e-segura-2027");
    await phone.getByRole("button", { name: /Crear (mi )?cuenta/ }).click();
    await expect(phone).toHaveURL(/\/$/);

    // Their tree opens on the existing person, with the parent already there.
    await phone.goto("/arbol");
    await expect(phone.getByRole("article", { name: person.fullName })).toBeVisible();
    await expect(phone.getByRole("region", { name: "Padres" }).getByRole("button", { name: `Ver a ${parent}` })).toBeVisible();
    await journeyShot(phone, testInfo, "12-invited-person-tree");

    // No duplicate person, and the button is gone for the admin.
    await page.goto("/admin/familia");
    await page.getByRole("searchbox", { name: "Buscar persona" }).fill(person.fullName);
    const list = page.getByRole("region", { name: "Lista de personas" });
    await expect(list.getByRole("link", { name: new RegExp(person.fullName) })).toHaveCount(1);
    await expect(list.getByRole("link", { name: new RegExp(person.typedName) })).toHaveCount(0);
    await list.getByRole("link", { name: new RegExp(person.fullName) }).click();
    await page.getByRole("link", { name: "Ver en el árbol" }).click();
    await expect(page.getByRole("article", { name: person.fullName })).toBeVisible();
    await expect(page.getByRole("link", { name: `Invitar a ${person.fullName}` })).toHaveCount(0);
  });
});
