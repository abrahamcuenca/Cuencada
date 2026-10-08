import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { apiUrl, authenticatedState, makeUser, statusState } from "../../test/auth";
import { renderApp } from "../../test/renderApp";
import { cancelOnlineLogoutRetry } from "../features/auth/session";
import { createTestServer } from "../../test/msw";

const server = createTestServer(http.post(apiUrl("/auth/logout"), () => new HttpResponse(null, { status: 204 })));

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
afterEach(() => {
  server.resetHandlers();
  cancelOnlineLogoutRetry();
});

describe("MorePage", () => {
  it("lists the member destinations as large links without Admin for a member", async () => {
    renderApp("/mas", authenticatedState());

    const main = within(await screen.findByRole("main"));
    expect(await main.findByRole("heading", { name: "Más" })).toBeInTheDocument();
    expect(main.getByRole("link", { name: /Directorio/ })).toHaveAttribute("href", "/directorio");
    expect(main.getByRole("link", { name: /Árbol familiar/ })).toHaveAttribute("href", "/arbol");
    expect(main.getByRole("link", { name: /Mi perfil/ })).toHaveAttribute("href", "/perfil");
    expect(main.getByRole("link", { name: /Contacto/ })).toHaveAttribute("href", "/perfil#contacto");
    expect(main.getByRole("link", { name: /Sesiones y seguridad/ })).toHaveAttribute("href", "/perfil/sesiones");
    expect(main.queryByRole("link", { name: /Panel de administración/ })).not.toBeInTheDocument();
  });

  it("adds the Admin row for an admin", async () => {
    renderApp("/mas", authenticatedState(makeUser({ role: "admin" })));

    expect(await screen.findByRole("link", { name: /Panel de administración/ })).toHaveAttribute("href", "/admin");
  });

  it("logs out and goes home from Cerrar sesión", async () => {
    const { store, router } = renderApp("/mas", authenticatedState());

    await userEvent.click(await screen.findByRole("button", { name: "Cerrar sesión" }));

    await vi.waitFor(() => expect(store.getState().auth.status).toBe("anonymous"));
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/"));
    // Still home after the logout settles: the guard's /entrar redirect no longer races it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(router.state.location.pathname).toBe("/");
  });

  it("sends anonymous visitors to /entrar", async () => {
    const { router } = renderApp("/mas", statusState("anonymous"));

    await screen.findByRole("heading", { name: "Entrar" });
    expect(router.state.location.pathname).toBe("/entrar");
  });
});
