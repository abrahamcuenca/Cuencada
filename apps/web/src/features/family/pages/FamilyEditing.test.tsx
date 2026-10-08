/**
 * WP-4.1: editing the family from the tree (members and admins), the
 * "Detalles" accordion and member delete. Fictional people only.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { apiUrl, authenticatedState, errorBody, makeUser } from "../../../../test/auth";
import { createTestServer } from "../../../../test/msw";
import { renderApp } from "../../../../test/renderApp";
import { MEMBER_LINK_NOTE } from "../components/addRelative";
import { type FamilyDb, familyHandlers, fixtureId, IDS, makeFamilyDb, makePerson } from "../testing/fixtures";

const server = createTestServer();
let db: FamilyDb;

const me = makeUser({ personId: IDS.jose });
const admin = makeUser({ role: "admin", personId: null });

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

async function focus(name: RegExp): Promise<HTMLElement> {
  return screen.findByRole("heading", { level: 2, name });
}

describe("Detalles accordion", { timeout: 15_000 }, () => {
  it("shows dates, birthplace and bio when the server sends them, and no photo or contacts slots when absent", async () => {
    const user = userEvent.setup();
    const luis = db.people.get(IDS.luis);
    if (!luis) throw new Error("fixture");
    db.people.set(IDS.luis, { ...luis, birthDate: "1921-03-04", deathDate: "1998-11-02", birthplace: "Pueblo Norte", bio: "Carpintero del pueblo." });
    renderApp(`/arbol/${IDS.luis}`, authenticatedState(me));

    await focus(/^Luis Herrera Soto/);
    const summary = await screen.findByText("Detalles");
    await user.click(summary);
    expect(screen.getByText("4 de marzo de 1921")).toBeVisible();
    expect(screen.getByText("2 de noviembre de 1998")).toBeVisible();
    expect(screen.getByText("Pueblo Norte")).toBeVisible();
    expect(screen.getByText("Carpintero del pueblo.")).toBeVisible();
    expect(screen.queryByRole("img", { name: /Foto de/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Contacto" })).not.toBeInTheDocument();
  });

  it("renders the photo and contacts slots when present (links as sent, rel=noopener)", async () => {
    const user = userEvent.setup();
    db.flags.set(IDS.ana, {
      photoUrl: "https://fake-storage.test/people/ana-256.webp?sig=get",
      photoSource: "person",
      contacts: [{ kind: "whatsapp", label: "WhatsApp", href: "https://wa.me/525550001111", display: "+52 555 000 1111" }]
    });
    renderApp(`/arbol/${IDS.ana}`, authenticatedState(me));
    await focus(/^Ana Morales Vega/);
    await user.click(await screen.findByText("Detalles"));
    expect(screen.getByRole("img", { name: "Foto de Ana Morales Vega" })).toBeInTheDocument();
    const link = within(screen.getByRole("list", { name: "Contacto" })).getByRole("link");
    expect(link).toHaveAttribute("href", "https://wa.me/525550001111");
    expect(link).toHaveAttribute("rel", "noopener noreferrer nofollow");
  });
});

describe("adding relatives as a member", { timeout: 15_000 }, () => {
  it("shows the add buttons only where the member may add (canAddRelative), never «2 parents» full", async () => {
    renderApp("/arbol", authenticatedState(me));
    await focus(/^José Herrera Navarro/);
    expect(await screen.findByRole("button", { name: "Agregar pareja" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Agregar hijo/a" })).toBeInTheDocument();
    // José already has two parents.
    expect(screen.queryByRole("button", { name: "Agregar padre o madre" })).not.toBeInTheDocument();
  });

  it("shows no add or edit buttons outside the member's circle", async () => {
    renderApp(`/arbol/${IDS.ines}`, authenticatedState(me));
    await focus(/^Inés Herrera Morales/);
    expect(screen.queryByRole("button", { name: /^Agregar/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Editar/ })).not.toBeInTheDocument();
  });

  it("creates a new child with dates (no search, a note to ask an admin) and shows it in the tree", async () => {
    const user = userEvent.setup();
    renderApp("/arbol", authenticatedState(me));
    await focus(/^José Herrera Navarro/);
    await user.click(await screen.findByRole("button", { name: "Agregar hijo/a" }));

    const sheet = await screen.findByRole("dialog", { name: "Agregar hijo/a" });
    expect(within(sheet).getByText(MEMBER_LINK_NOTE)).toBeInTheDocument();
    expect(within(sheet).queryByRole("searchbox")).not.toBeInTheDocument();

    await user.type(within(sheet).getByLabelText(/^Nombre completo/), "Lucía Herrera Morales");
    await user.type(within(sheet).getByLabelText(/^Fecha de nacimiento/), "1990-05-14");
    // The year follows the date.
    expect(within(sheet).getByLabelText(/^Año de nacimiento/)).toHaveValue("1990");
    await user.type(within(sheet).getByLabelText(/^Lugar de nacimiento/), "Pueblo Norte");
    await user.click(within(sheet).getByRole("button", { name: "Crear nueva persona" }));

    await waitFor(() => expect(writes()[0]).toMatchObject({ method: "POST", path: "/family/people" }));
    expect(writes()[0]?.body).toEqual({
      fullName: "Lucía Herrera Morales",
      nickname: null,
      familyBranch: null,
      birthYear: 1990,
      birthDate: "1990-05-14",
      deathYear: null,
      deathDate: null,
      deceased: false,
      birthplace: "Pueblo Norte",
      bio: null,
      relateTo: { personId: IDS.jose, kind: "child_of" }
    });
    const children = await screen.findByRole("region", { name: /^Hijos/ });
    expect(await within(children).findByRole("button", { name: "Ver a Lucía Herrera Morales" })).toBeInTheDocument();
  });

  it("clears the date when its year is cleared", async () => {
    const user = userEvent.setup();
    renderApp("/arbol", authenticatedState(me));
    await focus(/^José Herrera Navarro/);
    await user.click(await screen.findByRole("button", { name: "Agregar pareja" }));
    const sheet = await screen.findByRole("dialog", { name: "Agregar pareja" });
    await user.type(within(sheet).getByLabelText(/^Fecha de nacimiento/), "1956-01-20");
    await user.clear(within(sheet).getByLabelText(/^Año de nacimiento/));
    expect(within(sheet).getByLabelText(/^Fecha de nacimiento/)).toHaveValue("");
    // Death fields only with «Ya falleció»; un-ticking clears them.
    await user.click(within(sheet).getByLabelText(/Ya falleció/));
    await user.type(within(sheet).getByLabelText(/^Año de fallecimiento/), "2020");
    await user.click(within(sheet).getByLabelText(/Ya falleció/));
    await user.click(within(sheet).getByLabelText(/Ya falleció/));
    expect(within(sheet).getByLabelText(/^Año de fallecimiento/)).toHaveValue("");
  });

  it("shows the server's reason when the anchor is outside the member's circle (403)", async () => {
    const user = userEvent.setup();
    const reason = "Solo puedes cambiar a tu familia cercana. Pídele a un administrador que haga este cambio.";
    server.use(
      http.post(apiUrl("/family/people"), () =>
        HttpResponse.json(
          { error: { ...errorBody("FORBIDDEN", reason).error, details: [{ path: "relateTo.personId", message: reason, code: "FAMILY_NOT_IN_CIRCLE" }] } },
          { status: 403 }
        )
      )
    );
    renderApp("/arbol", authenticatedState(me));
    await focus(/^José Herrera Navarro/);
    await user.click(await screen.findByRole("button", { name: "Agregar hijo/a" }));
    const sheet = await screen.findByRole("dialog", { name: "Agregar hijo/a" });
    await user.type(within(sheet).getByLabelText(/^Nombre completo/), "Hijo Nuevo");
    await user.click(within(sheet).getByRole("button", { name: "Crear nueva persona" }));
    expect(await within(sheet).findByRole("alert")).toHaveTextContent(reason);
  });

  it("validates before sending (death before birth)", async () => {
    const user = userEvent.setup();
    renderApp("/arbol", authenticatedState(me));
    await focus(/^José Herrera Navarro/);
    await user.click(await screen.findByRole("button", { name: "Agregar pareja" }));
    const sheet = await screen.findByRole("dialog", { name: "Agregar pareja" });
    await user.type(within(sheet).getByLabelText(/^Nombre completo/), "Pareja Nueva");
    await user.type(within(sheet).getByLabelText(/^Año de nacimiento/), "1960");
    await user.click(within(sheet).getByLabelText(/Ya falleció/));
    await user.type(within(sheet).getByLabelText(/^Año de fallecimiento/), "1950");
    await user.click(within(sheet).getByRole("button", { name: "Crear nueva persona" }));
    expect(await within(sheet).findByText(/no puede ser anterior/)).toBeInTheDocument();
    expect(writes()).toHaveLength(0);
  });
});

describe("member delete", { timeout: 15_000 }, () => {
  it("offers «Eliminar» only with canDelete and deletes after confirming", async () => {
    const user = userEvent.setup();
    const added = makePerson(fixtureId(600), "Error de Captura");
    db.people.set(added.id, added);
    db.relationships.push({ id: fixtureId(601), kind: "parent_of", fromPersonId: IDS.jose, toPersonId: added.id });
    db.flags.set(added.id, { canEdit: true, canDelete: true, canAddRelative: true });
    const { router } = renderApp(`/arbol/${added.id}`, authenticatedState(me));
    await focus(/^Error de Captura/);
    await user.click(await screen.findByRole("button", { name: "Eliminar" }));
    const confirm = await screen.findByRole("alertdialog", { name: "¿Quitar a Error de Captura del árbol?" });
    await user.click(within(confirm).getByRole("button", { name: "Eliminar" }));
    await waitFor(() => expect(writes()[0]).toMatchObject({ method: "DELETE", path: `/family/people/${added.id}` }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/arbol"));

    renderApp(`/arbol/${IDS.raul}`, authenticatedState(me));
    await focus(/^Raúl Herrera Morales/);
    expect(screen.queryByRole("button", { name: "Eliminar" })).not.toBeInTheDocument();
  });
});

describe("adding relatives as an admin", { timeout: 15_000 }, () => {
  it("links an existing person from the search", async () => {
    const user = userEvent.setup();
    const sofia = makePerson(fixtureId(610), "Sofía Ruiz Peña");
    db.people.set(sofia.id, sofia);
    renderApp(`/arbol/${IDS.raul}`, authenticatedState(admin));
    await focus(/^Raúl Herrera Morales/);
    await user.click(await screen.findByRole("button", { name: "Agregar pareja" }));
    const sheet = await screen.findByRole("dialog", { name: "Agregar pareja" });
    await user.type(within(sheet).getByRole("searchbox", { name: "Buscar persona" }), "Sofía");
    await user.click(await within(sheet).findByRole("button", { name: "Elegir a Sofía Ruiz Peña" }));
    await waitFor(() => expect(writes()[0]).toMatchObject({ method: "POST", path: "/admin/relationships" }));
    expect(writes()[0]?.body).toEqual({ kind: "partner_of", fromPersonId: IDS.raul, toPersonId: sofia.id });
  });

  it("creates a new person pre-filled from the search, without an account, attached with relateTo", async () => {
    const user = userEvent.setup();
    renderApp(`/arbol/${IDS.valeria}`, authenticatedState(admin));
    await focus(/^Valeria Ortiz Herrera/);
    await user.click(await screen.findByRole("button", { name: "Agregar padre o madre" }));
    const sheet = await screen.findByRole("dialog", { name: "Agregar padre o madre" });
    await user.type(within(sheet).getByRole("searchbox", { name: "Buscar persona" }), "Tomasa Gil");
    await user.click(within(sheet).getByRole("button", { name: "Crear nueva persona" }));
    expect(within(sheet).getByLabelText(/^Nombre completo/)).toHaveValue("Tomasa Gil");
    expect(within(sheet).queryByText(MEMBER_LINK_NOTE)).not.toBeInTheDocument();
    await user.click(within(sheet).getByLabelText(/Ya falleció/));
    await user.click(within(sheet).getByRole("button", { name: "Crear nueva persona" }));
    await waitFor(() => expect(writes()[0]).toMatchObject({ method: "POST", path: "/admin/people" }));
    expect(writes()[0]?.body).toMatchObject({ fullName: "Tomasa Gil", deceased: true, relateTo: { personId: IDS.valeria, kind: "parent_of" } });
  });

  it("shows great- and great-great-grandparents behind «Ver más»", async () => {
    const user = userEvent.setup();
    const great = makePerson(fixtureId(620), "Bisabuela Ríos", { deceased: true });
    const greatGreat = makePerson(fixtureId(621), "Tatarabuelo Ríos", { deceased: true });
    db.people.set(great.id, great);
    db.people.set(greatGreat.id, greatGreat);
    db.relationships.push(
      { id: fixtureId(622), kind: "parent_of", fromPersonId: great.id, toPersonId: IDS.ernesto },
      { id: fixtureId(623), kind: "parent_of", fromPersonId: greatGreat.id, toPersonId: great.id }
    );
    renderApp("/arbol", authenticatedState(admin));
    await focus(/^José Herrera Navarro/);
    await user.click(screen.getByRole("button", { name: "Ver más: abuelos y nietos" }));
    expect(await screen.findByRole("region", { name: /^Bisabuelos/ })).toHaveTextContent("Bisabuela Ríos");
    expect(screen.getByRole("region", { name: /^Tatarabuelos/ })).toHaveTextContent("Tatarabuelo Ríos");
  });
});
