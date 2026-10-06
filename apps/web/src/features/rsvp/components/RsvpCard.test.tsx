import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authenticatedState, statusState } from "../../../../test/auth";
import { type FakeRsvpDb, HOTEL_A, HOTEL_B, ME, makeAttendee, makeMyRsvp, makeRsvpDb, rsvpHandlers } from "../testing/fakeApi";
import { renderWithStore } from "../testing/render";
import { RsvpCard } from "./RsvpCard";

const server = setupServer();
let db: FakeRsvpDb;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  db = makeRsvpDb();
  server.use(...rsvpHandlers(db));
});
afterEach(() => server.resetHandlers());

function renderCard(year = 2027): void {
  renderWithStore(<RsvpCard year={year} />, authenticatedState(ME));
}

describe("RsvpCard", () => {
  it("renders nothing and calls no API for visitors", () => {
    renderWithStore(<RsvpCard year={2027} />, statusState("anonymous"));

    expect(screen.queryByText(/Confirmar asistencia/)).not.toBeInTheDocument();
    expect(db.log).toHaveLength(0);
  });

  it("creates an RSVP with guests, dates and a hotel", async () => {
    const user = userEvent.setup();
    renderCard();

    const group = await screen.findByRole("group", { name: "¿Vas a la Cuencada 2027?" });
    expect(screen.getByText("Confirma antes del 31 de mayo de 2099 a las 11:59 p.m.")).toBeInTheDocument();
    await user.click(within(group).getByRole("radio", { name: /Sí/ }));
    await user.click(screen.getByRole("button", { name: "Agregar un acompañante" }));
    await user.click(screen.getByRole("button", { name: "Agregar un acompañante" }));
    expect(screen.getByRole("textbox", { name: /Acompañantes/ })).toHaveValue("2");
    fireEvent.change(screen.getByLabelText(/Llegada/), { target: { value: "2027-07-09" } });
    fireEvent.change(screen.getByLabelText(/Salida/), { target: { value: "2027-07-15" } });
    await user.selectOptions(await screen.findByRole("combobox", { name: /Hotel/ }), HOTEL_B);
    await user.type(screen.getByRole("textbox", { name: /Notas/ }), "Sin gluten");
    await user.click(screen.getByRole("button", { name: "Guardar respuesta" }));

    expect(await screen.findByText("¡Listo! Confirmaste tu asistencia.")).toBeInTheDocument();
    expect(screen.getByText("Tú + 2 acompañantes")).toBeInTheDocument();
    expect(screen.getByText("Hotel Casa Lucía")).toBeInTheDocument();
    expect(db.putBodies).toEqual([
      { status: "yes", guestCount: 2, arrivalDate: "2027-07-09", departureDate: "2027-07-15", hotelLocationId: HOTEL_B, notes: "Sin gluten" }
    ]);
    expect(db.log).toContain("PUT /cuencadas/2027/rsvp/me");
  });

  it("only offers the edition's hotel locations", async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(await screen.findByRole("radio", { name: /Tal vez/ }));
    const select = await screen.findByRole("combobox", { name: /Hotel/ });
    const options = within(select)
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(options).toEqual(["Aún no sé / otro lugar", "Hotel Chariot Mérida", "Hotel Casa Lucía"]);
  });

  it("updates an existing answer", async () => {
    db.my = { ...db.my, rsvp: makeMyRsvp() };
    const user = userEvent.setup();
    renderCard();

    expect(await screen.findByText("Tú + 2 acompañantes")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cambiar respuesta" }));
    expect(screen.getByRole("radio", { name: /Sí/ })).toBeChecked();
    expect(screen.getByLabelText(/Llegada/)).toHaveValue("2027-07-09");
    expect(screen.getByRole("combobox", { name: /Hotel/ })).toHaveValue(HOTEL_A);

    await user.click(screen.getByRole("radio", { name: /No/ }));
    expect(screen.queryByLabelText(/Llegada/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Guardar respuesta" }));

    expect(await screen.findByText("Te vamos a extrañar 💛")).toBeInTheDocument();
    expect(await screen.findByText("Listo. Guardamos tu respuesta.")).toBeInTheDocument();
    expect(db.putBodies).toEqual([{ status: "no", guestCount: 0, arrivalDate: null, departureDate: null, hotelLocationId: null, notes: null }]);
  });

  it("is read-only after the deadline", async () => {
    db.my = { rsvp: makeMyRsvp(), deadline: "2026-08-16T05:59:00Z", editable: false };
    renderCard();

    expect(
      await screen.findByText(
        "Las confirmaciones cerraron el 15 de agosto de 2026 a las 11:59 p.m. Escribe en el grupo de WhatsApp si cambiaron tus planes."
      )
    ).toBeInTheDocument();
    expect(screen.getByText("Tú + 2 acompañantes")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cambiar respuesta" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });

  it("locks the card once the deadline passes even if the server still said editable", async () => {
    db.my = { rsvp: null, deadline: "2020-01-01T06:00:00Z", editable: true };
    renderCard();

    expect(await screen.findByText(/Las confirmaciones cerraron el 1 de enero de 2020/)).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });

  it("blocks a departure before the arrival without calling the API", async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(await screen.findByRole("radio", { name: /Sí/ }));
    fireEvent.change(screen.getByLabelText(/Llegada/), { target: { value: "2027-07-12" } });
    fireEvent.change(screen.getByLabelText(/Salida/), { target: { value: "2027-07-11" } });
    await user.click(screen.getByRole("button", { name: "Guardar respuesta" }));

    expect(screen.getByText("La salida debe ser igual o posterior a la llegada.")).toBeInTheDocument();
    expect(screen.getByLabelText(/Salida/)).toHaveAttribute("aria-invalid", "true");
    expect(db.putBodies).toHaveLength(0);
  });

  it("asks for an answer before saving", async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(await screen.findByRole("button", { name: "Guardar respuesta" }));
    expect(screen.getByText("Elige Sí, Tal vez o No.")).toBeInTheDocument();
    expect(db.putBodies).toHaveLength(0);
  });

  it("shows the answer optimistically and rolls it back when the save fails", async () => {
    db.failPutWith = 500;
    db.putDelayMs = 150;
    const user = userEvent.setup();
    renderCard();

    await user.click(await screen.findByRole("radio", { name: /Sí/ }));
    await user.click(screen.getByRole("button", { name: "Guardar respuesta" }));

    // Optimistic: the summary shows before the server answers.
    expect(await screen.findByText(/¡Vas!/)).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();

    // Rollback: the error is shown and the form comes back with the draft.
    expect(await screen.findByText("No pudimos guardar tu respuesta.")).toBeInTheDocument();
    expect(screen.queryByText(/¡Vas!/)).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Sí/ })).toBeChecked();
  });

  it("reloads the lock state when the server refuses after the deadline", async () => {
    db.failPutWith = 403;
    const user = userEvent.setup();
    renderCard();

    await user.click(await screen.findByRole("radio", { name: /Tal vez/ }));
    db.my = { rsvp: null, deadline: "2026-08-16T05:59:00Z", editable: false };
    await user.click(screen.getByRole("button", { name: "Guardar respuesta" }));

    expect(await screen.findByText("Las confirmaciones ya cerraron.")).toBeInTheDocument();
    expect(await screen.findByText(/Las confirmaciones cerraron el 15 de agosto de 2026/)).toBeInTheDocument();
    await waitFor(() => expect(db.log.filter((line) => line === "GET /cuencadas/2027/rsvp/me")).toHaveLength(2));
  });

  it("shows the attended badge on a past edition the member went to", async () => {
    db.attendees = [makeAttendee(2), makeAttendee(1, { userId: ME.id, displayName: ME.displayName })];
    renderCard(2026);

    expect(await screen.findByText("🎉 Fuiste a esta Cuencada")).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(db.log).not.toContain("GET /cuencadas/2026/rsvp/me");
  });

  it("matches attendance-only rows by the linked person", async () => {
    db.attendees = [makeAttendee(1, { personId: ME.personId, source: "attendance", rsvpStatus: null })];
    renderCard(2026);

    expect(await screen.findByText("🎉 Fuiste a esta Cuencada")).toBeInTheDocument();
  });

  it("shows no badge on a past edition the member missed", async () => {
    db.attendees = [makeAttendee(2)];
    renderCard(2026);

    await waitFor(() => expect(db.log).toContain("GET /cuencadas/2026/attendees"));
    expect(screen.queryByText(/Fuiste a esta Cuencada/)).not.toBeInTheDocument();
  });
});
