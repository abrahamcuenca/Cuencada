import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authenticatedState } from "../../../test/auth";
import { createTestServer } from "../../../test/msw";
import { renderApp } from "../../../test/renderApp";
import { ADMIN_USER, type AdminDb, adminHandlers, IDS, makeAdminDb, XSS_STRING } from "./testing/fixtures";

const server = createTestServer();
let db: AdminDb;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  db = makeAdminDb();
  server.use(...adminHandlers(db));
});
afterEach(() => server.resetHandlers());

function auditRequests(): AdminDb["log"] {
  return db.log.filter((entry) => entry.path === "/admin/audit-logs");
}

describe("AuditLogPage", { timeout: 15_000 }, () => {
  it("lists entries with actor names, es-MX timestamps and metadata as plain text", async () => {
    const container = document.body;
    renderApp("/admin/bitacora", authenticatedState(ADMIN_USER));

    const entries = await screen.findAllByRole("article");
    expect(entries).toHaveLength(25);
    const first = entries[0];
    if (first === undefined) throw new Error("no entries");
    expect(within(first).getByRole("heading")).toHaveTextContent("Elena Duarte Páez · Deshabilitó una cuenta");
    // 18:00Z is 12:00 in Mérida (UTC-6), formatted es-MX.
    expect(within(first).getByText(/6 oct 2026, 12:00/)).toHaveAttribute("dateTime", "2026-10-06T18:00:00.000Z");
    expect(within(first).getByText("revokedSessions")).toBeInTheDocument();
    expect(within(first).getByText("status")).toBeInTheDocument();

    // The stored XSS string is shown verbatim as text, never parsed as HTML.
    expect(within(first).getByText(XSS_STRING)).toBeInTheDocument();
    expect(container.querySelector("img[src='x']")).toBeNull();
    expect(container.querySelector("[onerror]")).toBeNull();

    expect(within(entries[1] ?? first).getByRole("heading")).toHaveTextContent("Sistema · Creó una invitación");
  });

  it("pages with «Cargar más» using the keyset cursor", async () => {
    const user = userEvent.setup();
    renderApp("/admin/bitacora", authenticatedState(ADMIN_USER));

    expect(await screen.findAllByRole("article")).toHaveLength(25);
    await user.click(screen.getByRole("button", { name: "Cargar más" }));

    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(30));
    expect(auditRequests().at(-1)?.query).toEqual({ limit: "25", cursor: "25" });
    expect(screen.queryByRole("button", { name: "Cargar más" })).not.toBeInTheDocument();
  });

  it("filters by action, type and date range in the portal timezone", async () => {
    const user = userEvent.setup();
    const { router } = renderApp("/admin/bitacora", authenticatedState(ADMIN_USER));
    await screen.findAllByRole("article");

    await user.selectOptions(screen.getByRole("combobox", { name: "Acción" }), "user.disabled");
    await user.selectOptions(screen.getByRole("combobox", { name: "Tipo" }), "user");
    await user.type(screen.getByLabelText("Desde"), "2026-10-06");
    await user.type(screen.getByLabelText("Hasta"), "2026-10-06");

    await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(1));
    expect(router.state.location.search).toBe("?accion=user.disabled&tipo=user&desde=2026-10-06&hasta=2026-10-06");
    expect(auditRequests().at(-1)?.query).toEqual({
      action: "user.disabled",
      entityType: "user",
      from: "2026-10-06T06:00:00.000Z",
      to: "2026-10-07T05:59:59.999Z",
      limit: "25"
    });
  });

  it("refuses an inverted date range without calling the API", async () => {
    renderApp("/admin/bitacora?desde=2026-10-07&hasta=2026-10-01", authenticatedState(ADMIN_USER));

    expect(await screen.findByText("La fecha «hasta» debe ser igual o posterior a «desde».")).toBeInTheDocument();
    expect(auditRequests()).toHaveLength(0);
  });

  it("filters by actor from an entry, and clears the filter", async () => {
    const user = userEvent.setup();
    const { router } = renderApp("/admin/bitacora", authenticatedState(ADMIN_USER));

    const [first] = await screen.findAllByRole("article");
    if (first === undefined) throw new Error("no entries");
    await user.click(within(first).getByRole("button", { name: "Elena Duarte Páez: ver solo sus acciones" }));
    await waitFor(() => expect(router.state.location.search).toBe(`?actor=${IDS.admin}`));
    await waitFor(() => expect(auditRequests().at(-1)?.query).toEqual({ actorUserId: IDS.admin, limit: "25" }));
    expect(screen.getByText("Solo las acciones de una persona")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Quitar filtro de persona" }));
    await waitFor(() => expect(router.state.location.search).toBe(""));
  });

  it("ignores invalid filter params instead of sending them", async () => {
    renderApp("/admin/bitacora?accion=%3Cscript%3E&tipo=nada&actor=123&desde=2026-02-31", authenticatedState(ADMIN_USER));

    await screen.findAllByRole("article");
    expect(auditRequests().at(-1)?.query).toEqual({ limit: "25" });
  });
});
