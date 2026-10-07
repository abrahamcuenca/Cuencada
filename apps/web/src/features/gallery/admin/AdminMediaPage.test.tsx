import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authenticatedState, makeUser } from "../../../../test/auth";
import { renderApp } from "../../../../test/renderApp";
import { type FakeGalleryDb, galleryHandlers, makeAdminMedia, makeDb, uuid } from "../testUtils";

const server = setupServer();
let db: FakeGalleryDb;
const admin = (): ReturnType<typeof authenticatedState> => authenticatedState(makeUser({ role: "admin" }));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  db = makeDb();
  server.use(...galleryHandlers(db));
});
afterEach(() => server.resetHandlers());

describe("AdminMediaPage", () => {
  it("lists the pending queue and approves an item", async () => {
    db.admin = [makeAdminMedia(1, { moderationStatus: "pending_review", caption: "Pendiente uno" }), makeAdminMedia(2, { moderationStatus: "approved" })];
    const user = userEvent.setup();
    renderApp("/admin/media", admin());

    expect(await screen.findByRole("heading", { name: "Moderación de fotos" })).toBeInTheDocument();
    const card = (await screen.findByText("Pendiente uno")).closest("li");
    if (!card) throw new Error("no card");
    expect(screen.queryByText("Foto número 2")).not.toBeInTheDocument();
    expect(db.log).toContain("GET /admin/media?moderationStatus=pending_review&limit=20");

    await user.click(within(card).getByRole("button", { name: "Aprobar" }));

    expect(await screen.findByText("Aprobada. Ya se ve en el álbum.")).toBeInTheDocument();
    expect(db.log).toContain(`POST /admin/media/${uuid(1)}/moderate`);
    expect(await screen.findByText("No hay fotos esperando revisión.")).toBeInTheDocument();
  });

  it("opens the queue named in ?cola= and keeps the URL in sync with the tabs", async () => {
    db.admin = [makeAdminMedia(3, { reportCount: 1, caption: "Reportada" })];
    const user = userEvent.setup();
    const { router } = renderApp("/admin/media?cola=reported", admin());

    expect(await screen.findByRole("tab", { name: "Reportadas" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("Reportada")).toBeInTheDocument();
    expect(db.log).toContain("GET /admin/media?reported=true&limit=20");

    await user.click(screen.getByRole("tab", { name: "Ocultas" }));
    expect(router.state.location.search).toBe("?cola=hidden");
  });

  it("falls back to the pending queue for an unknown ?cola=", async () => {
    renderApp("/admin/media?cola=<script>", admin());

    expect(await screen.findByRole("tab", { name: "Por revisar" })).toHaveAttribute("aria-selected", "true");
  });

  it("shows reported items with their reports and hides one", async () => {
    db.admin = [makeAdminMedia(3, { reportCount: 2, caption: "Reportada" })];
    db.reports[uuid(3)] = [
      { id: uuid(31), reason: "privacy", details: "No quiero salir", reporterName: "Tomás", createdAt: "2026-09-15T12:00:00.000Z" },
      { id: uuid(32), reason: "duplicate", details: null, reporterName: null, createdAt: "2026-09-15T13:00:00.000Z" }
    ];
    const user = userEvent.setup();
    renderApp("/admin/media", admin());

    await user.click(await screen.findByRole("tab", { name: "Reportadas" }));
    const card = (await screen.findByText("Reportada")).closest("li");
    if (!card) throw new Error("no card");
    expect(within(card).getByText("⚑ 2 reportes")).toBeInTheDocument();

    await user.click(within(card).getByRole("button", { name: "Ver reportes" }));
    expect(await within(card).findByText("Aparezco yo y no quiero")).toBeInTheDocument();
    expect(within(card).getByText("“No quiero salir”")).toBeInTheDocument();
    expect(within(card).getByText("Está repetida")).toBeInTheDocument();

    await user.click(within(card).getByRole("button", { name: "Ocultar" }));
    expect(await screen.findByText("Oculta. Ya no se ve en el álbum.")).toBeInTheDocument();
    await waitFor(() => expect(db.admin[0]?.moderationStatus).toBe("hidden"));
  });

  it("deletes after a confirmation", async () => {
    db.admin = [makeAdminMedia(4, { moderationStatus: "hidden", caption: "Oculta cuatro" })];
    const user = userEvent.setup();
    renderApp("/admin/media", admin());

    await user.click(await screen.findByRole("tab", { name: "Ocultas" }));
    const card = (await screen.findByText("Oculta cuatro")).closest("li");
    if (!card) throw new Error("no card");
    expect(within(card).queryByRole("button", { name: "Ocultar" })).not.toBeInTheDocument();

    await user.click(within(card).getByRole("button", { name: "Eliminar" }));
    const confirm = await screen.findByRole("alertdialog", { name: "¿Eliminar definitivamente?" });
    await user.click(within(confirm).getByRole("button", { name: "Eliminar" }));

    expect(await screen.findByText("Eliminada.")).toBeInTheDocument();
    expect(await screen.findByText("No hay fotos ocultas.")).toBeInTheDocument();
    expect(db.admin).toHaveLength(0);
  });

  it("keeps members out (UX guard; the server enforces it)", async () => {
    renderApp("/admin/media", authenticatedState());

    expect(await screen.findByRole("heading", { level: 1, name: "Acceso restringido" })).toBeInTheDocument();
    expect(db.log.some((line) => line.startsWith("GET /admin/media"))).toBe(false);
  });
});
