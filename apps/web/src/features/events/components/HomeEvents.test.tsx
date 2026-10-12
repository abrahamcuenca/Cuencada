import { screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authenticatedState } from "../../../../test/auth";
import { createTestServer } from "../../../../test/msw";
import { renderApp, warmRoutes } from "../../../../test/renderApp";
import { type EventsDb, eventsHandlers, makeEventsDb, makeSummary } from "../testing/fixtures";

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

  it("links Eventos from Más", async () => {
    renderApp("/mas", authenticatedState());
    const main = await screen.findByRole("main");
    expect(await within(main).findByRole("link", { name: /Eventos/ })).toHaveAttribute("href", "/eventos");
  });
});
