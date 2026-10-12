/**
 * WP-6.4 (members): the Tíos / Primos / Tíos abuelos bands, "Es la misma
 * persona…" and "Conectar con…", the "¿No ves a tu familia?" CTA,
 * "Mis propuestas" and "Árbol completo". Fictional people only.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authenticatedState, makeUser } from "../../../../test/auth";
import { createTestServer } from "../../../../test/msw";
import { renderApp } from "../../../../test/renderApp";
import { type FamilyDb, familyHandlers, fixtureId, IDS, makeFamilyDb, makePerson, toSummary } from "../testing/fixtures";
import { makeProposal } from "../testing/oneTreeFixtures";

const server = createTestServer();
let db: FamilyDb;
const me = makeUser({ personId: IDS.jose });

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  db = makeFamilyDb();
  server.use(...familyHandlers(db));
});
afterEach(() => server.resetHandlers());

function posts(path: string): unknown[] {
  return db.log.filter((entry) => entry.method === "POST" && entry.path === path).map((entry) => entry.body);
}

describe("extended bands", { timeout: 15_000 }, () => {
  it("shows Tíos, Primos and Tíos abuelos for Valeria, as collapsible groups", async () => {
    // Raúl (Valeria's uncle) has a son; José's siblings are her great-uncles and great-aunts.
    db.people.set(fixtureId(40), makePerson(fixtureId(40), "Tomás Herrera Ruiz"));
    db.relationships.push({ id: fixtureId(140), kind: "parent_of", fromPersonId: IDS.raul, toPersonId: fixtureId(40) });
    renderApp(`/arbol/${IDS.valeria}`, authenticatedState(me));

    const tios = await screen.findByText(/^Tíos \(2\)$/);
    const group = tios.closest("details");
    if (group === null) throw new Error("no details");
    expect(within(group).getByRole("button", { name: "Ver a Raúl Herrera Morales" })).toBeInTheDocument();
    expect(within(group).getByRole("button", { name: "Ver a Diego Herrera Morales" })).toBeInTheDocument();
    const primos = screen.getByText(/^Primos \(1\)$/).closest("details");
    expect(primos && within(primos).getByRole("button", { name: "Ver a Tomás Herrera Ruiz" })).toBeInTheDocument();
    const great = screen.getByText(/^Tíos abuelos \(4\)$/).closest("details");
    expect(great && within(great).getAllByRole("button")).toHaveLength(4);
  });

  it("shows no bands when there are none (José)", async () => {
    renderApp("/arbol", authenticatedState(me));
    await screen.findByRole("heading", { level: 2, name: /^José Herrera Navarro/ });
    await waitFor(() => expect(screen.queryByText(/^Tíos/)).not.toBeInTheDocument());
  });
});

describe("proposals from the person page", { timeout: 15_000 }, () => {
  it("sends «Es la misma persona…» with the picked person and the note", async () => {
    const user = userEvent.setup();
    db.people.set(fixtureId(41), makePerson(fixtureId(41), "Raúl H. Morales"));
    renderApp(`/arbol/${IDS.raul}`, authenticatedState(me));
    await user.click(await screen.findByRole("button", { name: "Es la misma persona…" }));
    const dialog = await screen.findByRole("dialog", { name: "Es la misma persona…" });
    await user.type(within(dialog).getByLabelText("Buscar a la otra persona"), "Raúl H");
    await user.click(await within(dialog).findByRole("button", { name: "Elegir a Raúl H. Morales" }));
    await user.type(within(dialog).getByLabelText(/Nota para el administrador/), "Es mi hijo, lo agregó mi prima.");
    await user.click(within(dialog).getByRole("button", { name: "Enviar propuesta" }));

    expect(await screen.findByText(/Enviamos tu propuesta/)).toBeInTheDocument();
    expect(posts("/family/proposals")).toEqual([
      { kind: "same_person", fromPersonId: IDS.raul, toPersonId: fixtureId(41), note: "Es mi hijo, lo agregó mi prima." }
    ]);
  });

  it("sends «Conectar con…» with the chosen relation, ordered for parent_of", async () => {
    const user = userEvent.setup();
    db.people.set(fixtureId(42), makePerson(fixtureId(42), "Gregorio Navarro Paz"));
    renderApp(`/arbol/${IDS.elsa}`, authenticatedState(me));
    await user.click(await screen.findByRole("button", { name: "Conectar con…" }));
    const dialog = await screen.findByRole("dialog", { name: "Conectar con…" });
    // Nothing to send until a person is picked.
    expect(within(dialog).getByRole("button", { name: "Enviar propuesta" })).toBeDisabled();
    await user.type(within(dialog).getByLabelText("Buscar a la otra persona"), "Gregorio");
    await user.click(await within(dialog).findByRole("button", { name: "Elegir a Gregorio Navarro Paz" }));
    await user.click(within(dialog).getByRole("radio", { name: "Es su padre o madre" }));
    await user.click(within(dialog).getByRole("button", { name: "Enviar propuesta" }));
    await screen.findByText(/Enviamos tu propuesta/);
    expect(posts("/family/proposals")).toEqual([
      { kind: "relate", relation: "parent_of", fromPersonId: fixtureId(42), toPersonId: IDS.elsa, note: null }
    ]);
  });

  it("shows the server's message on a duplicate", async () => {
    const user = userEvent.setup();
    server.use(
      (await import("msw")).http.post(
        "*/api/family/proposals",
        () =>
          new Response(
            JSON.stringify({
              error: { code: "CONFLICT", message: "Ya propusiste algo sobre estas dos personas.", details: [{ path: "proposal", message: "x", code: "PROPOSAL_DUPLICATE" }] }
            }),
            { status: 409, headers: { "content-type": "application/json" } }
          )
      )
    );
    renderApp(`/arbol/${IDS.raul}`, authenticatedState(me));
    await user.click(await screen.findByRole("button", { name: "Es la misma persona…" }));
    const dialog = await screen.findByRole("dialog", { name: "Es la misma persona…" });
    await user.type(within(dialog).getByLabelText("Buscar a la otra persona"), "Diego");
    await user.click(await within(dialog).findByRole("button", { name: "Elegir a Diego Herrera Morales" }));
    await user.click(within(dialog).getByRole("button", { name: "Enviar propuesta" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Ya propusiste algo sobre estas dos personas.");
  });
});

describe("¿No ves a tu familia? CTA", { timeout: 15_000 }, () => {
  it("shows on your own node when your branch is not connected to the root, and opens «Conectar con…»", async () => {
    const user = userEvent.setup();
    db.viewerConnected = false;
    renderApp("/arbol", authenticatedState(me));
    const cta = await screen.findByRole("complementary", { name: "¿No ves a tu familia? Propón una conexión" });
    await user.click(within(cta).getByRole("button", { name: "Proponer una conexión" }));
    expect(await screen.findByRole("dialog", { name: "Conectar con…" })).toBeInTheDocument();
  });

  it("stays hidden when connected (or without a root)", async () => {
    db.rootId = IDS.ernesto;
    renderApp("/arbol", authenticatedState(me));
    await screen.findByRole("heading", { level: 2, name: /^José Herrera Navarro/ });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText("¿No ves a tu familia? Propón una conexión")).not.toBeInTheDocument();
  });
});

describe("Mis propuestas", { timeout: 15_000 }, () => {
  it("lists statuses, the admin's note, a deleted person, and withdraws a pending one", async () => {
    const user = userEvent.setup();
    const raul = db.people.get(IDS.raul);
    const diego = db.people.get(IDS.diego);
    if (raul === undefined || diego === undefined) throw new Error("fixture");
    db.proposals = [
      makeProposal(db, { kind: "same_person", from: toSummary(raul), to: toSummary(diego), note: "Creo que son el mismo." }),
      makeProposal(db, { kind: "relate", relation: "partner_of", from: null, to: toSummary(raul), status: "rejected", resolutionNote: "Nunca fueron pareja." })
    ];
    renderApp("/arbol/propuestas", authenticatedState(me));

    const pending = await screen.findByRole("article", { name: "Raúl Herrera Morales es la misma persona que Diego Herrera Morales" });
    expect(within(pending).getByText("Pendiente")).toBeInTheDocument();
    expect(within(pending).getByText("Creo que son el mismo.")).toBeInTheDocument();
    const rejected = screen.getByRole("article", { name: "una persona eliminada y Raúl Herrera Morales son pareja" });
    expect(within(rejected).getByText("Rechazada")).toBeInTheDocument();
    expect(within(rejected).getByText(/Nunca fueron pareja\./)).toBeInTheDocument();
    expect(within(rejected).queryByRole("button", { name: "Retirar" })).not.toBeInTheDocument();

    await user.click(within(pending).getByRole("button", { name: "Retirar" }));
    expect(await within(pending).findByText("Retirada")).toBeInTheDocument();
  });

  it("opens a proposal from the notification link /arbol?propuesta= (WP-6.1), focused", async () => {
    const raul = db.people.get(IDS.raul);
    const diego = db.people.get(IDS.diego);
    if (raul === undefined || diego === undefined) throw new Error("fixture");
    const target = makeProposal(db, { kind: "same_person", from: toSummary(raul), to: toSummary(diego), status: "approved", resolutionNote: "Listo." });
    db.proposals = [makeProposal(db, { kind: "relate", relation: "partner_of", from: toSummary(diego), to: toSummary(raul) }), target];
    renderApp(`/arbol?propuesta=${target.id}`, authenticatedState(me));
    const article = await screen.findByRole("article", { name: "Raúl Herrera Morales es la misma persona que Diego Herrera Morales" });
    await waitFor(() => expect(article).toHaveFocus());
    expect(article).toHaveAttribute("aria-current", "true");
    expect(within(article).getByText(/Listo\./)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Mis propuestas" })).toBeInTheDocument();
  });

  it("shows an empty state", async () => {
    renderApp("/arbol/propuestas", authenticatedState(me));
    expect(await screen.findByText("Aún no has propuesto nada")).toBeInTheDocument();
  });
});

describe("Árbol completo", { timeout: 15_000 }, () => {
  it("explains a missing root", async () => {
    renderApp("/arbol/completo", authenticatedState(me));
    expect(await screen.findByText("Aún no hay una raíz del árbol")).toBeInTheDocument();
  });

  it("outlines from the root, loads a generation on demand and goes to me", async () => {
    const user = userEvent.setup();
    db.rootId = IDS.ernesto;
    renderApp("/arbol/completo", authenticatedState(me));

    const root = await screen.findByRole("link", { name: /^Ernesto Herrera Ríos/ });
    expect(root.parentElement).toHaveTextContent("1890 – 1961 · 1 hijo");
    // Depth 2 is loaded at once: Luis's children are known but folded.
    const luisToggle = screen.getByRole("button", { name: "Mostrar hijos de Luis Herrera Soto" });
    expect(luisToggle).toHaveAttribute("aria-expanded", "false");
    await user.click(luisToggle);
    const jose = await screen.findByRole("link", { name: /^José Herrera Navarro «Pepe»/ });
    expect(jose).toBeInTheDocument();
    // José's children are not loaded yet: expanding fetches the next generation (`personId` = José).
    const requests: string[] = [];
    server.events.on("request:start", ({ request }) => {
      if (request.url.includes("/family/overview")) requests.push(new URL(request.url).search);
    });
    await user.click(screen.getByRole("button", { name: "Mostrar hijos de José Herrera Navarro" }));
    expect(await screen.findByRole("link", { name: /^Inés Herrera Morales/ })).toBeInTheDocument();
    expect(requests).toContain(`?personId=${IDS.jose}&depth=1`);
    // José's partner shows beside him (names only).
    expect(screen.getByRole("link", { name: /^José Herrera Navarro/ }).parentElement).toHaveTextContent("n. 1952 · y Ana Morales Vega · 3 hijos");
    server.events.removeAllListeners();

    await user.click(screen.getByRole("button", { name: "Ocultar hijos de Luis Herrera Soto" }));
    expect(screen.queryByRole("link", { name: /^José Herrera Navarro/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Ir a mí" }));
    const mine = await screen.findByRole("link", { name: /^José Herrera Navarro/ });
    await waitFor(() => expect(mine).toHaveFocus());
  });
});
