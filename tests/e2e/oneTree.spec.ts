/**
 * Journey 18 (WP-6.4): one family tree. A cousin built his branch apart
 * from the root's tree, so his grandmother exists twice. The admin sets the
 * root and sees the branch in "Ramas sin conectar"; the cousin proposes
 * "Es la misma persona"; the admin approves it (the merge runs); the branch
 * is gone from the report and the cousin's "Primos" band shows his cousins.
 * Fictional people only.
 *
 * The root ancestor is a single global setting, so this journey runs in one
 * project only (the iPhone one); it also takes the 1280 px doc shots there.
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { castMember, cousinBranchNames, familyNames, ProjectKey } from "./harness/people.js";
import { REPO_ROOT } from "./harness/settings.js";
import { CastRole, expect, login, test } from "./support/fixtures.js";

type SharpFactory = (input: Buffer) => { resize(width: number): { webp(options: { quality: number }): { toFile(path: string): Promise<unknown> } } };

/** `docs/ux/screenshots/wp64/<name>-<width>.webp` at 375 and 1280 px, only with `E2E_UPDATE_DOCS=1`. */
async function shots(page: Page, testInfo: TestInfo, name: string, focus?: Locator): Promise<void> {
  if (process.env.E2E_UPDATE_DOCS !== "1" || testInfo.project.name !== ProjectKey.Iphone) return;
  const previous = page.viewportSize();
  const out = join(REPO_ROOT, "docs/ux/screenshots/wp64");
  mkdirSync(out, { recursive: true });
  const sharp = createRequire(join(REPO_ROOT, "apps/server/package.json"))("sharp") as SharpFactory; // CJS export: a callable factory
  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 800 });
    await page.waitForTimeout(400);
    if (focus !== undefined) await focus.evaluate((element) => element.scrollIntoView({ block: "center", behavior: "instant" }));
    await page.waitForTimeout(300);
    const png = await page.screenshot({ animations: "disabled" });
    await sharp(png).resize(width === 375 ? 750 : 1280).webp({ quality: 80 }).toFile(join(out, `${name}-${width}.webp`));
  }
  if (previous !== null) await page.setViewportSize(previous);
}

test.describe("one family tree", () => {
  test("18 · a cousin's duplicate grandmother: he proposes «Es la misma persona», the admin approves, one connected tree", async ({
    page,
    project,
    newPhone
  }, testInfo) => {
    test.skip(project !== ProjectKey.Iphone, "the root ancestor is global: one project runs this journey");
    test.setTimeout(240_000);
    const family = familyNames(project);
    const branch = cousinBranchNames(project);
    const admin = castMember(project, CastRole.Admin);
    const cousin = castMember(project, CastRole.Primo);
    const ana = castMember(project, CastRole.Ana);
    const beto = castMember(project, CastRole.Beto);

    // The admin sets the root ancestor: the cousin's branch shows as disconnected, with a match.
    await login(page, admin);
    await page.goto("/admin/familia/ramas");
    const root = page.getByRole("region", { name: "Raíz del árbol" });
    await root.getByRole("button", { name: /^(Elegir|Cambiar) la raíz$/ }).click();
    const picker = page.getByRole("dialog", { name: "Raíz del árbol" });
    await picker.getByRole("searchbox", { name: "Buscar persona" }).fill(family.greatGrandparent);
    await picker.getByRole("button", { name: new RegExp(`^Elegir a ${family.greatGrandparent}`) }).click();
    await expect(root.getByText(family.greatGrandparent, { exact: true })).toBeVisible();
    const cousinBranch = page.getByRole("article").filter({ hasText: branch.father });
    await expect(cousinBranch).toBeVisible();
    await expect(cousinBranch.getByRole("button", { name: `Revisar fusión: ${branch.grandparentCopy} con ${family.grandparent}` })).toBeVisible();
    await shots(page, testInfo, "ramas-sin-conectar", cousinBranch);

    // The cousin is not connected to the root: the CTA invites him to propose a connection.
    const phone = await newPhone();
    await login(phone, cousin);
    await phone.goto("/arbol");
    await expect(phone.getByRole("article", { name: branch.cousin })).toBeVisible();
    await expect(phone.getByRole("complementary", { name: "¿No ves a tu familia? Propón una conexión" })).toBeVisible();

    // He opens his grandmother (his copy) and proposes "Es la misma persona…" with the one in the main tree.
    await phone.getByRole("region", { name: "Padres" }).getByRole("button", { name: `Ver a ${branch.father}` }).click();
    await phone.getByRole("region", { name: "Padres" }).getByRole("button", { name: `Ver a ${branch.grandparentCopy}, ya falleció` }).click();
    await expect(phone.getByRole("article", { name: branch.grandparentCopy })).toBeVisible();
    await phone.getByRole("button", { name: "Es la misma persona…" }).click();
    const sheet = phone.getByRole("dialog", { name: "Es la misma persona…" });
    await sheet.getByRole("searchbox", { name: "Buscar a la otra persona" }).fill(branch.grandparentCopy);
    await sheet.getByRole("button", { name: `Elegir a ${family.grandparent}, ya falleció`, exact: true }).click();
    await sheet.getByRole("textbox", { name: /Nota para el administrador/ }).fill("Es mi abuela; la agregué antes de ver el árbol de mis primos.");
    await shots(phone, testInfo, "propuesta-misma-persona", sheet);
    await sheet.getByRole("button", { name: "Enviar propuesta" }).click();
    await expect(phone.getByText(/Enviamos tu propuesta/)).toBeVisible();
    await phone.goto("/arbol/propuestas");
    const mine = phone.getByRole("article", { name: `${family.grandparent} es la misma persona que ${family.grandparent}` });
    await expect(mine.getByText("Pendiente")).toBeVisible();

    // The admin approves it from "Propuestas del árbol": the merge runs.
    await page.goto("/admin/familia/propuestas");
    const card = page.getByRole("article", { name: `${family.grandparent} es la misma persona que ${family.grandparent}` });
    await expect(card.getByText("Es mi abuela; la agregué antes de ver el árbol de mis primos.")).toBeVisible();
    await shots(page, testInfo, "propuestas-del-arbol", card);
    await card.getByRole("button", { name: "Aprobar…" }).click();
    const approve = page.getByRole("dialog", { name: "Aprobar propuesta" });
    await expect(approve.getByText(/relación pasa|relaciones pasan/)).toBeVisible();
    await approve.getByRole("textbox", { name: /Nota para quien propuso/ }).fill("¡Listo! Ya están unidas las dos ramas.");
    await approve.getByRole("button", { name: "Aprobar y fusionar" }).click();
    await expect(page.getByText("Aprobamos la propuesta: el árbol ya está unido.")).toBeVisible();

    // "Ramas sin conectar" no longer lists the cousin's branch.
    await page.goto("/admin/familia/ramas");
    await expect(page.getByRole("heading", { name: "Ramas que no llegan a la raíz" })).toBeVisible();
    await expect(page.getByRole("article").filter({ hasText: branch.father })).toHaveCount(0);

    // The cousin: approved, with the admin's note; connected (no CTA); Primos shows his cousins.
    await phone.goto("/arbol/propuestas");
    await expect(mine.getByText("Aprobada")).toBeVisible();
    await expect(mine.getByText("¡Listo! Ya están unidas las dos ramas.")).toBeVisible();
    await phone.goto("/arbol");
    await expect(phone.getByRole("article", { name: branch.cousin })).toBeVisible();
    const primos = phone.locator("details").filter({ has: phone.getByText(/^Primos \(\d+\)$/) });
    await primos.locator("summary").click();
    await expect(primos.getByRole("button", { name: `Ver a ${ana.displayName}` })).toBeVisible();
    await expect(primos.getByRole("button", { name: `Ver a ${beto.displayName}` })).toBeVisible();
    await expect(phone.getByRole("complementary", { name: "¿No ves a tu familia? Propón una conexión" })).toHaveCount(0);
    await shots(phone, testInfo, "bandas-primos", primos);

    // "Árbol completo": "Ir a mí" opens the path from the root down to him.
    await phone.goto("/arbol/completo");
    await expect(phone.getByRole("link", { name: new RegExp(`^${family.greatGrandparent}`) })).toBeVisible();
    await phone.getByRole("button", { name: "Ir a mí" }).click();
    await expect(phone.getByRole("link", { name: new RegExp(`^${branch.cousin}`) })).toBeFocused();
    await shots(phone, testInfo, "arbol-completo", phone.getByRole("link", { name: new RegExp(`^${branch.cousin}`) }));
  });
});
