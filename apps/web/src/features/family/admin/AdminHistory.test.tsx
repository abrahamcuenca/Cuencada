/**
 * WP-4.1: the admin "Historial" tab, "Deshacer", "Borrar historial", delete
 * with "Borrar también el historial", and the "Actividad del árbol" page.
 * Fictional people only.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authenticatedState, makeUser } from "../../../../test/auth";
import { createTestServer } from "../../../../test/msw";
import { renderApp } from "../../../../test/renderApp";
import { type FamilyDb, familyHandlers, fixtureId, IDS, makeFamilyDb, makeRevision } from "../testing/fixtures";
import { changedFieldLabels, revisionSummary } from "./components/RevisionList";

const server = createTestServer();
let db: FamilyDb;
const admin = makeUser({ role: "admin" });

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  db = makeFamilyDb();
  server.use(...familyHandlers(db));
});
afterEach(() => server.resetHandlers());

function writes(): FamilyDb["log"] {
  return db.log.filter((entry) => entry.method !== "GET");
}

describe("revision summaries", () => {
  it("names the changed fields of an edit and the kind of a relationship change", () => {
    const edit = makeRevision(1);
    expect(changedFieldLabels(edit.before, edit.after)).toEqual(["apodo"]);
    expect(revisionSummary(edit)).toBe("Editó datos: apodo");
    const rel = makeRevision(2, {
      action: "relationship.create",
      before: null,
      after: { type: "relationship", personId: IDS.raul, id: fixtureId(900), kind: "partner_of", fromPersonId: IDS.raul, toPersonId: IDS.diego }
    });
    expect(revisionSummary(rel)).toBe("Agregó un parentesco (pareja)");
  });
});

describe("AdminPersonPage · Historial", { timeout: 15_000 }, () => {
  it("lists the person's changes and undoes one", async () => {
    const user = userEvent.setup();
    db.revisions = [makeRevision(2), makeRevision(1, { action: "person.create", before: null, revertible: false, revertedByRevisionId: fixtureId(799) })];
    renderApp(`/admin/familia/${IDS.raul}`, authenticatedState(admin));

    await user.click(await screen.findByRole("tab", { name: "Historial" }));
    const panel = await screen.findByRole("region", { name: "Historial" });
    expect(await within(panel).findByText("Editó datos: apodo")).toBeInTheDocument();
    expect(within(panel).getByText("Agregó a una persona")).toBeInTheDocument();
    expect(within(panel).getByText("Deshecho")).toBeInTheDocument();
    // Only the revertible row offers «Deshacer».
    const undo = within(panel).getAllByRole("button", { name: /^Deshacer/ });
    expect(undo).toHaveLength(1);
    await user.click(undo[0] ?? panel);
    await waitFor(() => expect(writes()[0]).toMatchObject({ method: "POST", path: `/admin/revisions/${fixtureId(702)}/revert` }));
    expect(await screen.findByText("Deshicimos el cambio.")).toBeInTheDocument();
    expect(await within(panel).findAllByText("Deshecho")).toHaveLength(2);
  });

  it("purges the history after a confirmation sheet", async () => {
    const user = userEvent.setup();
    db.revisions = [makeRevision(1)];
    renderApp(`/admin/familia/${IDS.raul}`, authenticatedState(admin));
    await user.click(await screen.findByRole("tab", { name: "Historial" }));
    await user.click(await screen.findByRole("button", { name: "Borrar historial" }));
    const confirm = await screen.findByRole("alertdialog", { name: "¿Borrar el historial?" });
    expect(writes()).toHaveLength(0);
    await user.click(within(confirm).getByRole("button", { name: "Borrar historial" }));
    await waitFor(() => expect(writes()[0]).toMatchObject({ method: "POST", path: `/admin/people/${IDS.raul}/revisions/purge`, body: { confirm: true } }));
    expect(await screen.findByText("Borramos 1 cambio del historial.")).toBeInTheDocument();
    expect(await screen.findByText("Todavía no hay cambios registrados.")).toBeInTheDocument();
  });

  it("deletes with «Borrar también el historial» (purgeHistory=true)", async () => {
    const user = userEvent.setup();
    const { router } = renderApp(`/admin/familia/${IDS.raul}`, authenticatedState(admin));
    await user.click(await screen.findByLabelText(/Borrar también el historial/));
    await user.click(screen.getByRole("button", { name: "Quitar a Raúl Herrera Morales" }));
    const confirm = await screen.findByRole("alertdialog", { name: "¿Quitar a Raúl Herrera Morales?" });
    expect(confirm).toHaveTextContent("todo su historial");
    await user.click(within(confirm).getByRole("button", { name: "Quitar" }));
    await waitFor(() => expect(writes()[0]).toMatchObject({ method: "DELETE", path: `/admin/people/${IDS.raul}`, search: "?purgeHistory=true" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/admin/familia"));
  });

  it("deletes without purging by default", async () => {
    const user = userEvent.setup();
    renderApp(`/admin/familia/${IDS.raul}`, authenticatedState(admin));
    await user.click(await screen.findByRole("button", { name: "Quitar a Raúl Herrera Morales" }));
    const confirm = await screen.findByRole("alertdialog", { name: "¿Quitar a Raúl Herrera Morales?" });
    await user.click(within(confirm).getByRole("button", { name: "Quitar" }));
    await waitFor(() => expect(writes()[0]).toMatchObject({ method: "DELETE", path: `/admin/people/${IDS.raul}`, search: "" }));
  });
});

describe("FamilyActivityPage", { timeout: 15_000 }, () => {
  it("is linked from the Panel and lists every change with the person's name", async () => {
    db.revisions = [makeRevision(1)];
    renderApp("/admin", authenticatedState(admin));
    expect(await screen.findByRole("link", { name: /Actividad del árbol/ })).toHaveAttribute("href", "/admin/familia/actividad");

    renderApp("/admin/familia/actividad", authenticatedState(admin));
    expect(await screen.findByRole("heading", { level: 1, name: "Actividad del árbol" })).toBeInTheDocument();
    const changes = screen.getByRole("region", { name: "Cambios" });
    expect(await within(changes).findByRole("link", { name: "Raúl Herrera Morales" })).toHaveAttribute("href", `/admin/familia/${IDS.raul}`);
  });

  it("filters by action and by who made the change, and pages with «Cargar más»", async () => {
    const user = userEvent.setup();
    db.revisions = Array.from({ length: 25 }, (_, index) =>
      makeRevision(index + 1, {
        id: fixtureId(700 + index),
        actor: index % 2 === 0 ? { userId: fixtureId(950), displayName: "Ana Morales Vega" } : { userId: fixtureId(951), displayName: "Beto Pérez Sosa" }
      })
    );
    renderApp("/admin/familia/actividad", authenticatedState(admin));
    const changes = await screen.findByRole("region", { name: "Cambios" });
    await waitFor(() => expect(within(changes).getAllByRole("button", { name: /^Deshacer/ })).toHaveLength(20));
    await user.click(within(changes).getByRole("button", { name: "Cargar más" }));
    await waitFor(() => expect(within(changes).getAllByRole("button", { name: /^Deshacer/ })).toHaveLength(25));

    await user.click(within(changes).getAllByRole("button", { name: "Beto Pérez Sosa" })[0] ?? changes);
    expect(await screen.findByText(/Solo cambios de/)).toHaveTextContent("Beto Pérez Sosa");
    await waitFor(() => expect(db.log.some((entry) => entry.search.includes(`actorUserId=${fixtureId(951)}`))).toBe(true));
    await waitFor(() => expect(within(changes).getAllByRole("button", { name: /^Deshacer/ })).toHaveLength(12));

    await user.selectOptions(screen.getByLabelText("Tipo de cambio"), "person.delete");
    await waitFor(() => expect(db.log.some((entry) => entry.search.includes("action=person.delete"))).toBe(true));
    expect(await within(changes).findByText("No hay cambios con estos filtros.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Ver de todos" }));
    expect(screen.queryByText(/Solo cambios de/)).not.toBeInTheDocument();
  });
});
