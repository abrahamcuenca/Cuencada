import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authenticatedState } from "../../../../test/auth";
import { createTestServer } from "../../../../test/msw";
import { renderApp, warmRoutes } from "../../../../test/renderApp";
import { parseEventNotices } from "../notices/api";
import { addedToEventText } from "../notices/AddedToEventNotice";
import { type EventsDb, eventId, eventsHandlers, makeEventsDb, makeSummary } from "../testing/fixtures";

const server = createTestServer();
let db: EventsDb;

beforeAll(async () => {
  server.listen({ onUnhandledRequest: "error" });
  await warmRoutes("/", "/mas");
}, 30_000);
afterAll(() => server.close());
beforeEach(() => {
  db = makeEventsDb();
  server.use(...eventsHandlers(db));
});
afterEach(() => server.resetHandlers());

function notice(n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: { id: eventId(n), year: 2026, slug: `viaje-${n}-ab2c`, title: `Viaje ${n}` },
    addedByName: "Rosa Quintero Lara",
    role: "participant",
    addedAt: "2026-10-01T15:00:00.000Z",
    canLeave: true,
    ...overrides
  };
}

describe("Home events (WP-5.4)", { timeout: 20_000 }, () => {
  it("shows at most 3 upcoming events with a link to all of them", async () => {
    db.upcoming = [makeSummary(1), makeSummary(2), makeSummary(3), makeSummary(4)];
    renderApp("/", authenticatedState());
    const strip = await screen.findByRole("region", { name: /Próximos eventos/ });
    expect(within(strip).getAllByRole("article")).toHaveLength(3);
    expect(within(strip).getByRole("link", { name: "Ver todos" })).toHaveAttribute("href", "/eventos");
    expect(db.log).toContain("GET /events?when=upcoming&limit=3");
  });

  it("hides the strip when there is no upcoming event, and never asks for anonymous visitors", async () => {
    renderApp("/", authenticatedState());
    await waitFor(() => expect(db.log).toContain("GET /events?when=upcoming&limit=3"));
    expect(screen.queryByRole("region", { name: /Próximos eventos/ })).not.toBeInTheDocument();
  });

  it("lists who added me to which event; Entendido dismisses and Salir leaves", async () => {
    db.notices = [notice(1), notice(2, { addedByName: null, role: "organizer", canLeave: false })] as unknown as EventsDb["notices"]; // Safe: raw wire shapes, validated by the page.
    const user = userEvent.setup();
    renderApp("/", authenticatedState());
    const notices = await screen.findByRole("region", { name: "Avisos de eventos" });
    expect(within(notices).getByText(/Rosa Quintero Lara te agregó a «Viaje 1»\. Puedes salir cuando quieras\./)).toBeInTheDocument();
    expect(within(notices).getByText(/Te agregaron como organizador a «Viaje 2»\./)).toBeInTheDocument();
    const second = within(notices).getByText(/Viaje 2/).closest("li") as HTMLElement; // Safe: every notice is an <li>.
    expect(within(second).queryByRole("button", { name: "Salir" })).not.toBeInTheDocument();
    expect(within(second).getByRole("link", { name: "Ver evento" })).toHaveAttribute("href", "/eventos/2026/viaje-2-ab2c");

    await user.click(within(second).getByRole("button", { name: "Entendido" }));
    await waitFor(() => expect(screen.queryByText(/Viaje 2/)).not.toBeInTheDocument());
    expect(db.log).toContain(`DELETE /events/${eventId(2)}/notice`);

    const first = within(notices).getByText(/Viaje 1/).closest("li") as HTMLElement; // Safe: every notice is an <li>.
    await user.click(within(first).getByRole("button", { name: "Salir" }));
    expect(await screen.findByText("Saliste de Viaje 1.")).toBeInTheDocument();
    expect(db.log).toContain(`DELETE /events/${eventId(1)}/participants/me`);
    await waitFor(() => expect(screen.queryByRole("region", { name: "Avisos de eventos" })).not.toBeInTheDocument());
  });

  it("links Eventos from Más", async () => {
    renderApp("/mas", authenticatedState());
    const main = await screen.findByRole("main");
    expect(await within(main).findByRole("link", { name: /Eventos/ })).toHaveAttribute("href", "/eventos");
  });
});

describe("parseEventNotices", () => {
  it("keeps valid notices, drops malformed ones and caps the list at 20", () => {
    const raw = { items: [notice(1), { ...notice(2), canLeave: "sí" }, { ...notice(3), event: { id: "nope" } }, ...Array.from({ length: 25 }, (_, i) => notice(10 + i))] };
    const parsed = parseEventNotices(raw);
    expect(parsed[0]?.event.title).toBe("Viaje 1");
    expect(parsed).toHaveLength(18);
    expect(parseEventNotices(null)).toEqual([]);
  });

  it("words a notice without the adder's name", () => {
    expect(addedToEventText({ addedByName: null, role: "participant", event: { id: eventId(1), year: 2026, slug: "a-b-c", title: "Comida" } })).toBe("Te agregaron a «Comida».");
  });
});
