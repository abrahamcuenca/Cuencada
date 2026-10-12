import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authenticatedState, makeUser } from "../../../../test/auth";
import { createTestServer } from "../../../../test/msw";
import { renderApp, warmRoutes } from "../../../../test/renderApp";
import { type EventsDb, eventId, eventsHandlers, makeDetail, makeEventsDb, putDetail } from "../testing/fixtures";

const server = createTestServer();
let db: EventsDb;
const admin = authenticatedState(makeUser({ role: "admin" }));

beforeAll(async () => {
  server.listen({ onUnhandledRequest: "error" });
  await warmRoutes("/admin/eventos");
}, 30_000);
afterAll(() => server.close());
beforeEach(() => {
  db = makeEventsDb();
  server.use(...eventsHandlers(db));
  putDetail(db, makeDetail({ title: "Paseo publicado" }));
  putDetail(db, makeDetail({ id: eventId(2), slug: "oculto-ab2c", title: "Evento oculto", status: "hidden", firstPublishedAt: null }));
});
afterEach(() => server.resetHandlers());

describe("AdminEventsPage", { timeout: 20_000 }, () => {
  it("lists every event, hidden included, and filters by status", async () => {
    const user = userEvent.setup();
    renderApp("/admin/eventos", admin);
    const list = await screen.findByRole("list", { name: "Eventos" });
    expect(within(list).getByRole("link", { name: "Paseo publicado" })).toHaveAttribute("href", "/eventos/2026/paseo-1-k7q1");
    expect(within(list).getByText("Oculto")).toBeInTheDocument();
    expect(within(list).getAllByText("Creado por Rosa Quintero Lara")).toHaveLength(2);

    await user.selectOptions(screen.getByRole("combobox", { name: "Estado" }), "hidden");
    await waitFor(() => expect(db.log).toContain("GET /admin/events?status=hidden&limit=20"));
    await waitFor(() => expect(screen.queryByRole("link", { name: "Paseo publicado" })).not.toBeInTheDocument());
  });

  it("hides after confirming, and unhides a never-published event back to draft", async () => {
    const user = userEvent.setup();
    renderApp("/admin/eventos", admin);
    const list = await screen.findByRole("list", { name: "Eventos" });
    const published = within(list).getByRole("link", { name: "Paseo publicado" }).closest("li") as HTMLElement; // Safe: rows are <li>.
    await user.click(within(published).getByRole("button", { name: "Ocultar" }));
    await user.click(within(await screen.findByRole("alertdialog", { name: /Ocultar Paseo publicado/ })).getByRole("button", { name: "Ocultar evento" }));
    await waitFor(() => expect(db.bodies[`PATCH /events/${eventId(1)}`]).toEqual({ status: "hidden" }));

    const hidden = within(list).getByRole("link", { name: "Evento oculto" }).closest("li") as HTMLElement; // Safe: rows are <li>.
    await user.click(within(hidden).getByRole("button", { name: "Mostrar" }));
    await waitFor(() => expect(db.bodies[`PATCH /events/${eventId(2)}`]).toEqual({ status: "draft" }));
  });

  it("deletes after confirming", async () => {
    const user = userEvent.setup();
    renderApp("/admin/eventos", admin);
    const list = await screen.findByRole("list", { name: "Eventos" });
    const row = within(list).getByRole("link", { name: "Evento oculto" }).closest("li") as HTMLElement; // Safe: rows are <li>.
    await user.click(within(row).getByRole("button", { name: "Eliminar" }));
    await user.click(within(await screen.findByRole("alertdialog", { name: /Eliminar Evento oculto/ })).getByRole("button", { name: "Eliminar evento" }));
    expect(await screen.findByText("Eliminaste Evento oculto.")).toBeInTheDocument();
    expect(db.log).toContain(`DELETE /events/${eventId(2)}`);
  });

  it("is in the admin Panel sections", async () => {
    renderApp("/admin", admin);
    const nav = await screen.findByRole("navigation", { name: "Secciones de administración" });
    expect(within(nav).getByRole("link", { name: /Eventos/ })).toHaveAttribute("href", "/admin/eventos");
  });
});
