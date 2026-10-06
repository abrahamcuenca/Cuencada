import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { apiUrl, authenticatedState, errorBody, makeUser } from "../../../../test/auth";
import { createTestServer } from "../../../../test/msw";
import { renderApp } from "../../../../test/renderApp";
import { type FamilyDb, familyHandlers, IDS, makeFamilyDb } from "../testing/fixtures";

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

describe("AdminFamilyPage", { timeout: 15_000 }, () => {
  it("shows the verify state, not a retry, to an admin whose email isn't verified", async () => {
    server.use(
      http.get(apiUrl("/family/people"), () => HttpResponse.json(errorBody("FORBIDDEN", "Verifica tu correo."), { status: 403 }))
    );
    const unverifiedAdmin = makeUser({ role: "admin", emailVerified: false });
    renderApp("/admin/familia", authenticatedState(unverifiedAdmin));

    expect(await screen.findByRole("heading", { name: "Verifica tu correo para administrar el árbol" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reintentar" })).not.toBeInTheDocument();
  });

  it("shows the verify state on a person's page for an unverified admin", async () => {
    server.use(http.get(apiUrl("/family/people/:id"), () => HttpResponse.json(errorBody("FORBIDDEN", "Verifica tu correo."), { status: 403 })));
    renderApp(`/admin/familia/${IDS.jose}`, authenticatedState(makeUser({ role: "admin", emailVerified: false })));

    expect(await screen.findByRole("heading", { name: "Verifica tu correo para administrar el árbol" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reintentar" })).not.toBeInTheDocument();
  });

  it("lists people with a search box", async () => {
    const user = userEvent.setup();
    renderApp("/admin/familia", authenticatedState(admin));

    expect(await screen.findByRole("heading", { level: 1, name: "Personas y árbol" })).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: /José Herrera Navarro «Pepe»/ })).toHaveAttribute("href", `/admin/familia/${IDS.jose}`);
    await user.type(screen.getByRole("searchbox", { name: "Buscar persona" }), "zzz");
    expect(await screen.findByRole("heading", { name: "No encontramos a nadie con «zzz»" })).toBeInTheDocument();
  });

  it("creates a person and opens their editor", async () => {
    const user = userEvent.setup();
    const { router } = renderApp("/admin/familia", authenticatedState(admin));

    await user.click(await screen.findByRole("button", { name: /Nueva persona/ }));
    const form = screen.getByRole("region", { name: "Nueva persona" });
    await user.click(within(form).getByRole("button", { name: "Crear persona" }));
    expect(await within(form).findByText(/obligatorio|Escribe|caracter/i)).toBeInTheDocument();
    expect(writes()).toHaveLength(0);

    await user.type(within(form).getByLabelText(/^Nombre completo/), "Clara Ríos Peña");
    await user.type(within(form).getByLabelText(/^Año de nacimiento/), "1990");
    await user.click(within(form).getByRole("button", { name: "Crear persona" }));

    await waitFor(() => expect(writes()[0]).toMatchObject({ method: "POST", path: "/admin/people" }));
    expect(writes()[0]?.body).toEqual({
      fullName: "Clara Ríos Peña",
      nickname: null,
      familyBranch: null,
      birthYear: 1990,
      deathYear: null,
      deceased: false,
      userId: null
    });
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/admin\/familia\/[0-9a-f-]{36}$/));
    expect(await screen.findByRole("heading", { level: 1, name: "Clara Ríos Peña" })).toBeInTheDocument();
  });
});

describe("AdminPersonPage", { timeout: 15_000 }, () => {
  it("adds a child picked through the search", async () => {
    const user = userEvent.setup();
    renderApp(`/admin/familia/${IDS.jose}`, authenticatedState(admin));

    await screen.findByRole("heading", { level: 1, name: "José Herrera Navarro" });
    const children = await screen.findByRole("region", { name: "Hijos" });
    expect(within(children).getAllByRole("listitem")).toHaveLength(3);
    await user.click(within(children).getByRole("button", { name: /Agregar hijo\/a/ }));

    const dialog = await screen.findByRole("dialog", { name: "Agregar hijo o hija" });
    await user.type(within(dialog).getByRole("searchbox", { name: "Buscar persona" }), "valeria");
    await user.click(await within(dialog).findByRole("button", { name: "Elegir a Valeria Ortiz Herrera" }, { timeout: 3000 }));

    await waitFor(() =>
      expect(writes()[0]).toEqual({
        method: "POST",
        path: "/admin/relationships",
        search: "",
        body: { kind: "parent_of", fromPersonId: IDS.jose, toPersonId: IDS.valeria }
      })
    );
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Hijos" })).getAllByRole("listitem")).toHaveLength(4));
  });

  it("shows the server's cycle error in Spanish inside the picker", async () => {
    server.use(
      http.post(apiUrl("/admin/relationships"), () =>
        HttpResponse.json(errorBody("CONFLICT", "Esa relación crearía un ciclo en el árbol."), { status: 409 })
      )
    );
    const user = userEvent.setup();
    renderApp(`/admin/familia/${IDS.ines}`, authenticatedState(admin));

    const parents = await screen.findByRole("region", { name: "Padres" });
    // Rosa has two parents, so «Agregar padre/madre» is disabled; add a child that is her own grandparent instead.
    expect(within(parents).getByRole("button", { name: /Agregar padre\/madre/ })).toBeDisabled();
    const children = screen.getByRole("region", { name: "Hijos" });
    await user.click(within(children).getByRole("button", { name: /Agregar hijo\/a/ }));
    const dialog = await screen.findByRole("dialog", { name: "Agregar hijo o hija" });
    await user.type(within(dialog).getByRole("searchbox", { name: "Buscar persona" }), "herrera soto");
    await user.click(await within(dialog).findByRole("button", { name: /^Elegir a Luis Herrera Soto/ }, { timeout: 3000 }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Esa relación crearía un ciclo en el árbol.");
    expect(screen.getByRole("dialog", { name: "Agregar hijo o hija" })).toBeInTheDocument();
  });

  it("falls back to a Spanish message naming the rules when the server sends none", async () => {
    server.use(http.post(apiUrl("/admin/relationships"), () => HttpResponse.json({ error: "conflict" }, { status: 409 })));
    const user = userEvent.setup();
    renderApp(`/admin/familia/${IDS.diego}`, authenticatedState(admin));

    const partners = await screen.findByRole("region", { name: "Parejas" });
    await user.click(within(partners).getByRole("button", { name: /Agregar pareja/ }));
    const dialog = await screen.findByRole("dialog", { name: "Agregar pareja" });
    await user.type(within(dialog).getByRole("searchbox", { name: "Buscar persona" }), "sara");
    await user.click(await within(dialog).findByRole("button", { name: "Elegir a Sara Herrera Navarro" }, { timeout: 3000 }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/ya existe, crearía un ciclo o la persona ya tiene dos padres/);
  });

  it("removes a relationship after confirming", async () => {
    const user = userEvent.setup();
    renderApp(`/admin/familia/${IDS.jose}`, authenticatedState(admin));

    const partners = await screen.findByRole("region", { name: "Parejas" });
    await user.click(within(partners).getByRole("button", { name: "Quitar a Ana Morales Vega de parejas" }));
    const confirm = await screen.findByRole("alertdialog", { name: "¿Quitar esta relación?" });
    expect(writes()).toHaveLength(0);
    await user.click(within(confirm).getByRole("button", { name: "Quitar" }));

    const edge = makeFamilyDb().relationships.find((r) => r.kind === "partner_of" && r.fromPersonId === IDS.jose);
    await waitFor(() => expect(writes()[0]).toMatchObject({ method: "DELETE", path: `/admin/relationships/${edge?.id}` }));
    expect(await within(screen.getByRole("region", { name: "Parejas" })).findByText("Aún no hay pareja registrada.")).toBeInTheDocument();
  });

  it("sends only the changed fields when editing", async () => {
    const user = userEvent.setup();
    renderApp(`/admin/familia/${IDS.pablo}`, authenticatedState(admin));

    const name = await screen.findByLabelText(/^Nombre completo/);
    expect(screen.getByRole("checkbox", { name: /Ya falleció/ })).toBeChecked();
    await user.clear(name);
    await user.type(name, "Pablo Andrés Herrera Navarro");
    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));
    await waitFor(() =>
      expect(writes()[0]).toMatchObject({ method: "PATCH", path: `/admin/people/${IDS.pablo}`, body: { fullName: "Pablo Andrés Herrera Navarro" } })
    );
  });

  it("maps a 409 on the linked account to the account field", async () => {
    server.use(
      http.get(apiUrl("/admin/users"), () =>
        HttpResponse.json({
          items: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              email: "raul@example.com",
              displayName: "Raúl Ortega",
              role: "member",
              status: "active",
              mustChangePassword: false,
              emailVerified: true,
              personId: null,
              lastLoginAt: null,
              activeSessionCount: 0,
              createdAt: "2026-01-01T00:00:00.000Z"
            }
          ],
          nextCursor: null
        })
      ),
      http.patch(apiUrl("/admin/people/:id"), () => HttpResponse.json(errorBody("CONFLICT", "Conflict"), { status: 409 }))
    );
    const user = userEvent.setup();
    renderApp(`/admin/familia/${IDS.raul}`, authenticatedState(admin));

    await user.click(await screen.findByRole("button", { name: "Vincular cuenta" }));
    await user.type(screen.getByRole("searchbox", { name: "Buscar cuenta por nombre o correo" }), "raul");
    await user.click(await screen.findByRole("button", { name: /Raúl Ortega · raul@example.com/ }, { timeout: 3000 }));
    expect(screen.getByText(/Vinculada a/)).toHaveTextContent("Raúl Ortega (raul@example.com)");
    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));
    expect(await screen.findByText("Esa cuenta ya está vinculada a otra persona.")).toBeInTheDocument();
  });
});
