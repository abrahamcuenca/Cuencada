import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authenticatedState, makeUser } from "../../../../test/auth";
import { createTestServer } from "../../../../test/msw";
import { renderApp, warmRoutes } from "../../../../test/renderApp";
import { type EventsDb, eventsHandlers, makeEventsDb, makeSummary } from "../testing/fixtures";

const server = createTestServer();
let db: EventsDb;

beforeAll(async () => {
  server.listen({ onUnhandledRequest: "error" });
  await warmRoutes("/eventos", "/eventos/2026/x-abcd");
}, 30_000);
afterAll(() => server.close());
beforeEach(() => {
  db = makeEventsDb();
  server.use(...eventsHandlers(db));
});
afterEach(() => server.resetHandlers());

function listRequests(): string[] {
  return db.log.filter((line) => line.startsWith("GET /events?"));
}

describe("EventsPage", { timeout: 20_000 }, () => {
  it("shows cards with cover placeholder, badges, dates, place, summary and participant count", async () => {
    db.upcoming = [
      makeSummary(1, { coverUrl: "https://bucket.example/events/cover-640.webp?X-Amz-Signature=c" }),
      makeSummary(2, { startsAt: null, endsAt: null, year: 2027, visibility: "participants", status: "draft", viewerRole: "organizer", participantCount: 1 })
    ];
    renderApp("/eventos", authenticatedState());

    expect(await screen.findByRole("heading", { level: 1, name: "Eventos" })).toBeInTheDocument();
    const list = await screen.findByRole("list", { name: "Eventos próximos" });
    const cards = within(list).getAllByRole("article");
    expect(cards).toHaveLength(2);
    const first = cards[0] as HTMLElement;
    expect(within(first).getByRole("link", { name: "Paseo a la laguna 1" })).toHaveAttribute("href", "/eventos/2026/paseo-1-k7q1");
    expect(first.querySelector("img")).toHaveAttribute("src", "https://bucket.example/events/cover-640.webp?X-Amz-Signature=c");
    expect(within(first).getByText("Laguna Ejemplo, Pueblo Ejemplo")).toBeInTheDocument();
    expect(within(first).getByText("Llevamos comida y traje de baño.")).toBeInTheDocument();
    expect(within(first).getByText("3 participantes")).toBeInTheDocument();
    const second = cards[1] as HTMLElement;
    expect(second.querySelector("img")).toBeNull();
    expect(within(second).getByText("Por anunciar · 2027")).toBeInTheDocument();
    for (const badge of ["Borrador", "Solo participantes", "Organizas"]) expect(within(second).getByText(badge)).toBeInTheDocument();
    expect(within(second).getByText("1 participante")).toBeInTheDocument();
    expect(listRequests()).toEqual(["GET /events?when=upcoming&limit=12"]);
  });

  it("switches to Pasados and filters by year and Mis eventos, keeping them in the URL", async () => {
    db.past = [makeSummary(5, { title: "Posada 2025", year: 2025 })];
    const user = userEvent.setup();
    const { router } = renderApp("/eventos", authenticatedState());
    await screen.findByRole("heading", { level: 1, name: "Eventos" });

    await user.click(screen.getByRole("tab", { name: "Pasados" }));
    expect(await screen.findByRole("link", { name: "Posada 2025" })).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Año" }), "2025");
    await user.click(screen.getByRole("switch", { name: "Mis eventos" }));

    await waitFor(() => expect(listRequests()).toContain("GET /events?when=past&limit=12&year=2025&mine=true"));
    expect(router.state.location.search).toBe("?cuando=pasados&anio=2025&mios=1");
  });

  it("pages with Cargar más", async () => {
    db.pageSize = 2;
    db.upcoming = [makeSummary(1), makeSummary(2), makeSummary(3)];
    const user = userEvent.setup();
    renderApp("/eventos", authenticatedState());
    await screen.findByRole("link", { name: "Paseo a la laguna 2" });
    expect(screen.queryByRole("link", { name: "Paseo a la laguna 3" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cargar más" }));
    expect(await screen.findByRole("link", { name: "Paseo a la laguna 3" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cargar más" })).not.toBeInTheDocument();
    expect(listRequests()).toContain("GET /events?when=upcoming&limit=12&cursor=2");
  });

  it("shows the empty state with Crear evento", async () => {
    renderApp("/eventos", authenticatedState());
    expect(await screen.findByRole("heading", { name: "Aún no hay eventos próximos" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Crear evento/ })).toHaveLength(2);
  });

  it("creates an event: the address preview says it gets a short code, no slug is sent, and it opens the new event", async () => {
    const user = userEvent.setup();
    const { router } = renderApp("/eventos", authenticatedState());
    await screen.findByRole("heading", { name: "Aún no hay eventos próximos" });
    await user.click(screen.getAllByRole("button", { name: /Crear evento/ })[0] as HTMLElement);

    const sheet = await screen.findByRole("dialog", { name: "Crear evento" });
    expect(within(sheet).queryByRole("textbox", { name: /Dirección/ })).not.toBeInTheDocument();
    await user.type(within(sheet).getByRole("textbox", { name: /Título/ }), "Carne asada");
    const preview = within(sheet).getByTestId("slug-preview");
    expect(preview).toHaveTextContent(/\/eventos\/2026\/carne-asada-····/);
    expect(preview).toHaveTextContent("la dirección lleva un código corto");
    await user.type(within(sheet).getByRole("textbox", { name: /Resumen/ }), "Cada quien trae algo.");
    expect(within(sheet).getByText(/21\/280/)).toBeInTheDocument();
    await user.click(within(sheet).getByRole("radio", { name: "Solo participantes" }));
    expect(within(sheet).getByText(/Solo lo ven las personas que agregues/)).toBeInTheDocument();
    await user.click(within(sheet).getByRole("button", { name: "Crear evento" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/eventos/2026/carne-asada-k7q2"));
    const body = db.bodies["POST /events"] as Record<string, unknown>;
    expect(body).toMatchObject({ title: "Carne asada", summary: "Cada quien trae algo.", visibility: "participants", publish: true, year: 2026 });
    expect(body).not.toHaveProperty("slug");
    expect(db.bodies["POST /admin/events"]).toBeUndefined();
  });

  it("gives admins an editable address and the admin endpoint", async () => {
    const user = userEvent.setup();
    const { router } = renderApp("/eventos", authenticatedState(makeUser({ role: "admin" })));
    await screen.findByRole("heading", { name: "Aún no hay eventos próximos" });
    await user.click(screen.getAllByRole("button", { name: /Crear evento/ })[0] as HTMLElement);
    const sheet = await screen.findByRole("dialog", { name: "Crear evento" });
    expect(within(sheet).queryByTestId("slug-preview")).not.toBeInTheDocument();
    await user.type(within(sheet).getByRole("textbox", { name: /Título/ }), "Posada");
    await user.type(within(sheet).getByRole("textbox", { name: /Dirección/ }), "posada-familiar");
    await user.click(within(sheet).getByRole("button", { name: "Crear evento" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/eventos/2026/posada-familiar"));
    expect(db.bodies["POST /admin/events"]).toMatchObject({ slug: "posada-familiar" });
  });
});
