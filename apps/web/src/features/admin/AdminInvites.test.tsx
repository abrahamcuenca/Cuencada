import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { apiUrl, authenticatedState, errorBody } from "../../../test/auth";
import { createTestServer } from "../../../test/msw";
import { renderApp } from "../../../test/renderApp";
import { whatsappShareHref } from "./components/InviteLinkBox";
import { ADMIN_USER, type AdminDb, adminHandlers, IDS, makeAdminDb, ONE_TIME_URL, writes } from "./testing/fixtures";

const server = createTestServer();
let db: AdminDb;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  db = makeAdminDb();
  server.use(...adminHandlers(db));
});
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});

async function openForm(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(await screen.findByRole("button", { name: /Invitar/ }));
  return screen.getByRole("form", { name: "Nueva invitación" });
}

describe("InvitesPage", { timeout: 15_000 }, () => {
  it("lists invites with status, expiry and last send", async () => {
    renderApp("/admin/invitaciones", authenticatedState(ADMIN_USER));

    const bound = await screen.findByRole("article", { name: "tomas.villa@example.com" });
    expect(bound).toHaveTextContent("Pendiente");
    expect(bound).toHaveTextContent(/Vence el .*2026/);
    expect(bound).toHaveTextContent(/Enviada por correo: .*2026/);
    const open = screen.getByRole("article", { name: "Enlace abierto" });
    expect(open).toHaveTextContent("Aceptada");
    expect(open).toHaveTextContent("Usos: 10 de 10");
    expect(open).toHaveTextContent("Nota: Grupo de primos");
  });

  it("filters by status through the URL", async () => {
    const user = userEvent.setup();
    const { router } = renderApp("/admin/invitaciones", authenticatedState(ADMIN_USER));

    await screen.findByRole("heading", { name: "tomas.villa@example.com" });
    await user.selectOptions(screen.getByRole("combobox", { name: "Estado" }), "accepted");
    await waitFor(() => expect(router.state.location.search).toBe("?estado=accepted"));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "tomas.villa@example.com" })).not.toBeInTheDocument());
    expect(db.log.at(-1)).toMatchObject({ path: "/admin/invites", query: { status: "accepted", limit: "25" } });
  });

  it("requires an email for an admin-role invite and only allows sending it by email", async () => {
    const user = userEvent.setup();
    renderApp("/admin/invitaciones", authenticatedState(ADMIN_USER));
    const form = await openForm(user);

    await user.click(within(form).getByRole("radio", { name: /Enlace para compartir/ }));
    await user.selectOptions(within(form).getByRole("combobox", { name: "Rol" }), "admin");
    expect(within(form).getByRole("radio", { name: /Por correo/ })).toBeChecked();
    expect(within(form).getByRole("radio", { name: /Enlace para compartir/ })).toBeDisabled();

    await user.click(within(form).getByRole("button", { name: "Enviar invitación" }));
    expect(await within(form).findByText("Una invitación de administrador debe ir a un correo.")).toBeInTheDocument();
    expect(writes(db)).toHaveLength(0);

    await user.type(within(form).getByRole("textbox", { name: /Correo/ }), "ana.prieto@example.com");
    await user.click(within(form).getByRole("button", { name: "Enviar invitación" }));
    await waitFor(() => expect(writes(db)).toHaveLength(1));
    expect(writes(db)[0]).toMatchObject({
      method: "POST",
      path: "/admin/invites",
      body: { email: "ana.prieto@example.com", role: "admin", maxUses: 1, expiresInDays: 7, sendEmail: true, note: null }
    });
    expect(await screen.findByText("Enviamos la invitación a ana.prieto@example.com.")).toBeInTheDocument();
    expect(screen.queryByText(/solo se muestra una vez/)).not.toBeInTheDocument();
  });

  it("defaults an open link to 5 uses and 72 hours and explains why", async () => {
    const user = userEvent.setup();
    renderApp("/admin/invitaciones", authenticatedState(ADMIN_USER));
    const form = await openForm(user);
    const help = "Por seguridad, los enlaces abiertos caducan en 72 horas y avisan a los administradores cada vez que alguien se une.";
    expect(within(form).queryByText(help)).not.toBeInTheDocument();

    await user.click(within(form).getByRole("radio", { name: /Enlace para compartir/ }));

    const uses = within(form).getByRole("spinbutton", { name: /Cuántas personas/ });
    const days = within(form).getByRole("spinbutton", { name: /Vence en/ });
    expect(uses).toHaveValue(5);
    expect(uses).toHaveAttribute("max", "10");
    expect(days).toHaveValue(3);
    expect(days).toHaveAttribute("max", "3");
    expect(within(form).getByText(help)).toBeInTheDocument();
    expect(within(form).getByText(/hasta 10 personas y 72 horas/)).toBeInTheDocument();
  });

  it("validates the open-invite limits before sending", async () => {
    const user = userEvent.setup();
    renderApp("/admin/invitaciones", authenticatedState(ADMIN_USER));
    const form = await openForm(user);

    await user.click(within(form).getByRole("radio", { name: /Enlace para compartir/ }));
    const uses = within(form).getByRole("spinbutton", { name: /Cuántas personas/ });
    await user.clear(uses);
    await user.type(uses, "11");
    const days = within(form).getByRole("spinbutton", { name: /Vence en/ });
    await user.clear(days);
    await user.type(days, "4");
    await user.click(within(form).getByRole("button", { name: "Crear enlace" }));

    expect(await within(form).findByText("Un enlace abierto admite como máximo 10 usos.")).toBeInTheDocument();
    expect(within(form).getByText("Un enlace abierto dura como máximo 72 horas (3 días).")).toBeInTheDocument();
    expect(writes(db)).toHaveLength(0);
  });

  it("shows the one-time URL of an open invite with copy and WhatsApp share", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderApp("/admin/invitaciones", authenticatedState(ADMIN_USER));
    const form = await openForm(user);

    await user.click(within(form).getByRole("radio", { name: /Enlace para compartir/ }));
    await user.type(within(form).getByRole("textbox", { name: /Nota/ }), "Primos de Oaxaca");
    await user.click(within(form).getByRole("button", { name: "Crear enlace" }));

    const box = await screen.findByRole("region", { name: "Enlace de invitación listo" });
    expect(writes(db)[0]?.body).toEqual({ email: null, role: "member", maxUses: 5, expiresInDays: 3, sendEmail: false, note: "Primos de Oaxaca" });
    expect(within(box).getByText(/Este enlace solo se muestra una vez/)).toBeInTheDocument();
    expect(within(box).getByRole("textbox", { name: "Enlace de invitación" })).toHaveValue(ONE_TIME_URL);

    await user.click(within(box).getByRole("button", { name: /Copiar enlace/ }));
    expect(writeText).toHaveBeenCalledWith(ONE_TIME_URL);
    expect(await within(box).findByText(/Enlace copiado/)).toBeInTheDocument();

    const share = within(box).getByRole("link", { name: /Compartir por WhatsApp/ });
    expect(share).toHaveAttribute("href", whatsappShareHref(ONE_TIME_URL));
    expect(share.getAttribute("href")).toMatch(/^https:\/\/wa\.me\/\?text=/);
    expect(share.getAttribute("href")).toContain(encodeURIComponent(ONE_TIME_URL));

    await user.click(within(box).getByRole("button", { name: "Listo" }));
    expect(screen.queryByRole("region", { name: "Enlace de invitación listo" })).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue(ONE_TIME_URL)).not.toBeInTheDocument();
  });

  it("selects the URL for a manual copy when the clipboard is blocked", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) }, configurable: true });
    renderApp("/admin/invitaciones", authenticatedState(ADMIN_USER));
    const form = await openForm(user);
    await user.click(within(form).getByRole("radio", { name: /Enlace para compartir/ }));
    await user.click(within(form).getByRole("button", { name: "Crear enlace" }));

    const box = await screen.findByRole("region", { name: "Enlace de invitación listo" });
    await user.click(within(box).getByRole("button", { name: /Copiar enlace/ }));
    expect(await within(box).findByRole("alert")).toHaveTextContent("No pudimos copiarlo");
  });

  it("shows the server's error when creating fails", async () => {
    const user = userEvent.setup();
    server.use(
      http.post(apiUrl("/admin/invites"), () => HttpResponse.json(errorBody("CONFLICT", "Ya existe una cuenta con ese correo."), { status: 409 }))
    );
    renderApp("/admin/invitaciones", authenticatedState(ADMIN_USER));
    const form = await openForm(user);
    await user.type(within(form).getByRole("textbox", { name: /Correo/ }), "lucia.ramirez@example.com");
    await user.click(within(form).getByRole("button", { name: "Enviar invitación" }));

    expect(await within(form).findByText("Ya existe una cuenta con ese correo.")).toBeInTheDocument();
  });

  it("revokes after confirming", async () => {
    const user = userEvent.setup();
    renderApp("/admin/invitaciones", authenticatedState(ADMIN_USER));

    await screen.findByRole("heading", { name: "tomas.villa@example.com" });
    await user.click(screen.getByRole("button", { name: "Revocar" }));
    const dialog = await screen.findByRole("alertdialog", { name: "¿Revocar la invitación?" });
    expect(dialog).toHaveTextContent("La invitación para tomas.villa@example.com dejará de funcionar.");
    await user.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    expect(writes(db)).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Revocar" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Revocar" }));
    await waitFor(() => expect(writes(db)).toEqual([expect.objectContaining({ method: "POST", path: `/admin/invites/${IDS.inviteBound}/revoke` })]));
    expect(await screen.findByText("Invitación revocada. El enlace ya no funciona.")).toBeInTheDocument();
    const card = screen.getByRole("article", { name: "tomas.villa@example.com" });
    await waitFor(() => expect(card).toHaveTextContent("Revocada"));
    expect(within(card).queryByRole("button", { name: "Revocar" })).not.toBeInTheDocument();
  });

  it("resends an email-bound pending invite", async () => {
    const user = userEvent.setup();
    renderApp("/admin/invitaciones", authenticatedState(ADMIN_USER));

    await screen.findByRole("heading", { name: "tomas.villa@example.com" });
    await user.click(screen.getByRole("button", { name: "Reenviar" }));
    await waitFor(() => expect(writes(db)).toEqual([expect.objectContaining({ method: "POST", path: `/admin/invites/${IDS.inviteBound}/resend` })]));
    expect(await screen.findByText(/Reenviamos la invitación a tomas.villa@example.com/)).toBeInTheDocument();
  });

  it("shows the resend conflict in Spanish", async () => {
    const user = userEvent.setup();
    server.use(
      http.post(apiUrl("/admin/invites/:id/resend"), () =>
        HttpResponse.json(errorBody("CONFLICT", "Solo se pueden reenviar invitaciones pendientes ligadas a un correo."), { status: 409 })
      )
    );
    renderApp("/admin/invitaciones", authenticatedState(ADMIN_USER));

    await user.click(await screen.findByRole("button", { name: "Reenviar" }));
    expect(await screen.findByText("Solo se pueden reenviar invitaciones pendientes ligadas a un correo.")).toBeInTheDocument();
  });
});
