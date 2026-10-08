/**
 * WP-4.2: invites linked to tree people. The "Persona en el árbol" picker in
 * the invite form, "Para: …" in the list, the `?persona=` pre-fill and the
 * "Invitar" button on a person's tree page.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authenticatedState, makeUser } from "../../../test/auth";
import { createTestServer } from "../../../test/msw";
import { renderApp } from "../../../test/renderApp";
import { familyHandlers, IDS as FAMILY_IDS, makeFamilyDb } from "../family/testing/fixtures";
import { ADMIN_USER, type AdminDb, adminHandlers, IDS, makeAdminDb, writes } from "./testing/fixtures";

const server = createTestServer();
let db: AdminDb;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  db = makeAdminDb();
  server.use(...adminHandlers(db));
});
afterEach(() => server.resetHandlers());

async function openForm(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(await screen.findByRole("button", { name: /Invitar/ }));
  return screen.getByRole("form", { name: "Nueva invitación" });
}

describe("Invite form: Persona en el árbol", { timeout: 15_000 }, () => {
  it("lists living people without an account with year and branch, disables a pending one, and sends personId", async () => {
    const user = userEvent.setup();
    renderApp("/admin/invitaciones", authenticatedState(ADMIN_USER));
    const form = await openForm(user);

    await user.type(within(form).getByRole("searchbox", { name: /Persona en el árbol/ }), "ana");
    const norte = await within(form).findByRole("button", { name: "Elegir a Ana Ejemplo, n. 1990 · Rama Norte" });
    const sur = within(form).getByRole("button", { name: "Elegir a Ana Ejemplo, n. 1962 · Rama Sur (Invitación pendiente)" });
    expect(sur).toBeDisabled();
    expect(within(form).queryByRole("button", { name: /Bruno Ejemplo/ })).not.toBeInTheDocument();
    expect(db.log.find((entry) => entry.path === "/admin/invites/people")?.query).toEqual({ q: "ana", limit: "8" });

    await user.click(norte);
    expect(within(form).getByText("Ana Ejemplo")).toBeInTheDocument();
    expect(within(form).getByText(/Le sugeriremos este nombre/)).toBeInTheDocument();

    await user.type(within(form).getByRole("textbox", { name: /Correo/ }), "ana.ejemplo@example.com");
    await user.click(within(form).getByRole("button", { name: "Enviar invitación" }));

    await waitFor(() => expect(writes(db)).toHaveLength(1));
    expect(writes(db)[0]?.body).toMatchObject({ email: "ana.ejemplo@example.com", personId: IDS.personAnaNorte, sendEmail: true });
    const card = await screen.findByRole("article", { name: "ana.ejemplo@example.com" });
    expect(card).toHaveTextContent("Para: Ana Ejemplo");
  });

  it("hides the picker on an open link with the bound-invite note, and drops a chosen person", async () => {
    const user = userEvent.setup();
    renderApp("/admin/invitaciones", authenticatedState(ADMIN_USER));
    const form = await openForm(user);
    await user.type(within(form).getByRole("searchbox", { name: /Persona en el árbol/ }), "ana");
    await user.click(await within(form).findByRole("button", { name: /Rama Norte/ }));

    await user.click(within(form).getByRole("radio", { name: /Enlace para compartir/ }));

    expect(within(form).queryByRole("searchbox", { name: /Persona en el árbol/ })).not.toBeInTheDocument();
    expect(within(form).getByText("Para vincular a una persona del árbol, usa una invitación por correo.")).toBeInTheDocument();
    await user.click(within(form).getByRole("radio", { name: /Por correo/ }));
    expect(within(form).getByRole("searchbox", { name: /Persona en el árbol/ })).toHaveValue("");
    expect(within(form).queryByRole("button", { name: "Quitar persona" })).not.toBeInTheDocument();
  });

  it("shows a server refusal of the person on the picker", async () => {
    const user = userEvent.setup();
    renderApp("/admin/invitaciones", authenticatedState(ADMIN_USER));
    const form = await openForm(user);
    await user.type(within(form).getByRole("searchbox", { name: /Persona en el árbol/ }), "ana");
    await user.click(await within(form).findByRole("button", { name: /Rama Norte/ }));
    // Another admin invited her meanwhile.
    db.candidates = db.candidates.map((candidate) => ({ ...candidate, pendingInvite: true }));

    await user.type(within(form).getByRole("textbox", { name: /Correo/ }), "ana.ejemplo@example.com");
    await user.click(within(form).getByRole("button", { name: "Enviar invitación" }));

    expect(await within(form).findByText(/ya tiene una invitación pendiente/)).toBeInTheDocument();
  });

  it("opens the form pre-filled from ?persona=", async () => {
    const user = userEvent.setup();
    const { router } = renderApp(`/admin/invitaciones?persona=${IDS.personAnaNorte}`, authenticatedState(ADMIN_USER));

    const form = await screen.findByRole("form", { name: "Nueva invitación" });
    expect(await within(form).findByText("Ana Ejemplo")).toBeInTheDocument();
    expect(within(form).getByRole("button", { name: "Quitar persona" })).toBeInTheDocument();

    await user.click(within(form).getByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(router.state.location.search).toBe(""));
    expect(screen.queryByRole("form", { name: "Nueva invitación" })).not.toBeInTheDocument();
  });

  it("explains why a ?persona= person cannot be linked and leaves the picker empty", async () => {
    renderApp(`/admin/invitaciones?persona=${IDS.personBruno}`, authenticatedState(ADMIN_USER));

    expect(await screen.findByText("No se puede vincular a Bruno Ejemplo: ya tiene cuenta.")).toBeInTheDocument();
    const form = screen.getByRole("form", { name: "Nueva invitación" });
    expect(within(form).getByRole("searchbox", { name: /Persona en el árbol/ })).toBeInTheDocument();
  });
});

describe("InvitePersonButton on the tree page", { timeout: 15_000 }, () => {
  beforeEach(() => {
    server.use(...familyHandlers(makeFamilyDb()));
    const base = { nickname: null, familyBranch: null, birthYear: null, deathYear: null, deceased: false, pendingInvite: false };
    db.candidates = [
      { ...base, id: FAMILY_IDS.ines, fullName: "Inés Herrera Morales", linked: false },
      { ...base, id: FAMILY_IDS.ana, fullName: "Ana Morales Vega", linked: true },
      { ...base, id: FAMILY_IDS.raul, fullName: "Raúl Herrera Morales", linked: false, pendingInvite: true }
    ];
  });

  it("offers «Invitar» to admins for a living, unlinked person and opens the pre-filled form", async () => {
    const user = userEvent.setup();
    const { router } = renderApp(`/arbol/${FAMILY_IDS.ines}`, authenticatedState({ ...ADMIN_USER, personId: FAMILY_IDS.jose }));

    const button = await screen.findByRole("link", { name: "Invitar a Inés Herrera Morales" });
    await user.click(button);

    await waitFor(() => expect(router.state.location.pathname).toBe("/admin/invitaciones"));
    expect(router.state.location.search).toBe(`?persona=${FAMILY_IDS.ines}`);
  });

  it.each([
    ["already linked", FAMILY_IDS.ana, /^Ana Morales Vega/],
    ["with a pending invite", FAMILY_IDS.raul, /^Raúl Herrera Morales/]
  ])("hides it for a person %s", async (_label, personId, heading) => {
    renderApp(`/arbol/${personId}`, authenticatedState({ ...ADMIN_USER, personId: FAMILY_IDS.jose }));

    await screen.findByRole("heading", { level: 2, name: heading });
    await waitFor(() => expect(db.log.some((entry) => entry.path === `/admin/invites/people/${personId}`)).toBe(true));
    expect(screen.queryByRole("link", { name: /^Invitar a/ })).not.toBeInTheDocument();
  });

  it("never asks the admin API for members", async () => {
    renderApp(`/arbol/${FAMILY_IDS.ines}`, authenticatedState(makeUser({ personId: FAMILY_IDS.jose })));

    await screen.findByRole("heading", { level: 2, name: /^Inés Herrera Morales/ });
    expect(screen.queryByRole("link", { name: /^Invitar a/ })).not.toBeInTheDocument();
    expect(db.log.some((entry) => entry.path.startsWith("/admin/"))).toBe(false);
  });
});
