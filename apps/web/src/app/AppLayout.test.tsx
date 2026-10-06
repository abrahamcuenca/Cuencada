import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { authenticatedState, makeUser, statusState } from "../../test/auth";
import { renderApp } from "../../test/renderApp";

describe("AppLayout", () => {
  it("renders the top and bottom navigation without the admin link for anonymous visitors", async () => {
    renderApp("/", statusState("anonymous"));

    const top = await screen.findByRole("navigation", { name: "Navegación principal" });
    const bottom = screen.getByRole("navigation", { name: "Navegación inferior" });
    expect(within(top).getByRole("link", { name: "Programa" })).toHaveAttribute("href", "/cuencada/2026");
    expect(within(top).queryByRole("link", { name: "Admin" })).not.toBeInTheDocument();
    for (const label of ["Inicio", "Programa", "Fotos", "Chat", "Más"]) {
      expect(within(bottom).getByRole("link", { name: new RegExp(label) })).toBeInTheDocument();
    }
    expect(screen.getByRole("link", { name: "Entrar" })).toHaveAttribute("href", "/entrar");
    expect(within(bottom).getByRole("link", { name: /Más/ })).toHaveAttribute("href", "/mas");
  });

  it("shows the admin link and a Salir button for an admin", async () => {
    renderApp("/", authenticatedState(makeUser({ role: "admin" })));

    const top = await screen.findByRole("navigation", { name: "Navegación principal" });
    expect(within(top).getByRole("link", { name: "Admin" })).toHaveAttribute("href", "/admin");
    expect(screen.getByRole("button", { name: "Salir" })).toBeInTheDocument();
  });
});
