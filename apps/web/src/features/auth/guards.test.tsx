import { act, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { authenticatedState, makeUser, statusState } from "../../../test/auth";
import { renderApp } from "../../../test/renderApp";
import { passwordChangeRequired, tokenRefreshed } from "./authSlice";

describe("RequireAuth", () => {
  it.each(["idle", "restoring"] as const)("shows the session spinner instead of redirecting while %s", async (status) => {
    const { router } = renderApp("/directorio", statusState(status));

    expect(await screen.findByText("Cargando tu sesión…")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/directorio");
  });

  it("shows an offline notice instead of redirecting when the boot refresh could not reach the server", async () => {
    const { router } = renderApp("/directorio", { auth: { ...statusState("restoring").auth, isOffline: true } });

    expect(await screen.findByRole("heading", { name: "Sin conexión" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reintentar" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/directorio");
  });

  it("renders the member page once the boot refresh restores the session", async () => {
    const { store } = renderApp("/directorio", statusState("restoring"));
    await screen.findByText("Cargando tu sesión…");

    act(() => {
      store.dispatch(tokenRefreshed({ accessToken: "t", user: makeUser() }));
    });

    expect(await screen.findByRole("heading", { name: "Directorio familiar" })).toBeInTheDocument();
  });

  it("redirects anonymous visitors to /entrar and remembers the path and query without the hash", async () => {
    const { router } = renderApp("/galeria/2026?foto=3#secreto", statusState("anonymous"));

    expect(await screen.findByRole("heading", { name: "Entrar" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/entrar");
    expect(router.state.location.state).toEqual({ from: "/galeria/2026?foto=3" });
  });

  it("renders public routes without waiting for the session", async () => {
    renderApp("/recuperar", statusState("restoring"));

    expect(await screen.findByRole("heading", { name: "Recuperar contraseña" })).toBeInTheDocument();
  });

  it("renders member routes for an authenticated member", async () => {
    renderApp("/arbol/6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b", authenticatedState());

    expect(await screen.findByRole("heading", { name: "Árbol familiar" })).toBeInTheDocument();
  });
});

describe("RequirePasswordChanged", () => {
  it("sends a user with a temporary password to /cambiar-contrasena", async () => {
    const { router } = renderApp("/perfil", authenticatedState(makeUser({ mustChangePassword: true })));

    expect(await screen.findByRole("heading", { name: "Cambia tu contraseña" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/cambiar-contrasena");
  });

  it("redirects as soon as the API reports PASSWORD_CHANGE_REQUIRED", async () => {
    const { store, router } = renderApp("/directorio", authenticatedState());
    await screen.findByRole("heading", { name: "Directorio familiar" });

    act(() => {
      store.dispatch(passwordChangeRequired());
    });

    expect(await screen.findByRole("heading", { name: "Cambia tu contraseña" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/cambiar-contrasena");
  });

  it("lets the user stay on /cambiar-contrasena without a redirect loop", async () => {
    const { router } = renderApp("/cambiar-contrasena", authenticatedState(makeUser({ mustChangePassword: true })));

    expect(await screen.findByRole("heading", { name: "Cambia tu contraseña" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/cambiar-contrasena");
  });
});

describe("RequireAdmin", () => {
  it("sends a member away from /admin to the home page", async () => {
    const { router } = renderApp("/admin/usuarios", authenticatedState());

    expect(await screen.findByRole("heading", { name: "CUENCADA" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");
  });

  it("renders /admin/* for an admin", async () => {
    renderApp("/admin/usuarios", authenticatedState(makeUser({ role: "admin" })));

    expect(await screen.findByRole("heading", { name: "Panel de la Cuencada" })).toBeInTheDocument();
  });

  it("sends an admin with a temporary password to /cambiar-contrasena first", async () => {
    const { router } = renderApp("/admin", authenticatedState(makeUser({ role: "admin", mustChangePassword: true })));

    await screen.findByRole("heading", { name: "Cambia tu contraseña" });
    expect(router.state.location.pathname).toBe("/cambiar-contrasena");
  });
});

describe("router", () => {
  it("renders the 404 page for an unknown path", async () => {
    renderApp("/no-existe", statusState("anonymous"));

    expect(await screen.findByRole("heading", { name: "No encontramos esta página" })).toBeInTheDocument();
  });
});
