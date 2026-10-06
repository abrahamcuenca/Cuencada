import { screen } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { apiUrl, authenticatedState, statusState } from "../../../test/auth";
import { createTestServer } from "../../../test/msw";
import { renderApp } from "../../../test/renderApp";
import { type FakeRsvpDb, ME, makeAttendees, makeRsvpDb, rsvpHandlers } from "./testing/fakeApi";

const server = createTestServer();
let db: FakeRsvpDb;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  db = makeRsvpDb();
  db.attendees = makeAttendees(3);
  server.use(
    ...rsvpHandlers(db),
    // T4's gallery slot on the same page.
    http.get(apiUrl("/cuencadas/:year/media"), () => HttpResponse.json({ items: [], nextCursor: null }))
  );
});
afterEach(() => server.resetHandlers());

describe("RsvpSlot and AttendeesSlot on /cuencada/:year", () => {
  it("show the RSVP card and the attendee circles to members", async () => {
    renderApp("/cuencada/2027", authenticatedState(ME));

    expect(await screen.findByRole("group", { name: "¿Vas a la Cuencada 2027?" })).toBeInTheDocument();
    expect(await screen.findByRole("list", { name: "3 confirmados" })).toBeInTheDocument();
    expect(document.querySelector('[data-slot="rsvp"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="attendees"]')).not.toBeNull();
  });

  it("render nothing for visitors and never call the RSVP API", async () => {
    renderApp("/cuencada/2027", statusState("anonymous"));

    expect(await screen.findByText("Solo para la familia")).toBeInTheDocument();
    expect(document.querySelector('[data-slot="rsvp"]')).toBeNull();
    expect(document.querySelector('[data-slot="attendees"]')).toBeNull();
    expect(db.log.filter((line) => line.includes("/rsvp") || line.includes("/attendees"))).toEqual([]);
  });
});
