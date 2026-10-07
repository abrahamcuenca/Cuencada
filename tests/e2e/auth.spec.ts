/**
 * Journeys 1, 2, 3 and 9: first admin login, invites (+ email
 * verification), magic link (+ the "sesión abierta" interstitial) and
 * logout everywhere.
 */
import { inviteeEmail, inviteeName, NEW_ADMIN_PASSWORD } from "./harness/people.js";
import { appLinkIn, waitForMail } from "./support/mail.js";
import { CastRole, expect, journeyShot, login, test } from "./support/fixtures.js";

test.describe("auth journeys", () => {
  test("1 · admin first login forces a password change, then opens the console @desktop", async ({ page, cast }, testInfo) => {
    const admin = cast(CastRole.FirstLoginAdmin);
    await page.goto("/entrar");
    await page.getByRole("textbox", { name: "Correo electrónico" }).fill(admin.email);
    await page.getByRole("textbox", { name: "Contraseña", exact: true }).fill(admin.password);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();

    await expect(page).toHaveURL(/\/cambiar-contrasena/);
    await expect(page.getByRole("heading", { name: "Cambia tu contraseña" })).toBeVisible();
    await journeyShot(page, testInfo, "01-forced-password-change");

    // Member and admin pages stay locked until the password changes.
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/cambiar-contrasena/);

    await page.getByRole("textbox", { name: "Contraseña temporal" }).fill(admin.password);
    await page.getByRole("textbox", { name: "Nueva contraseña" }).fill(NEW_ADMIN_PASSWORD);
    await page.getByRole("textbox", { name: "Confirma la nueva" }).fill(NEW_ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Guardar y continuar" }).click();
    await expect(page.getByText("Contraseña actualizada.")).toBeVisible();
    await expect(page).not.toHaveURL(/\/cambiar-contrasena/);

    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Panel de administración", level: 1 })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Secciones de administración" })).toBeVisible();
    await journeyShot(page, testInfo, "01-admin-console");

    // The temporary password no longer works.
    const response = await page.request.post("/api/auth/login", { data: { email: admin.email, password: admin.password } });
    expect(response.status()).toBe(401);
  });

  test("2 · admin invites a member by email; the member accepts from the email and lands logged in", async ({
    page,
    cast,
    project,
    newPhone
  }, testInfo) => {
    await login(page, cast(CastRole.Admin));
    await page.goto("/admin/invitaciones");
    await page.getByRole("button", { name: "Invitar" }).click();
    const form = page.getByRole("form", { name: "Nueva invitación" });
    await form.getByRole("radio", { name: /Por correo/ }).check();
    await form.getByRole("textbox", { name: "Correo" }).fill(inviteeEmail(project));
    await journeyShot(page, testInfo, "02-invite-form");
    const since = new Date();
    await form.getByRole("button", { name: "Enviar invitación" }).click();
    await expect(page.getByText(/Enviamos la invitación/)).toBeVisible();

    const mail = await waitForMail({ to: inviteeEmail(project), category: "invite", since });
    const link = appLinkIn(mail, "/invitacion");

    const phone = await newPhone();
    await phone.goto(link);
    // The token is scrubbed from the address bar at boot.
    await expect(phone).toHaveURL(/\/invitacion$/);
    await phone.getByRole("textbox", { name: "Nombre completo" }).fill(inviteeName(project));
    await phone.getByRole("textbox", { name: "Correo electrónico" }).fill(inviteeEmail(project));
    await phone.getByRole("textbox", { name: "Crea una contraseña" }).fill("Invitada-e2e-segura-2027");
    await phone.getByRole("textbox", { name: "Confirma tu contraseña" }).fill("Invitada-e2e-segura-2027");
    await journeyShot(phone, testInfo, "02-invite-accept");
    await phone.getByRole("button", { name: /Crear (mi )?cuenta/ }).click();

    await expect(phone).toHaveURL(/\/$/);
    await expect(phone.getByRole("button", { name: "Salir" })).toBeVisible();
    // An emailed invite proves the address: no "Verifica tu correo" banner.
    await expect(phone.getByRole("region", { name: "Verifica tu correo" })).toHaveCount(0);

    // The invite shows as accepted for the admin.
    await page.reload();
    await page.getByRole("combobox", { name: "Estado" }).selectOption({ label: "Aceptada" });
    await expect(page.getByText(inviteeEmail(project))).toBeVisible();
  });

  test("2b · a member who joined with a shared link verifies the email from the emailed link", async ({ page, cast, project, newPhone }, testInfo) => {
    await login(page, cast(CastRole.Admin));
    await page.goto("/admin/invitaciones");
    await page.getByRole("button", { name: "Invitar" }).click();
    const form = page.getByRole("form", { name: "Nueva invitación" });
    await form.getByRole("radio", { name: /Enlace para compartir/ }).check();
    await form.getByRole("spinbutton", { name: /¿Cuántas personas/ }).fill("1");
    await form.getByRole("button", { name: "Crear enlace" }).click();
    const link = await page.getByRole("textbox", { name: "Enlace de invitación" }).inputValue();
    expect(link).toContain("/invitacion#t=");

    const email = `enlace.${project}@e2e.example.test`;
    const phone = await newPhone();
    await phone.goto(link);
    await phone.getByRole("textbox", { name: "Nombre completo" }).fill(`Hugo ${cast(CastRole.Ana).displayName.split(" ")[1]}`);
    await phone.getByRole("textbox", { name: "Correo electrónico" }).fill(email);
    await phone.getByRole("textbox", { name: "Crea una contraseña" }).fill("Enlace-e2e-segura-2027");
    await phone.getByRole("textbox", { name: "Confirma tu contraseña" }).fill("Enlace-e2e-segura-2027");
    await phone.getByRole("button", { name: /Crear (mi )?cuenta/ }).click();
    await expect(phone.getByRole("button", { name: "Salir" })).toBeVisible();

    const banner = phone.getByRole("region", { name: "Verifica tu correo" });
    await expect(banner).toBeVisible();
    await journeyShot(phone, testInfo, "02-verify-banner");
    const since = new Date();
    await banner.getByRole("button", { name: "Reenviar enlace" }).click();
    const mail = await waitForMail({ to: email, category: "verify-email", since });

    await phone.goto(appLinkIn(mail, "/verificar"));
    await phone.getByRole("button", { name: "Confirmar mi correo" }).click();
    await expect(phone.getByRole("heading", { name: "Correo verificado" })).toBeVisible();
    await journeyShot(phone, testInfo, "02-email-verified");
    await phone.getByRole("link", { name: "Ir al inicio" }).click();
    await expect(phone.getByRole("region", { name: "Verifica tu correo" })).toHaveCount(0);
  });

  test("3 · magic link: request, open the email, tap Entrar; an open session gets the interstitial @desktop", async ({
    page,
    cast,
    newPhone
  }, testInfo) => {
    const dario = cast(CastRole.Dario);
    await page.goto("/entrar");
    await page.getByRole("textbox", { name: "Correo electrónico" }).fill(dario.email);
    const since = new Date();
    await page.getByRole("button", { name: "Recibir enlace por correo" }).click();
    await expect(page.getByRole("heading", { name: "Revisa tu correo" })).toBeVisible();
    await journeyShot(page, testInfo, "03-magic-link-requested");

    const mail = await waitForMail({ to: dario.email, category: "magic-link", since });
    const link = appLinkIn(mail, "/entrar/enlace");

    await page.goto(link);
    await expect(page).toHaveURL(/\/entrar\/enlace$/);
    await journeyShot(page, testInfo, "03-magic-link-entrar");
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await expect(page.getByRole("button", { name: "Salir" })).toBeVisible();
    await expect(page).toHaveURL(/\/$/);

    // The link is single-use.
    const phone = await newPhone();
    await phone.goto(link);
    await phone.getByRole("button", { name: "Entrar", exact: true }).click();
    await expect(phone.getByRole("heading", { name: "No pudimos abrir tu enlace" })).toBeVisible();

    // A link opened on a phone that is already logged in as someone else gets
    // the "sesión abierta" interstitial. (Beto's link: the per-recipient
    // budget allows one magic link per purpose every 2 minutes.)
    const beto = cast(CastRole.Beto);
    const requester = await newPhone();
    await requester.goto("/entrar");
    await requester.getByRole("textbox", { name: "Correo electrónico" }).fill(beto.email);
    const since2 = new Date();
    await requester.getByRole("button", { name: "Recibir enlace por correo" }).click();
    await expect(requester.getByRole("heading", { name: "Revisa tu correo" })).toBeVisible();
    const second = await waitForMail({ to: beto.email, category: "magic-link", since: since2 });

    const carla = cast(CastRole.Carla);
    await login(phone, carla);
    await phone.goto(appLinkIn(second, "/entrar/enlace"));
    await expect(phone.getByText(/Ya tienes la sesión abierta como/)).toBeVisible();
    await journeyShot(phone, testInfo, "03-session-open-interstitial");
    await phone.getByRole("button", { name: `Seguir como ${carla.displayName}` }).click();
    await expect(phone).toHaveURL(/\/$/);
    await expect(phone.getByRole("button", { name: "Salir" })).toBeVisible();
  });

  test("9 · logout everywhere ends the session on the other phone too @desktop", async ({ page, cast, newPhone }, testInfo) => {
    const elena = cast(CastRole.Elena);
    const other = await newPhone();
    await login(other, elena);
    await login(page, elena);

    await page.goto("/perfil/sesiones");
    await expect.poll(() => page.getByRole("list", { name: "Tus sesiones" }).getByRole("listitem").count()).toBeGreaterThanOrEqual(2);
    await journeyShot(page, testInfo, "09-sessions");
    await page.getByRole("button", { name: "Cerrar sesión en todos los dispositivos" }).click();
    const dialog = page.getByRole("alertdialog", { name: "¿Cerrar sesión en todos los dispositivos?" });
    await dialog.getByRole("button", { name: "Cerrar sesión en todos" }).click();
    await expect(page).toHaveURL(/\/entrar/);

    // The other phone still holds an access token in memory; its next API
    // call (an in-app navigation, no reload) is refused and it ends up anonymous.
    await other.getByRole("link", { name: /^Directorio/ }).first().click();
    await expect(other).toHaveURL(/\/entrar/);
    await expect(other.getByRole("button", { name: "Salir" })).toHaveCount(0);
  });
});
