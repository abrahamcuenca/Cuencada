/**
 * WP-6.4 (admins): "Propuestas del árbol" (grouped queue, approve with the
 * merge preview, conflicts, reject with a note) and "Ramas sin conectar"
 * (root setting, branches with matches). Fictional people only.
 */
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authenticatedState, makeUser } from "../../../../../test/auth";
import { createTestServer } from "../../../../../test/msw";
import { renderApp } from "../../../../../test/renderApp";
import { type FamilyDb, familyHandlers, IDS, makeFamilyDb, toSummary } from "../../testing/fixtures";
import { addDuplicate, DUPLICATE_ID, makeMergeState, type MergeState, mergeHandlers } from "../../testing/mergeFixtures";
import { makeProposal } from "../../testing/oneTreeFixtures";
import { describeProposal } from "../labels";
import { resolveErrorLines } from "./ResolveDialog";

const server = createTestServer();
let db: FamilyDb;
let state: MergeState;
const admin = makeUser({ role: "admin" });

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  db = makeFamilyDb();
  state = makeMergeState();
  server.use(...mergeHandlers(db, state), ...familyHandlers(db));
});
afterEach(() => server.resetHandlers());

function resolves(): unknown[] {
  return db.log.filter((entry) => entry.method === "POST" && entry.path.endsWith("/resolve")).map((entry) => entry.body);
}

/** Two members proposed that Raúl's copy is Raúl. */
function seedSamePerson(): void {
  const duplicate = addDuplicate(db, { userId: null });
  const raul = db.people.get(IDS.raul);
  if (raul === undefined) throw new Error("fixture");
  db.proposals = [
    makeProposal(db, { kind: "same_person", from: toSummary(duplicate), to: toSummary(raul), note: "Es mi primo, está repetido.", proposedByName: "Inés Herrera Morales", isMine: false }),
    makeProposal(db, { kind: "same_person", from: toSummary(raul), to: toSummary(duplicate), proposedByName: "Diego Herrera Morales", isMine: false, createdAt: "2026-10-04T10:00:00.000Z" })
  ];
}

describe("Propuestas del árbol", { timeout: 20_000 }, () => {
  it("groups a pair's proposals and approves with the merge preview (keep = to), applying to the pair", async () => {
    const user = userEvent.setup();
    seedSamePerson();
    renderApp("/admin/familia/propuestas", authenticatedState(admin));

    const card = await screen.findByRole("article", { name: "Raúl Herrera Morales es la misma persona que Raúl Herrera M." });
    expect(within(card).getByText("Es mi primo, está repetido.")).toBeInTheDocument();
    expect(within(card).getAllByText("Pendiente")).toHaveLength(2);
    await user.click(within(card).getByRole("button", { name: "Aprobar…" }));

    const dialog = await screen.findByRole("dialog", { name: "Aprobar propuesta" });
    expect(within(dialog).getByText(/Otra propuesta igual de este par/)).toHaveTextContent("tu nota llegará a cada persona que la propuso");
    expect(within(dialog).getByText("La ven todas las personas que propusieron esto.")).toBeInTheDocument();
    // The oldest pending one (Diego's: Raúl → copy) is the target, so the copy stays by default.
    expect(await within(dialog).findByText(/Se queda/)).toHaveTextContent("Se queda Raúl Herrera M.; Raúl Herrera Morales se fusiona");
    await user.click(within(dialog).getByRole("button", { name: "Cambiar cuál se queda" }));
    expect(within(dialog).getByText(/Se queda/)).toHaveTextContent("Se queda Raúl Herrera Morales;");
    await user.type(within(dialog).getByLabelText(/Nota para quien propuso/), "Gracias, ya quedó.");
    await user.click(within(dialog).getByRole("button", { name: "Aprobar y fusionar" }));

    expect(await screen.findByText("Aprobamos la propuesta: el árbol ya está unido.")).toBeInTheDocument();
    expect(resolves()).toEqual([{ decision: "approve", note: "Gracias, ya quedó.", applyToPair: true, keepPersonId: IDS.raul }]);
  });

  it("explains a conflict and keeps the dialog open (the proposal stays pending)", async () => {
    const user = userEvent.setup();
    seedSamePerson();
    db.resolveError = {
      status: 409,
      body: {
        error: {
          code: "CONFLICT",
          message: "No se pueden fusionar: algunas relaciones romperían las reglas del árbol.",
          details: [{ path: "relationships.x", message: "Padres e hijos: Con esta relación, alguien quedaría con más de dos padres.", code: "MERGE_CONFLICT" }]
        }
      }
    };
    renderApp("/admin/familia/propuestas", authenticatedState(admin));
    const card = await screen.findByRole("article", { name: /es la misma persona que/ });
    await user.click(within(card).getByRole("button", { name: "Aprobar…" }));
    const dialog = await screen.findByRole("dialog", { name: "Aprobar propuesta" });
    await user.click(await within(dialog).findByRole("button", { name: "Aprobar y fusionar" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("algunas relaciones romperían las reglas del árbol");
    expect(alert).toHaveTextContent("más de dos padres");
  });

  it("rejects with a note", async () => {
    const user = userEvent.setup();
    const raul = db.people.get(IDS.raul);
    const ana = db.people.get(IDS.ana);
    if (raul === undefined || ana === undefined) throw new Error("fixture");
    db.proposals = [makeProposal(db, { kind: "relate", relation: "partner_of", from: toSummary(raul), to: toSummary(ana), isMine: false })];
    renderApp("/admin/familia/propuestas", authenticatedState(admin));
    const card = await screen.findByRole("article", { name: "Raúl Herrera Morales y Ana Morales Vega son pareja" });
    await user.click(within(card).getByRole("button", { name: "Rechazar…" }));
    const dialog = await screen.findByRole("dialog", { name: "Rechazar propuesta" });
    await user.type(within(dialog).getByLabelText(/Nota para quien propuso/), "Son madre e hijo.");
    await user.click(within(dialog).getByRole("button", { name: "Rechazar" }));
    await screen.findByText("Rechazamos la propuesta.");
    expect(resolves()).toEqual([{ decision: "reject", note: "Son madre e hijo.", applyToPair: true }]);
  });

  it("shows an empty queue", async () => {
    renderApp("/admin/familia/propuestas", authenticatedState(admin));
    expect(await screen.findByText("No hay propuestas pendientes.")).toBeInTheDocument();
  });
});

describe("Ramas sin conectar", { timeout: 20_000 }, () => {
  it("sets the root and lists branches with their matches", async () => {
    const user = userEvent.setup();
    const duplicate = addDuplicate(db, { userId: null });
    const raul = db.people.get(IDS.raul);
    if (raul === undefined) throw new Error("fixture");
    db.branches = {
      rootPersonId: IDS.ernesto,
      nextCursor: null,
      items: [
        {
          id: DUPLICATE_ID,
          people: [toSummary(duplicate)],
          size: 3,
          linkedAccounts: 1,
          suggestedMatches: [{ person: toSummary(duplicate), candidate: toSummary(raul), reasons: ["similar_name", "same_partner"], score: 75 }]
        }
      ]
    };
    renderApp("/admin/familia/ramas", authenticatedState(admin));

    const root = await screen.findByRole("region", { name: "Raíz del árbol" });
    expect(within(root).getByText("Sin raíz todavía")).toBeInTheDocument();
    await user.click(within(root).getByRole("button", { name: "Elegir la raíz" }));
    const dialog = await screen.findByRole("dialog", { name: "Raíz del árbol" });
    await user.type(within(dialog).getByLabelText("Buscar persona"), "Ernesto");
    await user.click(await within(dialog).findByRole("button", { name: /^Elegir a Ernesto Herrera Ríos/ }));
    expect(await within(root).findByText("Ernesto Herrera Ríos")).toBeInTheDocument();
    expect(db.log.find((entry) => entry.method === "PUT")?.body).toEqual({ rootPersonId: IDS.ernesto });

    const branch = screen.getByRole("article", { name: "Rama de Raúl Herrera M." });
    expect(within(branch).getByText("3 personas · 1 con cuenta")).toBeInTheDocument();
    expect(within(branch).getByText("Nombre parecido")).toBeInTheDocument();
    expect(within(branch).getByText("Misma pareja")).toBeInTheDocument();
    await user.click(within(branch).getByRole("button", { name: "Revisar fusión: Raúl Herrera M. con Raúl Herrera Morales" }));
    expect(await screen.findByRole("dialog", { name: /Fusionar/ })).toBeInTheDocument();
  });

  it("says when everything is connected", async () => {
    db.rootId = IDS.ernesto;
    renderApp("/admin/familia/ramas", authenticatedState(admin));
    expect(await screen.findByText("Todo el árbol está conectado")).toBeInTheDocument();
  });
});

describe("one-tree helpers", () => {
  it("describes proposals and refused resolves", () => {
    expect(describeProposal({ kind: "relate", relation: "parent_of", from: null, to: { id: IDS.ana, userId: null, fullName: "Ana", nickname: null, deceased: false, avatarUrl: null } })).toBe(
      "una persona eliminada es padre o madre de Ana"
    );
    expect(resolveErrorLines({ status: "FETCH_ERROR", error: "x" })).toEqual(["Algo salió mal. Revisa tu conexión e inténtalo de nuevo."]);
  });
});
