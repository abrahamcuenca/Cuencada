import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { apiUrl, authenticatedState, errorBody } from "../../../test/auth";
import { createTestServer } from "../../../test/msw";
import { renderApp } from "../../../test/renderApp";
import { ADMIN_USER, type AdminDb, adminHandlers, IDS, makeAdminDb, writes } from "./testing/fixtures";

const server = createTestServer();
let db: AdminDb;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  db = makeAdminDb();
  server.use(...adminHandlers(db));
});
afterEach(() => server.resetHandlers());

async function openSheet(user: ReturnType<typeof userEvent.setup>, name: string): Promise<HTMLElement> {
  await user.click(await screen.findByRole("button", { name: new RegExp(`^${name}`) }));
  return screen.findByRole("dialog", { name: new RegExp(`^${name}`) });
}

describe("UsersPage", { timeout: 15_000 }, () => {
  it("searches and filters through the API", async () => {
    const user = userEvent.setup();
    const { router } = renderApp("/admin/usuarios?estado=disabled", authenticatedState(ADMIN_USER));

    expect(await screen.findByRole("button", { name: /^Mateo Ortega Vidal/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Lucía Ramírez Soto/ })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Estado" })).toHaveValue("disabled");

    await user.selectOptions(screen.getByRole("combobox", { name: "Estado" }), "");
    await user.selectOptions(screen.getByRole("combobox", { name: "Rol" }), "member");
    await waitFor(() => expect(router.state.location.search).toBe("?rol=member"));
    await user.type(screen.getByRole("searchbox", { name: "Buscar por nombre o correo" }), "lucía");

    expect(await screen.findByRole("button", { name: /^Lucía Ramírez Soto/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Mateo Ortega Vidal/ })).not.toBeInTheDocument());
    expect(db.log.at(-1)).toMatchObject({ path: "/admin/users", query: { q: "lucía", role: "member", limit: "25" } });
  });

  it("filters unverified emails with ?correo=sin-verificar (emailVerified=false)", async () => {
    const user = userEvent.setup();
    const { router } = renderApp("/admin/usuarios?correo=sin-verificar", authenticatedState(ADMIN_USER));

    expect(await screen.findByRole("button", { name: /^Lucía Ramírez Soto/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Mateo Ortega Vidal/ })).not.toBeInTheDocument();
    expect(db.log.at(-1)).toMatchObject({ path: "/admin/users", query: { emailVerified: "false" } });
    expect(screen.getByRole("combobox", { name: "Correo" })).toHaveValue("sin-verificar");

    await user.selectOptions(screen.getByRole("combobox", { name: "Correo" }), "");
    await waitFor(() => expect(router.state.location.search).toBe(""));
    expect(await screen.findByRole("button", { name: /^Mateo Ortega Vidal/ })).toBeInTheDocument();
  });

  it("shows the server's Spanish message for the per-account change limit (429)", async () => {
    server.use(
      http.patch(apiUrl("/admin/users/:id"), () =>
        HttpResponse.json(errorBody("RATE_LIMITED", "Esta cuenta ya cambió 3 veces en la última hora. Espera un poco."), { status: 429 })
      )
    );
    const user = userEvent.setup();
    renderApp("/admin/usuarios", authenticatedState(ADMIN_USER));
    const sheet = await openSheet(user, "Lucía Ramírez Soto");

    await user.click(within(sheet).getByRole("button", { name: "Deshabilitar cuenta" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Deshabilitar cuenta" }));

    expect(await within(sheet).findByText("Esta cuenta ya cambió 3 veces en la última hora. Espera un poco.")).toBeInTheDocument();
  });

  it("disables an account only after a confirmation that explains the consequences", async () => {
    const user = userEvent.setup();
    renderApp("/admin/usuarios", authenticatedState(ADMIN_USER));
    const sheet = await openSheet(user, "Lucía Ramírez Soto");

    await user.click(within(sheet).getByRole("button", { name: "Deshabilitar cuenta" }));
    const confirm = await screen.findByRole("alertdialog", { name: "¿Deshabilitar la cuenta de Lucía Ramírez Soto?" });
    expect(confirm).toHaveTextContent("Se cerrarán todas sus sesiones");
    expect(confirm).not.toHaveTextContent("Los demás administradores");
    await user.click(within(confirm).getByRole("button", { name: "Cancelar" }));
    expect(writes(db)).toHaveLength(0);

    await user.click(within(sheet).getByRole("button", { name: "Deshabilitar cuenta" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Deshabilitar cuenta" }));

    await waitFor(() => expect(writes(db)).toEqual([expect.objectContaining({ method: "PATCH", path: `/admin/users/${IDS.lucia}`, body: { status: "disabled" } })]));
    expect(await within(sheet).findByText("Cuenta deshabilitada. Cerramos todas sus sesiones.")).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Habilitar cuenta" })).toBeInTheDocument();
    expect(within(sheet).getByText("Deshabilitada")).toBeInTheDocument();
  });

  it("shows the last-admin guardrail (409) in Spanish", async () => {
    const user = userEvent.setup();
    server.use(http.patch(apiUrl("/admin/users/:id"), () => HttpResponse.json(errorBody("CONFLICT", "conflict"), { status: 409 })));
    renderApp("/admin/usuarios", authenticatedState(ADMIN_USER));
    const sheet = await openSheet(user, "Lucía Ramírez Soto");

    await user.click(within(sheet).getByRole("button", { name: "Hacer administrador" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm).toHaveTextContent("Los demás administradores recibirán un aviso por correo.");
    await user.click(within(confirm).getByRole("button", { name: "Hacer administrador" }));

    expect(await within(sheet).findByRole("alert")).toHaveTextContent("Debe quedar al menos un administrador activo.");
  });

  it("shows the self-change guardrail (403) with the server's Spanish message", async () => {
    const user = userEvent.setup();
    server.use(
      http.patch(apiUrl("/admin/users/:id"), () =>
        HttpResponse.json(errorBody("FORBIDDEN", "Tu cuenta ya no tiene permisos de administración."), { status: 403 })
      )
    );
    renderApp("/admin/usuarios", authenticatedState(ADMIN_USER));
    const sheet = await openSheet(user, "Lucía Ramírez Soto");

    await user.click(within(sheet).getByRole("button", { name: "Deshabilitar cuenta" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Deshabilitar cuenta" }));

    expect(await within(sheet).findByRole("alert")).toHaveTextContent("Tu cuenta ya no tiene permisos de administración.");
  });

  it("disables the actions on the admin's own row and explains why", async () => {
    const user = userEvent.setup();
    db.users = db.users.map((row) => (row.id === IDS.admin ? { ...row, emailVerified: false } : row));
    renderApp("/admin/usuarios", authenticatedState(ADMIN_USER));

    expect(await screen.findByRole("button", { name: /^Elena Duarte Páez \(tú\)/ })).toBeInTheDocument();
    const sheet = await openSheet(user, "Elena Duarte Páez");
    expect(within(sheet).getByText(/Esta es tu cuenta/)).toBeInTheDocument();
    expect(within(sheet).getByRole("link", { name: "Mis sesiones" })).toHaveAttribute("href", "/perfil/sesiones");
    for (const name of [
      "Quitar rol de administrador",
      "Cerrar sesiones",
      "Forzar cambio de contraseña",
      "Marcar correo como verificado",
      "Deshabilitar cuenta"
    ]) {
      expect(within(sheet).getByRole("button", { name })).toBeDisabled();
    }
  });

  it("revokes every session after confirming", async () => {
    const user = userEvent.setup();
    renderApp("/admin/usuarios", authenticatedState(ADMIN_USER));
    const sheet = await openSheet(user, "Lucía Ramírez Soto");

    await user.click(within(sheet).getByRole("button", { name: "Cerrar sesiones" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm).toHaveTextContent("3 activas");
    await user.click(within(confirm).getByRole("button", { name: "Cerrar sesiones" }));

    await waitFor(() => expect(writes(db)).toEqual([expect.objectContaining({ path: `/admin/users/${IDS.lucia}/revoke-sessions` })]));
    expect(await within(sheet).findByText("Cerramos todas sus sesiones.")).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Cerrar sesiones" })).toBeDisabled();
  });

  it("forces a password reset and says the email was sent", async () => {
    const user = userEvent.setup();
    renderApp("/admin/usuarios", authenticatedState(ADMIN_USER));
    const sheet = await openSheet(user, "Lucía Ramírez Soto");

    await user.click(within(sheet).getByRole("button", { name: "Forzar cambio de contraseña" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Forzar cambio" }));

    expect(await within(sheet).findByText(/le enviamos un correo para elegir una contraseña nueva/)).toBeInTheDocument();
    expect(within(sheet).getByText("Debe cambiar su contraseña")).toBeInTheDocument();
    expect(writes(db)).toEqual([expect.objectContaining({ path: `/admin/users/${IDS.lucia}/force-password-reset` })]);
  });

  it("forces a password reset and warns when no email was queued", async () => {
    const user = userEvent.setup();
    db.emailQueued = false;
    renderApp("/admin/usuarios", authenticatedState(ADMIN_USER));
    const sheet = await openSheet(user, "Mateo Ortega Vidal");

    await user.click(within(sheet).getByRole("button", { name: "Forzar cambio de contraseña" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Forzar cambio" }));

    expect(await within(sheet).findByText(/no se envió el correo/)).toBeInTheDocument();
    expect(within(sheet).getByText(/Avísale por otro medio/)).toBeInTheDocument();
  });

  it("marks an email as verified by hand", async () => {
    const user = userEvent.setup();
    renderApp("/admin/usuarios", authenticatedState(ADMIN_USER));
    const sheet = await openSheet(user, "Lucía Ramírez Soto");

    expect(within(sheet).getByText("Correo sin verificar")).toBeInTheDocument();
    await user.click(within(sheet).getByRole("button", { name: "Marcar correo como verificado" }));

    await waitFor(() => expect(writes(db)).toEqual([expect.objectContaining({ path: `/admin/users/${IDS.lucia}/verify-email` })]));
    expect(await within(sheet).findByText("Marcamos su correo como verificado.")).toBeInTheDocument();
    expect(within(sheet).queryByText("Correo sin verificar")).not.toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: "Marcar correo como verificado" })).not.toBeInTheDocument();
  });

  it("links to the person's activity in the audit log", async () => {
    const user = userEvent.setup();
    renderApp("/admin/usuarios", authenticatedState(ADMIN_USER));
    const sheet = await openSheet(user, "Lucía Ramírez Soto");

    expect(within(sheet).getByRole("link", { name: "Ver su actividad en la bitácora" })).toHaveAttribute("href", `/admin/bitacora?actor=${IDS.lucia}`);
  });
});
