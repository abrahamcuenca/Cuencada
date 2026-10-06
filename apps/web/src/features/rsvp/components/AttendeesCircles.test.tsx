import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authenticatedState, makeUser, statusState } from "../../../../test/auth";
import { type FakeRsvpDb, ME, makeAttendee, makeAttendees, makeRsvpDb, rsvpHandlers } from "../testing/fakeApi";
import { renderWithStore } from "../testing/render";
import { AttendeesCircles } from "./AttendeesCircles";

const server = setupServer();
let db: FakeRsvpDb;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  db = makeRsvpDb();
  server.use(...rsvpHandlers(db));
});
afterEach(() => server.resetHandlers());

describe("AttendeesCircles", () => {
  it("renders nothing and calls no API for visitors", () => {
    renderWithStore(<AttendeesCircles year={2027} />, statusState("anonymous"));

    expect(screen.queryByText("¿Quién va?")).not.toBeInTheDocument();
    expect(db.log).toHaveLength(0);
  });

  it("shows five circles with +N and opens the full list in a dialog", async () => {
    db.attendees = [...makeAttendees(11), makeAttendee(1, { userId: ME.id, displayName: "Prima Cuenca" })];
    const user = userEvent.setup();
    renderWithStore(<AttendeesCircles year={2027} />, authenticatedState(ME));

    const stack = await screen.findByRole("list", { name: "10 confirmados · 2 tal vez" });
    expect(within(stack).getAllByRole("img")).toHaveLength(6);
    // The current user comes first.
    expect(within(stack).getAllByRole("img")[0]).toHaveAccessibleName("Prima Cuenca");
    expect(within(stack).getByRole("img", { name: "y 7 más" })).toHaveTextContent("+7");

    await user.click(screen.getByRole("button", { name: /10 confirmados · 2 tal vez/ }));
    const dialog = await screen.findByRole("dialog", { name: "¿Quién va? · Cuencada 2027" });
    const rows = within(dialog).getAllByRole("listitem");
    expect(rows).toHaveLength(12);
    expect(rows[0]).toHaveTextContent("Prima CuencaTú");
    expect(within(dialog).getByText("María de la Luz Cuenca")).toBeInTheDocument();
    expect(within(dialog).getAllByText("Tal vez")).toHaveLength(2);

    await user.click(within(dialog).getByRole("button", { name: "Cerrar" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("titles past editions ¿Quién fue? and counts attendees", async () => {
    db.attendees = [makeAttendee(2, { source: "attendance", rsvpStatus: null })];
    renderWithStore(<AttendeesCircles year={2026} />, authenticatedState(ME));

    expect(await screen.findByRole("heading", { name: "¿Quién fue?" })).toBeInTheDocument();
    expect(await screen.findByRole("list", { name: "1 asistente" })).toBeInTheDocument();
  });

  it("asks unverified members to verify their email on 403", async () => {
    db.attendees = "forbidden";
    renderWithStore(<AttendeesCircles year={2027} />, authenticatedState(makeUser({ ...ME, emailVerified: false })));

    expect(await screen.findByText("Verifica tu correo para ver quiénes asistieron.")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("shows an empty state when nobody has confirmed", async () => {
    renderWithStore(<AttendeesCircles year={2027} />, authenticatedState(ME));

    expect(await screen.findByText("Todavía nadie ha confirmado. ¡Sé el primero!")).toBeInTheDocument();
  });
});
