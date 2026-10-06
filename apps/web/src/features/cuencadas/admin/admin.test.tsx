import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { apiUrl, authenticatedState, errorBody, makeUser } from "../../../../test/auth";
import { renderApp } from "../../../../test/renderApp";
import { CUENCADA_2026_ID, makeAdminCuencada, makeAdminDetail } from "../testing/fixtures";

const requests: { method: string; path: string; body: unknown }[] = [];

async function record(request: Request): Promise<void> {
  const text = request.method === "GET" ? "" : await request.text();
  requests.push({ method: request.method, path: new URL(request.url).pathname, body: text ? JSON.parse(text) : null });
}

const server = setupServer(
  http.get(apiUrl("/admin/cuencadas"), () => HttpResponse.json([makeAdminCuencada()])),
  http.get(apiUrl("/admin/announcements"), () => HttpResponse.json([])),
  http.get(apiUrl(`/admin/cuencadas/${CUENCADA_2026_ID}`), () => HttpResponse.json(makeAdminDetail())),
  http.get(apiUrl(`/admin/cuencadas/${CUENCADA_2026_ID}/daily-messages`), () => HttpResponse.json([])),
  http.post(apiUrl("/admin/cuencadas"), async ({ request }) => {
    await record(request);
    return HttpResponse.json(errorBody("CONFLICT", "Ya existe."), { status: 409 });
  }),
  http.post(apiUrl(`/admin/cuencadas/${CUENCADA_2026_ID}/daily-messages/import`), async ({ request }) => {
    await record(request);
    return HttpResponse.json(
      { error: { code: "VALIDATION", message: "Hay líneas con error.", details: [{ path: "lines.1", message: "Esa fecha está fuera de la Cuencada." }] } },
      { status: 400 }
    );
  })
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  server.resetHandlers();
  requests.length = 0;
});
afterAll(() => server.close());

const admin = (): ReturnType<typeof authenticatedState> => authenticatedState(makeUser({ role: "admin" }));

describe("AdminCuencadasPage", () => {
  it("lists editions with their publish state", async () => {
    renderApp("/admin/cuencadas", admin());

    const list = await screen.findByRole("region", { name: "Lista de Cuencadas" });
    const link = await within(list).findByRole("link", { name: /2026 · Mérida/ });
    expect(link).toHaveAttribute("href", `/admin/cuencadas/${CUENCADA_2026_ID}`);
    expect(within(link).getByText("Publicada")).toBeInTheDocument();
  });

  it("validates the create form in Spanish and sends nothing while it is invalid", async () => {
    const user = userEvent.setup();
    renderApp("/admin/cuencadas", admin());

    await user.click(await screen.findByRole("button", { name: "Nueva" }));
    await user.click(screen.getByRole("button", { name: "Crear borrador" }));

    const form = screen.getByRole("form", { name: "Nueva Cuencada" });
    expect(within(form).getByText("Escribe un año entre 1900 y 2200.")).toBeInTheDocument();
    expect(within(form).getAllByText("Este campo es obligatorio.").length).toBeGreaterThan(0);
    expect(within(form).getByLabelText("Año")).toHaveAttribute("aria-invalid", "true");

    await user.type(within(form).getByLabelText("Año"), "2027");
    await user.type(within(form).getByLabelText("Título"), "Cuencada 2027");
    await user.type(within(form).getByLabelText("Descripción"), "Nos vemos en Oaxaca.");
    await user.type(within(form).getByLabelText("Ciudad"), "Oaxaca");
    await user.type(within(form).getByLabelText("Estado"), "Oaxaca");
    fireEvent.change(within(form).getByLabelText("Inicio"), { target: { value: "2027-07-10T10:00" } });
    fireEvent.change(within(form).getByLabelText("Fin"), { target: { value: "2027-07-09T10:00" } });
    await user.type(within(form).getByLabelText(/Grupo de WhatsApp/), "http://chat.whatsapp.com/x");
    await user.click(screen.getByRole("button", { name: "Crear borrador" }));

    expect(within(form).getByText("La fecha de fin debe ser posterior al inicio.")).toBeInTheDocument();
    expect(within(form).getByText("El enlace debe ser una dirección https:// válida.")).toBeInTheDocument();
    expect(requests).toHaveLength(0);
  });

  it("sends wall-clock times in the edition's timezone and maps a duplicate year onto the field", async () => {
    const user = userEvent.setup();
    renderApp("/admin/cuencadas", admin());

    await user.click(await screen.findByRole("button", { name: "Nueva" }));
    const form = screen.getByRole("form", { name: "Nueva Cuencada" });
    await user.type(within(form).getByLabelText("Año"), "2026");
    await user.type(within(form).getByLabelText("Título"), "Otra 2026");
    await user.type(within(form).getByLabelText("Descripción"), "Duplicada.");
    await user.type(within(form).getByLabelText("Ciudad"), "Mérida");
    await user.type(within(form).getByLabelText("Estado"), "Yucatán");
    fireEvent.change(within(form).getByLabelText("Inicio"), { target: { value: "2026-09-13T00:00" } });
    fireEvent.change(within(form).getByLabelText("Fin"), { target: { value: "2026-09-18T23:59" } });
    await user.click(screen.getByRole("button", { name: "Crear borrador" }));

    expect(await within(form).findByText("Ya existe una Cuencada con ese año.")).toBeInTheDocument();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toMatchObject({
      year: 2026,
      timezone: "America/Merida",
      startsAt: "2026-09-13T00:00:00-06:00",
      endsAt: "2026-09-18T23:59:00-06:00",
      isPublished: false,
      whatsappUrl: null
    });
  });
});

describe("AdminCuencadaEditPage header and data form", () => {
  it("links to the edition's attendance screen", async () => {
    renderApp(`/admin/cuencadas/${CUENCADA_2026_ID}`, admin());

    expect(await screen.findByRole("link", { name: /Asistencia y confirmaciones/ })).toHaveAttribute(
      "href",
      `/admin/cuencadas/${CUENCADA_2026_ID}/asistencia`
    );
  });

  it("explains the forecast7.com URL format and rejects a www. address before sending", async () => {
    const user = userEvent.setup();
    renderApp(`/admin/cuencadas/${CUENCADA_2026_ID}`, admin());

    const field = await screen.findByLabelText(/Pronóstico del clima/);
    expect(field).toHaveAccessibleDescription(/https:\/\/forecast7\.com\/es\/.*sin «www\.»/);
    await user.clear(field);
    await user.type(field, "https://www.forecast7.com/es/20d97n89d59/merida/");
    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));

    expect(await screen.findByText("Usa una dirección que empiece con https://forecast7.com/ (sin «www.»).")).toBeInTheDocument();
    expect(requests).toHaveLength(0);
  });
});

describe("AdminCuencadaEditPage itinerary tags", () => {
  it("adds tags as chips (Enter or Agregar), removes one, caps them at 6 and sends them", async () => {
    server.use(
      http.post(apiUrl(`/admin/cuencadas/${CUENCADA_2026_ID}/itinerary`), async ({ request }) => {
        await record(request);
        return HttpResponse.json(makeAdminDetail().itinerary[0]);
      })
    );
    const user = userEvent.setup();
    renderApp(`/admin/cuencadas/${CUENCADA_2026_ID}`, admin());
    await user.click(await screen.findByRole("tab", { name: /Programa/ }));
    await user.click(screen.getByRole("button", { name: /Agregar actividad/ }));
    const form = screen.getByRole("form", { name: "Nueva actividad" });
    await user.type(within(form).getByLabelText("Título"), "Cenote");

    const input = within(form).getByLabelText(/^Etiquetas/);
    expect(input).toHaveAttribute("maxLength", "24");
    await user.type(input, "Incluye comida{Enter}");
    await user.type(input, "incluye COMIDA{Enter}");
    for (const tag of ["Traje de baño", "Niños", "Transporte", "Gratis"]) await user.type(input, `${tag}{Enter}`);
    await user.type(input, "Sombrero");
    await user.click(within(form).getByRole("button", { name: "Agregar" }));

    const chips = within(form).getByRole("list", { name: /Etiquetas/ });
    expect(within(chips).getAllByRole("listitem")).toHaveLength(6);
    expect(input).toBeDisabled();
    await user.click(within(form).getByRole("button", { name: "Quitar la etiqueta Gratis" }));
    expect(within(chips).getAllByRole("listitem")).toHaveLength(5);

    await user.click(within(form).getByRole("button", { name: "Agregar actividad" }));
    expect(await screen.findByText("Actividad agregada.")).toBeInTheDocument();
    expect(requests[0]?.body).toMatchObject({ title: "Cenote", tags: ["Incluye comida", "Traje de baño", "Niños", "Transporte", "Sombrero"] });
  });
});

describe("AdminCuencadaEditPage reorder", () => {
  it("moves a location up with the ↑ button and sends the full new order", async () => {
    server.use(
      http.put(apiUrl(`/admin/cuencadas/${CUENCADA_2026_ID}/locations/order`), async ({ request }) => {
        await record(request);
        return HttpResponse.json([]);
      })
    );
    const user = userEvent.setup();
    renderApp(`/admin/cuencadas/${CUENCADA_2026_ID}`, admin());
    await user.click(await screen.findByRole("tab", { name: /Lugares/ }));

    expect(screen.getByRole("button", { name: "Subir «Hotel Chariot Mérida»" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Subir «Cenote Santa Bárbara»" }));

    const detail = makeAdminDetail();
    const [first, second] = detail.locations;
    expect(requests).toEqual([
      { method: "PUT", path: `/api/admin/cuencadas/${CUENCADA_2026_ID}/locations/order`, body: { ids: [second?.id, first?.id] } }
    ]);
  });
});

describe("AdminCuencadaEditPage daily messages import", () => {
  async function openMessagesTab(): Promise<HTMLElement> {
    const user = userEvent.setup();
    renderApp(`/admin/cuencadas/${CUENCADA_2026_ID}`, admin());
    await user.click(await screen.findByRole("tab", { name: /Mensajes/ }));
    return screen.getByRole("form", { name: "Importar mensajes del día" });
  }

  it("keeps the import mode labels short enough for a 375px select", async () => {
    const form = await openMessagesTab();
    const select = within(form).getByLabelText(/Al importar/);
    const labels = within(select).getAllByRole("option").map((option) => option.textContent ?? "");
    expect(labels).toEqual(["Agregar o actualizar", "Reemplazar todo"]);
    for (const label of labels) expect(label.length).toBeLessThanOrEqual(24);
    expect(select).toHaveAccessibleDescription(/conserva los demás/);
  });

  it("lists every invalid line with its number and sends nothing", async () => {
    const form = await openMessagesTab();
    fireEvent.change(within(form).getByLabelText("Pega los mensajes"), {
      target: { value: "2026-09-13|¡Bienvenidos!\nsin separador\n2026-13-40|fecha imposible\n\n# comentario\n2026-09-13|repetido" }
    });
    fireEvent.click(within(form).getByRole("button", { name: "Importar mensajes" }));

    const errors = await within(form).findByRole("list", { name: "Líneas con error" });
    const items = within(errors).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("Línea 2: Formato esperado: AAAA-MM-DD|mensaje.");
    expect(items[0]).toHaveTextContent("sin separador");
    expect(items[1]).toHaveTextContent("Línea 3: Fecha inválida (AAAA-MM-DD).");
    expect(items[2]).toHaveTextContent("Línea 6: Fecha repetida (ya aparece en la línea 1).");
    expect(within(form).getByText("Hay 3 líneas con error. No se importó nada.")).toBeInTheDocument();
    expect(requests).toHaveLength(0);
  });

  it("shows the server's per-line errors when the import is refused", async () => {
    const form = await openMessagesTab();
    fireEvent.change(within(form).getByLabelText("Pega los mensajes"), { target: { value: "2030-01-01|Fuera de fechas" } });
    fireEvent.click(within(form).getByRole("button", { name: "Importar mensajes" }));

    const errors = await within(form).findByRole("list", { name: "Líneas con error" });
    expect(within(errors).getByRole("listitem")).toHaveTextContent("Línea 1: Esa fecha está fuera de la Cuencada.");
    expect(requests).toEqual([
      { method: "POST", path: `/api/admin/cuencadas/${CUENCADA_2026_ID}/daily-messages/import`, body: { text: "2030-01-01|Fuera de fechas", mode: "merge" } }
    ]);
  });
});
