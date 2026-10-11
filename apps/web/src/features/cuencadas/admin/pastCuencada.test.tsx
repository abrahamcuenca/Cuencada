import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { apiUrl, authenticatedState, errorBody, makeUser } from "../../../../test/auth";
import { renderApp } from "../../../../test/renderApp";
import { CUENCADA_2019_ID, makeAdminCuencada } from "../testing/fixtures";
import { PAST_DATES_HINT, PAST_YEAR_ERROR, validatePastCuencadaForm } from "./components/PastCuencadaForm";

/** WP-5.1: "＋ Agregar Cuencada anterior" on /admin/cuencadas. Fictional data only. */

const posted: unknown[] = [];

const created2019 = makeAdminCuencada({
  id: CUENCADA_2019_ID,
  year: 2019,
  slug: "2019",
  title: "Cuencada 2019",
  status: "past",
  isHistorical: true,
  startsAt: null,
  endsAt: null,
  city: null,
  state: null
});

const server = setupServer(
  http.get(apiUrl("/admin/cuencadas"), () => HttpResponse.json([makeAdminCuencada()])),
  http.get(apiUrl("/admin/announcements"), () => HttpResponse.json([])),
  http.post(apiUrl("/admin/cuencadas"), async ({ request }) => {
    posted.push(await request.json());
    return HttpResponse.json(created2019, { status: 201 });
  })
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => {
  // Only Date is faked, so user-event and MSW timers keep working.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-11T18:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  server.resetHandlers();
  posted.length = 0;
});
afterAll(() => server.close());

const admin = (): ReturnType<typeof authenticatedState> => authenticatedState(makeUser({ role: "admin" }));

const blank = { year: "", title: "", description: "", city: "", state: "", startDate: "", endDate: "", heroImageUrl: "" };
const now = new Date("2026-10-11T18:00:00Z");

describe("validatePastCuencadaForm", () => {
  it("builds a historical, published body with null dates and place and a default title", () => {
    const result = validatePastCuencadaForm({ ...blank, year: "2019", description: "En casa de la abuela." }, now);
    expect(result).toEqual({
      ok: true,
      body: expect.objectContaining({
        year: 2019,
        title: "Cuencada 2019",
        startsAt: null,
        endsAt: null,
        city: null,
        state: null,
        heroImageUrl: null,
        timezone: "America/Merida",
        isHistorical: true,
        isPublished: true
      })
    });
  });

  it("turns calendar days into the first and last minute in Mérida, with that date's offset", () => {
    const winter = validatePastCuencadaForm({ ...blank, year: "2019", description: "x", startDate: "2019-12-27", endDate: "2019-12-27" }, now);
    expect(winter.ok && winter.body).toMatchObject({ startsAt: "2019-12-27T00:00:00-06:00", endsAt: "2019-12-27T23:59:00-06:00" });
    // Mérida still observed summer time in 2019 (UTC-5).
    const summer = validatePastCuencadaForm({ ...blank, year: "2019", description: "x", startDate: "2019-07-01", endDate: "2019-07-03" }, now);
    expect(summer.ok && summer.body).toMatchObject({ startsAt: "2019-07-01T00:00:00-05:00", endsAt: "2019-07-03T23:59:00-05:00" });
  });

  it("refuses the current or a future year, one date alone and an end before the start", () => {
    for (const year of ["2026", "2030"]) {
      expect(validatePastCuencadaForm({ ...blank, year, description: "x" }, now)).toEqual({ ok: false, errors: { year: PAST_YEAR_ERROR } });
    }
    const lone = validatePastCuencadaForm({ ...blank, year: "2019", description: "x", startDate: "2019-09-10" }, now);
    expect(lone.ok ? null : lone.errors.endDate).toBe("Escribe las dos fechas (inicio y fin) o deja ambas vacías.");
    const reversed = validatePastCuencadaForm({ ...blank, year: "2019", description: "x", startDate: "2019-09-10", endDate: "2019-09-09" }, now);
    expect(reversed.ok ? null : reversed.errors.endDate).toBe("El último día no puede ser anterior al primero.");
    const bad = validatePastCuencadaForm({ ...blank, year: "19" }, now);
    expect(bad.ok ? null : bad.errors).toMatchObject({ year: "Escribe un año de cuatro cifras desde 1900.", description: expect.any(String) });
  });

  it("uses the year in Mérida, not UTC, around New Year", () => {
    // 2027-01-01T03:00Z is still 2026 in Mérida: 2026 is not a past year yet.
    const result = validatePastCuencadaForm({ ...blank, year: "2026", description: "x" }, new Date("2027-01-01T03:00:00Z"));
    expect(result.ok).toBe(false);
  });
});

describe("AdminCuencadasPage — Agregar Cuencada anterior", () => {
  it("adds a past Cuencada without dates, published and historical, then links to Asistencia and Fotos", async () => {
    const user = userEvent.setup();
    renderApp("/admin/cuencadas", admin());

    await user.click(await screen.findByRole("button", { name: "Agregar Cuencada anterior" }));
    const form = screen.getByRole("form", { name: "Cuencada anterior" });
    expect(within(form).getAllByText(PAST_DATES_HINT)).toHaveLength(2);

    await user.type(within(form).getByLabelText(/^Año/), "2026");
    await user.click(within(form).getByRole("button", { name: "Agregar y publicar" }));
    expect(within(form).getByText(PAST_YEAR_ERROR)).toBeInTheDocument();
    expect(posted).toHaveLength(0);

    await user.clear(within(form).getByLabelText(/^Año/));
    await user.type(within(form).getByLabelText(/^Año/), "2019");
    await user.type(within(form).getByLabelText(/^Descripción/), "Nos reunimos en la casa de la abuela.");
    await user.click(within(form).getByRole("button", { name: "Agregar y publicar" }));

    expect(await screen.findByText("Cuencada 2019 agregada")).toBeInTheDocument();
    expect(posted).toEqual([
      expect.objectContaining({ year: 2019, title: "Cuencada 2019", startsAt: null, endsAt: null, isHistorical: true, isPublished: true })
    ]);
    expect(screen.getByRole("link", { name: /Asistencia/ })).toHaveAttribute(
      "href",
      `/admin/cuencadas/${CUENCADA_2019_ID}/asistencia`
    );
    // The nav has its own "Fotos" link; the success card's goes to this year's gallery.
    expect(screen.getAllByRole("link", { name: /Fotos/ }).map((link) => link.getAttribute("href"))).toContain("/galeria/2019");
    expect(screen.queryByRole("form", { name: "Cuencada anterior" })).not.toBeInTheDocument();
  });

  it("sends dates as the first and last minute of the chosen days and shows a duplicate year on the field", async () => {
    server.use(
      http.post(apiUrl("/admin/cuencadas"), async ({ request }) => {
        posted.push(await request.json());
        return HttpResponse.json(errorBody("CONFLICT", "Ya existe una Cuencada para ese año."), { status: 409 });
      })
    );
    const user = userEvent.setup();
    renderApp("/admin/cuencadas", admin());

    await user.click(await screen.findByRole("button", { name: "Agregar Cuencada anterior" }));
    const form = screen.getByRole("form", { name: "Cuencada anterior" });
    await user.type(within(form).getByLabelText(/^Año/), "2018");
    await user.type(within(form).getByLabelText(/^Descripción/), "x");
    fireEvent.change(within(form).getByLabelText(/^Primer día/), { target: { value: "2018-12-26" } });
    fireEvent.change(within(form).getByLabelText(/^Último día/), { target: { value: "2018-12-28" } });
    await user.click(within(form).getByRole("button", { name: "Agregar y publicar" }));

    expect(await within(form).findByText("Ya existe una Cuencada con ese año.")).toBeInTheDocument();
    expect(posted).toEqual([expect.objectContaining({ startsAt: "2018-12-26T00:00:00-06:00", endsAt: "2018-12-28T23:59:00-06:00" })]);
  });

  it("marks historical editions in the list", async () => {
    server.use(http.get(apiUrl("/admin/cuencadas"), () => HttpResponse.json([makeAdminCuencada(), created2019])));
    renderApp("/admin/cuencadas", admin());

    const list = await screen.findByRole("region", { name: "Lista de Cuencadas" });
    const link = await within(list).findByRole("link", { name: /2019 · Lugar sin registrar/ });
    expect(within(link).getByText("Anterior")).toBeInTheDocument();
    expect(within(link).getByText("Fechas desconocidas")).toBeInTheDocument();
  });
});
