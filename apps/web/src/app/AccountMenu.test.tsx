import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { apiUrl, authenticatedState, makeUser } from "../../test/auth";
import { createTestServer } from "../../test/msw";
import { renderApp } from "../../test/renderApp";
import { cancelOnlineLogoutRetry } from "../features/auth/session";
import { firstName } from "./AccountMenu";

let logoutCalls = 0;
const server = createTestServer(
  http.post(apiUrl("/auth/logout"), () => {
    logoutCalls += 1;
    return new HttpResponse(null, { status: 204 });
  })
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
afterEach(() => {
  server.resetHandlers();
  cancelOnlineLogoutRetry();
  logoutCalls = 0;
});

const banner = (): ReturnType<typeof within> => within(screen.getByRole("banner"));

async function accountButton(): Promise<HTMLElement> {
  return within(await screen.findByRole("banner")).findByRole("button", { name: /^Mi cuenta/ });
}

/** Visible entry names of the open menu, icons dropped. */
function entryNames(): string[] {
  const controls = screen.getByRole("button", { name: /^Mi cuenta/ }).getAttribute("aria-controls") ?? "";
  const list = document.getElementById(controls);
  if (list === null) throw new Error("account menu list not found");
  return [...list.querySelectorAll("a, button")].map((entry) => (entry.textContent ?? "").replace(/[^\p{L}\s]/gu, "").trim());
}

describe("AccountMenu", () => {
  it("shows the first name and initials, and opens and closes from the button", async () => {
    renderApp("/", authenticatedState(makeUser({ displayName: "Prima Morales" })));
    const button = await accountButton();

    expect(button).toHaveAccessibleName("Mi cuenta: Prima");
    expect(button).toHaveTextContent("PM");
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(banner().queryByRole("link", { name: /Mi perfil/ })).not.toBeInTheDocument();

    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(entryNames()).toEqual(["Mi perfil", "Contacto", "Sesiones y seguridad", "Cerrar sesión"]);
    expect(banner().getByRole("link", { name: /Mi perfil/ })).toHaveAttribute("href", "/perfil");
    expect(banner().getByRole("link", { name: /Contacto/ })).toHaveAttribute("href", "/perfil#contacto");
    expect(banner().getByRole("link", { name: /Sesiones y seguridad/ })).toHaveAttribute("href", "/perfil/sesiones");

    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(banner().queryByRole("link", { name: /Mi perfil/ })).not.toBeInTheDocument();
  });

  it("closes on Escape and gives focus back to the button", async () => {
    renderApp("/", authenticatedState());
    const button = await accountButton();
    await userEvent.click(button);
    await userEvent.tab();
    expect(banner().getByRole("link", { name: /Mi perfil/ })).toHaveFocus();

    await userEvent.keyboard("{Escape}");
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveFocus();
  });

  it("closes on a click outside", async () => {
    renderApp("/", authenticatedState());
    const button = await accountButton();
    await userEvent.click(button);

    await userEvent.click(await screen.findByRole("main"));
    expect(button).toHaveAttribute("aria-expanded", "false");
  });

  it("closes when focus tabs out past the last entry", async () => {
    renderApp("/", authenticatedState());
    const button = await accountButton();
    await userEvent.click(button);
    banner().getByRole("button", { name: /Cerrar sesión/ }).focus();

    await userEvent.tab();
    expect(button).toHaveAttribute("aria-expanded", "false");
  });

  it("opens with the arrow keys and moves between the entries", async () => {
    renderApp("/", authenticatedState());
    const button = await accountButton();
    button.focus();

    await userEvent.keyboard("{ArrowDown}");
    expect(button).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => expect(banner().getByRole("link", { name: /Mi perfil/ })).toHaveFocus());
    await userEvent.keyboard("{ArrowDown}");
    expect(banner().getByRole("link", { name: /Contacto/ })).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(banner().getByRole("button", { name: /Cerrar sesión/ })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(banner().getByRole("link", { name: /Mi perfil/ })).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    expect(banner().getByRole("button", { name: /Cerrar sesión/ })).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(banner().getByRole("link", { name: /Mi perfil/ })).toHaveFocus();

    await userEvent.keyboard("{Escape}");
    button.focus();
    await userEvent.keyboard("{ArrowUp}");
    await waitFor(() => expect(banner().getByRole("button", { name: /Cerrar sesión/ })).toHaveFocus());
  });

  it("goes to the Contacto section of Mi perfil and closes", async () => {
    const { router } = renderApp("/", authenticatedState());
    const button = await accountButton();
    await userEvent.click(button);

    await userEvent.click(banner().getByRole("link", { name: /Contacto/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/perfil"));
    expect(router.state.location.hash).toBe("#contacto");
    expect(button).toHaveAttribute("aria-expanded", "false");
  });

  it("adds Panel for an admin, once", async () => {
    renderApp("/", authenticatedState(makeUser({ role: "admin" })));
    await userEvent.click(await accountButton());

    expect(entryNames()).toEqual(["Mi perfil", "Contacto", "Sesiones y seguridad", "Panel", "Cerrar sesión"]);
    expect(screen.getAllByRole("link", { name: /Panel/ })).toHaveLength(1);
    expect(banner().getByRole("link", { name: /Panel/ })).toHaveAttribute("href", "/admin");
  });

  it("logs out from Cerrar sesión", async () => {
    const { store } = renderApp("/", authenticatedState());
    await userEvent.click(await accountButton());

    await userEvent.click(banner().getByRole("button", { name: /Cerrar sesión/ }));
    await waitFor(() => expect(store.getState().auth.status).toBe("anonymous"));
    expect(logoutCalls).toBe(1);
    expect(await banner().findByRole("link", { name: "Entrar" })).toBeInTheDocument();
    expect(banner().queryByRole("button", { name: /^Mi cuenta/ })).not.toBeInTheDocument();
  });

  it("offers only Cerrar sesión during a forced password change", async () => {
    renderApp("/perfil", authenticatedState(makeUser({ mustChangePassword: true })));
    await screen.findByRole("heading", { name: /Cambia tu contraseña/ });
    await userEvent.click(await accountButton());

    expect(entryNames()).toEqual(["Cerrar sesión"]);
  });
});

describe("firstName", () => {
  it("takes the first word of the display name", () => {
    expect(firstName({ displayName: "  Prima   Morales ", email: "prima@example.com" })).toBe("Prima");
  });

  it("falls back to Tú for a blank display name", () => {
    expect(firstName({ displayName: "   ", email: "prima@example.com" })).toBe("Tú");
  });
});
