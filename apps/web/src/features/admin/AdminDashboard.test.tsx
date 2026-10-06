import { screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authenticatedState, makeUser } from "../../../test/auth";
import { createTestServer } from "../../../test/msw";
import { renderApp } from "../../../test/renderApp";
import { ADMIN_USER, type AdminDb, adminHandlers, IDS, makeAdminDb, makeSummary } from "./testing/fixtures";

const server = createTestServer();
let db: AdminDb;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  db = makeAdminDb();
  server.use(...adminHandlers(db));
});
afterEach(() => server.resetHandlers());

describe("DashboardPage", { timeout: 15_000 }, () => {
  it("shows tappable count cards that link to the matching section", async () => {
    renderApp("/admin", authenticatedState(ADMIN_USER));

    expect(await screen.findByRole("heading", { level: 1, name: "Administración" })).toBeInTheDocument();
    const cards = await screen.findByRole("link", { name: /42\s*Usuarios activos/ });
    expect(cards).toHaveAttribute("href", "/admin/usuarios?estado=active");
    expect(screen.getByRole("link", { name: /3\s*Usuarios deshabilitados/ })).toHaveAttribute("href", "/admin/usuarios?estado=disabled");
    expect(screen.getByRole("link", { name: /5\s*Sin verificar correo/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /7\s*Invitaciones pendientes/ })).toHaveAttribute("href", "/admin/invitaciones?estado=pending");
    expect(screen.getByRole("link", { name: /4\s*Fotos por revisar/ })).toHaveAttribute("href", "/admin/media?cola=pending");
    expect(screen.getByRole("link", { name: /1\s*Fotos reportadas/ })).toHaveAttribute("href", "/admin/media?cola=reported");

    const rsvp = screen.getByRole("link", { name: /RSVPs de la próxima Cuencada: Cuencada 2027/ });
    expect(rsvp).toHaveAttribute("href", `/admin/cuencadas/${IDS.edition}/asistencia`);
    expect(rsvp).toHaveTextContent("30 sí");
    expect(rsvp).toHaveTextContent("9 acompañantes");
  });

  it("lists every admin section, linking to the other tracks' screens", async () => {
    renderApp("/admin", authenticatedState(ADMIN_USER));

    const nav = await screen.findByRole("navigation", { name: "Secciones de administración" });
    const href = (name: RegExp): string | null => within(nav).getByRole("link", { name }).getAttribute("href");
    expect(href(/^Cuencadas/)).toBe("/admin/cuencadas");
    expect(href(/^Asistencia/)).toBe("/admin/cuencadas");
    expect(href(/^Fotos/)).toBe("/admin/media");
    expect(href(/^Personas y árbol/)).toBe("/admin/familia");
    expect(href(/^Invitaciones/)).toBe("/admin/invitaciones");
    expect(href(/^Usuarios/)).toBe("/admin/usuarios");
    expect(href(/^Bitácora/)).toBe("/admin/bitacora");
    expect(within(nav).getByRole("link", { name: /^Resumen/ })).toHaveAttribute("aria-current", "page");
  });

  it("says when no upcoming Cuencada is published", async () => {
    db.summary = makeSummary({ upcomingEdition: null });
    renderApp("/admin", authenticatedState(ADMIN_USER));

    expect(await screen.findByText(/No hay una próxima Cuencada publicada/)).toBeInTheDocument();
  });
});

describe("admin access", { timeout: 15_000 }, () => {
  it("redirects a member away from /admin without calling the admin API", async () => {
    const { router } = renderApp("/admin", authenticatedState(makeUser({ displayName: "Mateo Ortega Vidal", email: "mateo.ortega@example.com" })));

    expect(await screen.findByRole("heading", { name: "CUENCADA" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");
    expect(db.log).toHaveLength(0);
  });

  it.each(["/admin/invitaciones", "/admin/usuarios", "/admin/bitacora"])("redirects a member away from %s", async (path) => {
    const { router } = renderApp(path, authenticatedState(makeUser({ displayName: "Mateo Ortega Vidal", email: "mateo.ortega@example.com" })));

    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(db.log).toHaveLength(0);
  });
});
