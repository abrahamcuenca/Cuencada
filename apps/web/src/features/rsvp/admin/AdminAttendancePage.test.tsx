import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { authenticatedState, makeUser } from "../../../../test/auth";
import { createTestServer } from "../../../../test/msw";
import { renderApp } from "../../../../test/renderApp";
import { CUENCADA_2027_ID, type FakeRsvpDb, makeAdminRow, makePerson, makeRsvpDb, personId, rsvpHandlers } from "../testing/fakeApi";

const server = createTestServer();
let db: FakeRsvpDb;
const PATH = `/admin/cuencadas/${CUENCADA_2027_ID}/asistencia`;
const admin = (): ReturnType<typeof authenticatedState> => authenticatedState(makeUser({ role: "admin" }));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  db = makeRsvpDb();
  db.people = [makePerson(2, "Rosa Cuenca"), makePerson(3, "Tomás Cuenca Ruiz", { nickname: "Tomy" }), makePerson(4, "Lucía Herrera")];
  db.attendance = [{ personId: personId(2), displayName: "Rosa Cuenca", createdAt: "2026-10-01T12:00:00Z" }];
  server.use(...rsvpHandlers(db));
});
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});

describe("AdminAttendancePage", () => {
  it("saves added and removed attendees in one bulk request", async () => {
    const user = userEvent.setup();
    renderApp(PATH, admin());

    expect(await screen.findByRole("heading", { name: "Asistencia" })).toBeInTheDocument();
    const rosa = await screen.findByRole("checkbox", { name: "Rosa Cuenca" });
    expect(rosa).toBeChecked();
    const tomas = await screen.findByRole("checkbox", { name: "Tomás Cuenca Ruiz" });
    expect(tomas).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Guardar asistencia" })).toBeDisabled();

    await user.click(rosa);
    await user.click(tomas);
    expect(screen.getByText("1 asistente · 2 cambios sin guardar")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Guardar asistencia" }));

    expect(await screen.findByText("Asistencia guardada.")).toBeInTheDocument();
    expect(db.bulkBodies).toEqual([{ add: [personId(3)], remove: [personId(2)] }]);
    expect(await screen.findByRole("checkbox", { name: "Tomás Cuenca Ruiz" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Rosa Cuenca" })).not.toBeChecked();
    expect(screen.getByText("1 asistente")).toBeInTheDocument();
  });

  it("drops an edit when the box is toggled back", async () => {
    const user = userEvent.setup();
    renderApp(PATH, admin());

    const lucia = await screen.findByRole("checkbox", { name: "Lucía Herrera" });
    await user.click(lucia);
    await user.click(lucia);
    expect(screen.getByRole("button", { name: "Guardar asistencia" })).toBeDisabled();
  });

  it("searches people, keeping matching saved attendees", async () => {
    const user = userEvent.setup();
    renderApp(PATH, admin());

    await screen.findByRole("checkbox", { name: "Lucía Herrera" });
    await user.type(screen.getByRole("searchbox", { name: "Buscar persona" }), "tomás");

    await waitFor(() => expect(screen.queryByRole("checkbox", { name: "Lucía Herrera" })).not.toBeInTheDocument());
    expect(screen.getByRole("checkbox", { name: "Tomás Cuenca Ruiz" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Rosa Cuenca" })).not.toBeInTheDocument();
    expect(db.log).toContain("GET /family/people?q=tom%C3%A1s&limit=100");
  });

  it("lists RSVPs with totals and a status filter", async () => {
    db.adminRows = [
      makeAdminRow(2, { displayName: "Rosa Cuenca", status: "yes", guestCount: 2 }),
      makeAdminRow(3, { displayName: "Tomás Cuenca Ruiz", status: "maybe", hotelName: null }),
      makeAdminRow(4, { displayName: "Lucía Herrera", status: "no" })
    ];
    db.summary = { ...db.summary, yes: 1, maybe: 1, no: 1, expectedPeople: 3 };
    const user = userEvent.setup();
    renderApp(PATH, admin());

    await user.click(await screen.findByRole("tab", { name: "Confirmaciones" }));
    expect(await screen.findByText("3 de 3 respuestas")).toBeInTheDocument();
    expect(screen.getByText("Personas esperadas").nextSibling).toHaveTextContent("3");

    await user.selectOptions(screen.getByRole("combobox", { name: "Respuesta" }), "maybe");
    expect(screen.getByText("1 de 3 respuestas")).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Respuestas" });
    expect(within(list).getByText("Tomás Cuenca Ruiz")).toBeInTheDocument();
    expect(within(list).queryByText("Rosa Cuenca")).not.toBeInTheDocument();
  });

  it("downloads the CSV through a blob without putting the token in the URL", async () => {
    const createObjectURL = vi.fn((_blob: Blob) => "blob:cuencada/csv");
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this);
    });
    const user = userEvent.setup();
    renderApp(PATH, admin());

    await user.click(await screen.findByRole("button", { name: "Exportar CSV" }));

    expect(await screen.findByText("Descargamos el CSV de confirmaciones.")).toBeInTheDocument();
    expect(db.log).toContain(`GET /admin/cuencadas/${CUENCADA_2027_ID}/rsvps.csv`);
    expect(clicked).toHaveLength(1);
    expect(clicked[0]?.download).toBe("cuencada-2027-confirmaciones.csv");
    expect(clicked[0]?.getAttribute("href")).toBe("blob:cuencada/csv");
    const blob = createObjectURL.mock.calls[0]?.[0];
    expect(blob?.type).toBe("text/csv;charset=utf-8");
    const bytes = new Uint8Array((await blob?.arrayBuffer()) ?? new ArrayBuffer(0));
    // UTF-8 BOM first, so Excel reads the accents.
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(await blob?.text()).toBe(db.csv);
    expect(document.querySelector("a[download]")).toBeNull();
  });
});
