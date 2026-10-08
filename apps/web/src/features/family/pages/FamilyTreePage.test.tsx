import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { apiUrl, authenticatedState, errorBody, makeUser } from "../../../../test/auth";
import { createTestServer } from "../../../../test/msw";
import { renderApp } from "../../../../test/renderApp";
import styles from "../family.module.css";
import { type FamilyDb, familyHandlers, IDS, makeFamilyDb } from "../testing/fixtures";

const server = createTestServer();
let db: FamilyDb;

const me = makeUser({ personId: IDS.jose });

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  db = makeFamilyDb();
  server.use(...familyHandlers(db));
});
afterEach(() => {
  server.resetHandlers();
  vi.unstubAllGlobals();
});

function group(name: RegExp): HTMLElement {
  const region = screen.getByRole("region", { name });
  return region;
}

async function focusHeading(name: RegExp): Promise<HTMLElement> {
  return screen.findByRole("heading", { level: 2, name });
}

describe("FamilyTreePage", { timeout: 15_000 }, () => {
  it("renders every relationship group from the fixture as lists of buttons", async () => {
    renderApp("/arbol", authenticatedState(me));

    await focusHeading(/^José Herrera Navarro/);
    expect(screen.getByText("«Pepe»")).toBeInTheDocument();
    expect(screen.getByText("n. 1952 · Rama Herrera Navarro")).toBeInTheDocument();

    const parents = within(group(/^Padres/)).getAllByRole("button");
    expect(parents.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Ver a Luis Herrera Soto, ya falleció",
      "Ver a Elsa Navarro Gil, ya falleció"
    ]);
    expect(within(group(/^Pareja/)).getByRole("button", { name: "Ver a Ana Morales Vega" })).toBeInTheDocument();
    expect(within(group(/^Hijos/)).getAllByRole("button")).toHaveLength(3);
    expect(within(group(/^Hermanos/)).getAllByRole("button")).toHaveLength(4);
    // A deceased sibling shows the subtle dagger.
    expect(within(group(/^Hermanos/)).getByRole("button", { name: "Ver a Pablo Herrera Navarro, ya falleció" })).toHaveTextContent("†");
    // People without accounts are labelled; the lines are hidden from assistive tech.
    expect(within(group(/^Hijos/)).getAllByText("Sin cuenta")).toHaveLength(2);
    for (const svg of document.querySelectorAll("svg")) expect(svg).toHaveAttribute("aria-hidden", "true");
  });

  it("shows no year at all when the server hides a living relative's birth year (WP-0.8b)", async () => {
    const ines = db.people.get(IDS.ines);
    if (!ines) throw new Error("fixture");
    db.people.set(IDS.ines, { ...ines, birthYear: null, familyBranch: "Herrera Morales" });
    renderApp(`/arbol/${IDS.ines}`, authenticatedState(me));

    const heading = await focusHeading(/^Inés Herrera Morales/);
    const card = heading.closest("article");
    if (!card) throw new Error("no focus card");
    expect(within(card).getByText("Rama Herrera Morales")).toBeInTheDocument();
    expect(card.textContent).not.toMatch(/n\. |null|undefined/);
  });

  it("shows empty states for groups without people", async () => {
    renderApp(`/arbol/${IDS.valeria}`, authenticatedState(me));

    await focusHeading(/^Valeria Ortiz Herrera/);
    expect(screen.getByText("Aún no hay pareja registrada.")).toBeInTheDocument();
    expect(screen.getByText("Aún no hay hijos registrados.")).toBeInTheDocument();
    renderApp(`/arbol/${IDS.ernesto}`, authenticatedState(me));
    expect(await screen.findByText("Aún no hay padres registrados.")).toBeInTheDocument();
  });

  it("re-centres on a tapped person, updates the URL and records the breadcrumb", async () => {
    const user = userEvent.setup();
    const { router } = renderApp("/arbol", authenticatedState(me));

    await focusHeading(/^José Herrera Navarro/);
    await user.click(screen.getByRole("button", { name: "Ver a Luis Herrera Soto, ya falleció" }));

    await waitFor(() => expect(router.state.location.pathname).toBe(`/arbol/${IDS.luis}`));
    const heading = await focusHeading(/^Luis Herrera Soto/);
    await waitFor(() => expect(heading).toHaveFocus());
    const trail = screen.getByRole("navigation", { name: "Personas visitadas" });
    expect(within(trail).getByRole("button", { name: "José Herrera Navarro" })).toBeInTheDocument();
    // [SEC] History state keeps ids only: no names persist in session history.
    expect(router.state.location.state).toEqual({ trail: [IDS.jose] });
    expect(JSON.stringify(window.history.state)).not.toContain("José");
    expect(within(group(/^Hijos/)).getAllByRole("button")).toHaveLength(5);
  });

  it("goes back to the previous person with Back", async () => {
    const user = userEvent.setup();
    const { router } = renderApp("/arbol", authenticatedState(me));

    await focusHeading(/^José Herrera Navarro/);
    await user.click(screen.getByRole("button", { name: "Ver a Inés Herrera Morales" }));
    await focusHeading(/^Inés Herrera Morales/);
    await user.click(screen.getByRole("button", { name: "Ver a Valeria Ortiz Herrera" }));
    await focusHeading(/^Valeria Ortiz Herrera/);
    expect(within(screen.getByRole("navigation", { name: "Personas visitadas" })).getAllByRole("button")).toHaveLength(2);

    await router.navigate(-1);
    await focusHeading(/^Inés Herrera Morales/);
    expect(router.state.location.pathname).toBe(`/arbol/${IDS.ines}`);
    expect(within(screen.getByRole("navigation", { name: "Personas visitadas" })).getAllByRole("button")).toHaveLength(1);
  });

  it("jumps back along the breadcrumb trail without looping", async () => {
    const user = userEvent.setup();
    const { router } = renderApp("/arbol", authenticatedState(me));

    await focusHeading(/^José Herrera Navarro/);
    await user.click(screen.getByRole("button", { name: "Ver a Inés Herrera Morales" }));
    await focusHeading(/^Inés Herrera Morales/);
    await user.click(screen.getByRole("button", { name: "Ver a Valeria Ortiz Herrera" }));
    await focusHeading(/^Valeria Ortiz Herrera/);

    await user.click(within(screen.getByRole("navigation", { name: "Personas visitadas" })).getByRole("button", { name: "José Herrera Navarro" }));
    await focusHeading(/^José Herrera Navarro/);
    expect(router.state.location.pathname).toBe(`/arbol/${IDS.jose}`);
    expect(screen.queryByRole("navigation", { name: "Personas visitadas" })).not.toBeInTheDocument();
  });

  it("loads grandparents and grandchildren behind «Ver más»", async () => {
    const user = userEvent.setup();
    renderApp("/arbol", authenticatedState(me));

    await focusHeading(/^José Herrera Navarro/);
    expect(screen.queryByRole("region", { name: /^Abuelos/ })).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "Ver más: abuelos y nietos" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);

    const grandparents = await screen.findByRole("region", { name: /^Abuelos/ });
    expect(within(grandparents).getByRole("button", { name: "Ver a Ernesto Herrera Ríos, ya falleció" })).toBeInTheDocument();
    expect(within(grandparents).getByRole("button", { name: "Ver a Lucía Soto Campos, ya falleció" })).toBeInTheDocument();
    const grandchildren = screen.getByRole("region", { name: /^Nietos/ });
    expect(within(grandchildren).getAllByRole("button")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Ver menos" })).toHaveAttribute("aria-expanded", "true");
    // WP-4.1: the expanded view asks for four generations (great-great-grandparents).
    expect(db.log.some((entry) => entry.path === "/family/tree" && entry.search.includes("depth=4"))).toBe(true);
    // No older ancestors in this fixture: those bands stay out.
    expect(screen.queryByRole("region", { name: /^Bisabuelos/ })).not.toBeInTheDocument();
  });

  it("shows the verify-email state on 403", async () => {
    server.use(http.get(apiUrl("/family/tree"), () => HttpResponse.json(errorBody("FORBIDDEN", "Verifica tu correo."), { status: 403 })));
    renderApp("/arbol", authenticatedState(makeUser({ emailVerified: false })));

    expect(await screen.findByRole("heading", { name: "Verifica tu correo para ver el árbol familiar" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /^Padres/ })).not.toBeInTheDocument();
  });

  it("shows the verify-email state for EMAIL_UNVERIFIED even when the cached user looks verified", async () => {
    server.use(
      http.get(apiUrl("/family/tree"), () => HttpResponse.json({ error: { code: "EMAIL_UNVERIFIED", message: "Verifica tu correo." } }, { status: 403 }))
    );
    renderApp("/arbol", authenticatedState(makeUser()));

    expect(await screen.findByRole("heading", { name: "Verifica tu correo para ver el árbol familiar" })).toBeInTheDocument();
    expect(within(screen.getByRole("main")).getByRole("button", { name: "Reenviar enlace" })).toBeInTheDocument();
  });

  it("says access is closed for a 403 to a verified member, with no retry", async () => {
    server.use(http.get(apiUrl("/family/tree"), () => HttpResponse.json(errorBody("FORBIDDEN", "No."), { status: 403 })));
    renderApp("/arbol", authenticatedState(makeUser()));

    expect(await screen.findByRole("heading", { name: "No tienes acceso al árbol familiar" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Verifica tu correo/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reintentar" })).not.toBeInTheDocument();
  });

  it("shows the verify-email state on 403 EMAIL_UNVERIFIED (WP-0.8a server code)", async () => {
    server.use(
      http.get(apiUrl("/family/tree"), () =>
        HttpResponse.json(errorBody("EMAIL_UNVERIFIED", "Confirma tu correo electrónico para ver esta sección."), { status: 403 })
      )
    );
    renderApp("/arbol", authenticatedState(makeUser({ emailVerified: false })));

    expect(await screen.findByRole("heading", { name: "Verifica tu correo para ver el árbol familiar" })).toBeInTheDocument();
  });

  it("prompts a search when I have no person node", async () => {
    server.use(...familyHandlers(db, { mePersonId: null }));
    renderApp("/arbol", authenticatedState(makeUser()));

    expect(await screen.findByRole("heading", { name: "Aún no estás en el árbol" })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Buscar a un familiar" })).toBeInTheDocument();
  });

  it("shows «No encontramos» for an unknown or malformed id without crashing", async () => {
    renderApp("/arbol/no-es-un-id", authenticatedState(me));
    expect(await screen.findByRole("heading", { name: "No encontramos a esa persona" })).toBeInTheDocument();
    expect(db.log.filter((entry) => entry.path === "/family/tree")).toHaveLength(0);
  });

  it("jumps to a person from the debounced search", async () => {
    const user = userEvent.setup();
    const { router } = renderApp("/arbol", authenticatedState(me));

    await focusHeading(/^José Herrera Navarro/);
    await user.type(screen.getByRole("searchbox", { name: "Buscar a un familiar" }), "sara");
    const results = await screen.findByRole("list", { name: "Resultados" }, { timeout: 3000 });
    // Debounced: one request for the whole word, none per keystroke.
    expect(db.log.filter((entry) => entry.path === "/family/people")).toHaveLength(1);
    expect(db.log.find((entry) => entry.path === "/family/people")?.search).toContain("q=sara");
    expect(screen.getByText("1 resultado.")).toBeInTheDocument();

    await user.click(within(results).getByRole("button", { name: "Ver a Sara Herrera Navarro" }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/arbol/${IDS.sara}`));
    await focusHeading(/^Sara Herrera Navarro/);
  });

  it("offers «Editar mis datos» on my own node (canEdit) and sends only the changed fields", async () => {
    const user = userEvent.setup();
    renderApp("/arbol", authenticatedState(me));

    await focusHeading(/^José Herrera Navarro/);
    await user.click(await screen.findByRole("button", { name: /Editar mis datos/ }));
    const dialog = await screen.findByRole("dialog", { name: "Editar mis datos" });
    expect(within(dialog).getAllByRole("textbox").map(labelOf)).toEqual([
      "Nombre completo",
      "Apodo",
      "Rama familiar",
      "Año de nacimiento",
      "Lugar de nacimiento",
      "Biografía"
    ]);
    expect(within(dialog).getByLabelText(/^Apodo/)).toHaveValue("Pepe");
    expect(within(dialog).getByLabelText(/^Rama familiar/)).toHaveValue("Herrera Navarro");
    expect(within(dialog).getByLabelText(/^Año de nacimiento/)).toHaveValue("1952");
    // Death fields appear only with «Ya falleció».
    expect(within(dialog).queryByLabelText(/^Año de fallecimiento/)).not.toBeInTheDocument();

    await user.clear(within(dialog).getByLabelText(/^Apodo/));
    await user.type(within(dialog).getByLabelText(/^Apodo/), "Jorgito");
    await user.click(within(dialog).getByRole("button", { name: "Guardar" }));

    await waitFor(() => expect(db.log.find((entry) => entry.method === "PATCH")?.body).toEqual({ nickname: "Jorgito" }));
    expect(db.log.find((entry) => entry.method === "PATCH")?.path).toBe(`/family/people/${IDS.jose}`);
    expect(await screen.findByText("«Jorgito»")).toBeInTheDocument();
  });

  it("shows the tree-photo controls only when the server says canEditPhoto (WP-4.3)", async () => {
    const details = {
      ...db.people.get(IDS.ines),
      birthDate: null,
      deathDate: null,
      birthplace: null,
      bio: null,
      photoUrl: null,
      photoSource: "person",
      isLinked: false,
      canEdit: false,
      canEditPhoto: true,
      contacts: []
    };
    server.use(http.get(apiUrl(`/family/people/${IDS.ines}`), () => HttpResponse.json(details)));
    renderApp(`/arbol/${IDS.ines}`, authenticatedState(me));
    await focusHeading(/^Inés Herrera Morales/);
    expect(await screen.findByRole("button", { name: /Cambiar foto/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Quitar foto/ })).toBeInTheDocument();
    expect(screen.getByTestId("person-photo-file-input")).toHaveAttribute("accept", "image/jpeg,image/png,image/webp");
  });

  it("hides the tree-photo controls when canEditPhoto is false", async () => {
    renderApp(`/arbol/${IDS.ines}`, authenticatedState(me));
    await focusHeading(/^Inés Herrera Morales/);
    await waitFor(() => expect(db.log.some((entry) => entry.path === `/family/people/${IDS.ines}`)).toBe(true));
    expect(screen.queryByRole("button", { name: /Agregar foto|Cambiar foto/ })).not.toBeInTheDocument();
  });

  it("does not offer «Editar mis datos» on someone else's node", async () => {
    renderApp(`/arbol/${IDS.ines}`, authenticatedState(me));
    await focusHeading(/^Inés Herrera Morales/);
    expect(screen.queryByRole("button", { name: /Editar mis datos/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Editar en administración/ })).not.toBeInTheDocument();
  });

  it("validates the birth year before sending", async () => {
    const user = userEvent.setup();
    renderApp("/arbol", authenticatedState(me));
    await focusHeading(/^José Herrera Navarro/);
    await user.click(await screen.findByRole("button", { name: /Editar mis datos/ }));
    const dialog = await screen.findByRole("dialog", { name: "Editar mis datos" });
    await user.clear(within(dialog).getByLabelText(/^Año de nacimiento/));
    await user.type(within(dialog).getByLabelText(/^Año de nacimiento/), "1700");
    await user.click(within(dialog).getByRole("button", { name: "Guardar" }));
    expect(await within(dialog).findByText("Escribe un año entre 1800 y 2200.")).toBeInTheDocument();
    expect(db.log.some((entry) => entry.method === "PATCH")).toBe(false);
  });

  it("uses the reduced-motion class when the OS asks for less motion", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query.includes("prefers-reduced-motion"),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      }))
    );
    renderApp("/arbol", authenticatedState(me));

    const heading = await focusHeading(/^José Herrera Navarro/);
    const tree = heading.closest("[data-motion]");
    expect(tree).toHaveAttribute("data-motion", "reduced");
    expect(tree).toHaveClass(styles.reducedMotion ?? "missing-class");
    expect(tree).not.toHaveClass(styles.animated ?? "missing-class");
  });

  it("animates the re-centre by default", async () => {
    renderApp("/arbol", authenticatedState(me));
    const heading = await focusHeading(/^José Herrera Navarro/);
    expect(heading.closest("[data-motion]")).toHaveAttribute("data-motion", "full");
  });
});

function labelOf(field: HTMLElement): string {
  const id = field.getAttribute("id") ?? "";
  return (
    document
      .querySelector(`label[for="${CSS.escape(id)}"]`)
      ?.textContent?.replace(/\s*\(opcional\)\s*/, "")
      .trim() ?? ""
  );
}
