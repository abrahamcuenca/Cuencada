import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { apiUrl, authenticatedState, errorBody, statusState } from "../../../../test/auth";
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
afterEach(() => {
  server.resetHandlers();
  vi.useRealTimers();
});

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
    expect(screen.getByText("Confirma a más tardar el 31 de mayo de 2099.")).toBeInTheDocument();
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
    // The toast lives in its own provider and can commit a render before the card does
    // (seen under load): wait for the summary itself rather than assuming the same commit.
    expect(await screen.findByText("Tú + 2 acompañantes")).toBeInTheDocument();
    expect(screen.getByText("Hotel Casa Lucía")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cambiar respuesta" })).toBeEnabled();
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
        "Las confirmaciones cerraron el 15 de agosto de 2026. Escribe en el grupo de WhatsApp si cambiaron tus planes."
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

  it("locks the card at local midnight when the deadline's day ends with the page open", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["Date", "setTimeout", "clearTimeout"] });
    // 23:59:58 on May 31 in Mérida; the deadline is that day.
    vi.setSystemTime(new Date("2027-06-01T05:59:58Z"));
    db.my = { rsvp: null, deadline: "2027-05-31T18:00:00Z", editable: true };
    renderCard();

    expect(await screen.findByRole("group", { name: "¿Vas a la Cuencada 2027?" })).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(4_000);

    expect(await screen.findByText(/Las confirmaciones cerraron el 31 de mayo de 2027/)).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });

  it("re-saves with the saved hotel while the hotel list fails to load", async () => {
    server.use(http.get(apiUrl("/cuencadas/:year/members"), () => HttpResponse.json(errorBody("INTERNAL"), { status: 500 })));
    db.my = { ...db.my, rsvp: makeMyRsvp({ hotelLocationId: HOTEL_A }) };
    const user = userEvent.setup();
    renderCard();

    await user.click(await screen.findByRole("button", { name: "Cambiar respuesta" }));
    const select = await screen.findByRole("combobox", { name: /Hotel/ });
    expect(select).toHaveValue(HOTEL_A);
    expect(within(select).getByRole("option", { name: "El hotel que ya elegiste" })).toBeInTheDocument();
    await waitFor(() => expect(select).toHaveAccessibleDescription(/No pudimos cargar la lista de hoteles/));
    await user.clear(screen.getByRole("textbox", { name: /Notas/ }));
    await user.type(screen.getByRole("textbox", { name: /Notas/ }), "Llegamos tarde");
    await user.click(screen.getByRole("button", { name: "Guardar respuesta" }));

    expect(await screen.findByText("¡Listo! Confirmaste tu asistencia.")).toBeInTheDocument();
    expect(screen.queryByText("Elige uno de los hoteles de la lista.")).not.toBeInTheDocument();
    expect(db.putBodies[0]).toMatchObject({ hotelLocationId: HOTEL_A, notes: "Llegamos tarde" });
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

  it("shows the server message and locks the card on 409 CONFLICT (RSVP closed)", async () => {
    db.failPutWith = 409;
    const user = userEvent.setup();
    renderCard();

    await user.click(await screen.findByRole("radio", { name: /Tal vez/ }));
    db.my = { rsvp: null, deadline: "2026-08-16T05:59:00Z", editable: false };
    await user.click(screen.getByRole("button", { name: "Guardar respuesta" }));

    expect(await screen.findByText("La fecha límite para confirmar asistencia ya pasó.")).toBeInTheDocument();
    expect(await screen.findByText(/Las confirmaciones cerraron el 15 de agosto de 2026/)).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    await waitFor(() => expect(db.log.filter((line) => line === "GET /cuencadas/2027/rsvp/me")).toHaveLength(2));
  });

  it("shows the attended badge on a past edition when the server marks a row isMe", async () => {
    db.attendees = [makeAttendee(2), makeAttendee(1, { displayName: ME.displayName, source: "attendance", rsvpStatus: null, isMe: true })];
    renderCard(2026);

    expect(await screen.findByText("🎉 Fuiste a esta Cuencada")).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(db.log).not.toContain("GET /cuencadas/2026/rsvp/me");
  });

  it("trusts isMe rather than matching ids on the client", async () => {
    db.attendees = [makeAttendee(1, { userId: ME.id, personId: ME.personId, isMe: false })];
    renderCard(2026);

    await waitFor(() => expect(db.log).toContain("GET /cuencadas/2026/attendees"));
    expect(screen.queryByText(/Fuiste a esta Cuencada/)).not.toBeInTheDocument();
  });

  it("shows no badge on a past edition the member missed", async () => {
    db.attendees = [makeAttendee(2)];
    renderCard(2026);

    await waitFor(() => expect(db.log).toContain("GET /cuencadas/2026/attendees"));
    expect(screen.queryByText(/Fuiste a esta Cuencada/)).not.toBeInTheDocument();
  });
});
