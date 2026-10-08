import { act, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { makeMemoriesHome, makePublicCuencada } from "../features/cuencadas/testing/fixtures";
import { tokenRefreshed } from "../features/auth/authSlice";
import { apiUrl, authenticatedState, makeUser, statusState } from "../../test/auth";
import { createTestServer } from "../../test/msw";
import { renderApp } from "../../test/renderApp";

const server = createTestServer();

/** The account menu button ("Mi cuenta: Prima"). */
const ACCOUNT_BUTTON = { name: /^Mi cuenta/ };

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/** Accessible names of the links in a nav, in order, without badge text. */
function linkNames(nav: HTMLElement): string[] {
  return within(nav)
    .getAllByRole("link")
    .map((link) => (link.textContent ?? "").replace(/[^\p{L}\s]/gu, "").trim());
}

describe("AppLayout", () => {
  it("gives anonymous visitors Inicio, Programa and Entrar, with no member or admin links", async () => {
    renderApp("/", statusState("anonymous"));

    const top = await screen.findByRole("navigation", { name: "Navegación principal" });
    const bottom = screen.getByRole("navigation", { name: "Navegación inferior" });
    // Latest edition from the cached home query (memories mode → latestPast 2026).
    await waitFor(() => expect(within(top).getByRole("link", { name: "Programa" })).toHaveAttribute("href", "/cuencada/2026"));
    expect(linkNames(top)).toEqual(["Inicio", "Programa"]);
    expect(within(top).getByRole("link", { name: "Inicio" })).toHaveAttribute("href", "/");
    expect(linkNames(bottom)).toEqual(["Inicio", "Programa", "Entrar"]);
    expect(within(bottom).getByRole("link", { name: /Entrar/ })).toHaveAttribute("href", "/entrar");
    // The header action, outside both navs.
    expect(within(screen.getByRole("banner")).getAllByRole("link", { name: "Entrar" })).toHaveLength(1);
    expect(screen.queryByRole("button", ACCOUNT_BUTTON)).not.toBeInTheDocument();
  });

  it.each([
    ["a verified member", makeUser()],
    ["an unverified member", makeUser({ emailVerified: false })]
  ])("gives %s the member navigation without the admin link", async (_label, user) => {
    renderApp("/", authenticatedState(user));

    const top = await screen.findByRole("navigation", { name: "Navegación principal" });
    const bottom = screen.getByRole("navigation", { name: "Navegación inferior" });
    expect(linkNames(top)).toEqual(["Programa", "Galería", "Directorio", "Árbol", "Chat"]);
    expect(linkNames(bottom)).toEqual(["Inicio", "Programa", "Fotos", "Chat", "Más"]);
    expect(within(bottom).getByRole("link", { name: /Más/ })).toHaveAttribute("href", "/mas");
    expect(within(top).queryByRole("link", { name: "Panel" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", ACCOUNT_BUTTON)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Entrar" })).not.toBeInTheDocument();
  });

  it("gives an admin the member links, with Panel only in the account menu (WP-4.7)", async () => {
    renderApp("/", authenticatedState(makeUser({ role: "admin" })));

    const top = await screen.findByRole("navigation", { name: "Navegación principal" });
    expect(linkNames(top)).toEqual(["Programa", "Galería", "Directorio", "Árbol", "Chat"]);
    expect(linkNames(screen.getByRole("navigation", { name: "Navegación inferior" }))).toEqual(["Inicio", "Programa", "Fotos", "Chat", "Más"]);
    await userEvent.click(screen.getByRole("button", ACCOUNT_BUTTON));
    expect(screen.getAllByRole("link", { name: /Panel/ })).toHaveLength(1);
    expect(screen.getByRole("link", { name: /Panel/ })).toHaveAttribute("href", "/admin");
  });

  it.each(["idle", "restoring"] as const)("shows only the public destinations and no session action while %s", async (status) => {
    renderApp("/", statusState(status));

    const top = await screen.findByRole("navigation", { name: "Navegación principal" });
    expect(linkNames(top)).toEqual(["Programa"]);
    expect(linkNames(screen.getByRole("navigation", { name: "Navegación inferior" }))).toEqual(["Inicio", "Programa"]);
    expect(screen.queryByRole("link", { name: "Entrar" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", ACCOUNT_BUTTON)).not.toBeInTheDocument();
  });

  it("goes straight from the restoring nav to the member nav, never through the anonymous one", async () => {
    const { store } = renderApp("/", statusState("restoring"));
    const seen: string[][] = [];
    const record = (): void => {
      const bottom = screen.queryByRole("navigation", { name: "Navegación inferior" });
      if (bottom !== null) seen.push(linkNames(bottom));
    };
    await screen.findByRole("navigation", { name: "Navegación inferior" });
    record();

    act(() => {
      store.dispatch(tokenRefreshed({ accessToken: "t", user: makeUser() }));
    });
    record();

    expect(seen).toEqual([
      ["Inicio", "Programa"],
      ["Inicio", "Programa", "Fotos", "Chat", "Más"]
    ]);
    expect(seen.flat()).not.toContain("Entrar");
  });

  it.each(["/entrar", "/entrar/enlace", "/invitacion", "/recuperar", "/restablecer", "/verificar"])(
    "hides the bottom navigation on the auth screen %s",
    async (path) => {
      renderApp(path, statusState("anonymous"));

      await screen.findByRole("navigation", { name: "Navegación principal" });
      expect(await screen.findByRole("heading", { level: 1 })).toBeInTheDocument();
      expect(screen.queryByRole("navigation", { name: "Navegación inferior" })).not.toBeInTheDocument();
    }
  );

  it("hides the bottom navigation during the forced password change", async () => {
    renderApp("/perfil", authenticatedState(makeUser({ mustChangePassword: true })));

    expect(await screen.findByRole("heading", { name: /Cambia tu contraseña/ })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Navegación inferior" })).not.toBeInTheDocument();
  });

  it("shows the verify-email banner only to logged-in users with an unverified email", async () => {
    renderApp("/", authenticatedState(makeUser({ emailVerified: false })));

    expect(await screen.findByRole("region", { name: "Verifica tu correo" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reenviar enlace" })).toBeInTheDocument();
  });

  it("does not show the verify-email banner to verified users", async () => {
    renderApp("/", authenticatedState(makeUser({ emailVerified: true })));

    await screen.findByRole("navigation", { name: "Navegación inferior" });
    expect(screen.queryByRole("region", { name: "Verifica tu correo" })).not.toBeInTheDocument();
  });

  it("points Programa at the featured edition when one is upcoming", async () => {
    server.use(
      http.get(apiUrl("/cuencadas/home"), () =>
        HttpResponse.json({ mode: "upcoming", featured: makePublicCuencada({ year: 2027, status: "upcoming" }), latestPast: null, announcements: [] })
      )
    );
    // Logged in: /chat for an anonymous visitor redirects to /entrar, which has no BottomNav (minimal chrome).
    renderApp("/chat", authenticatedState());

    const bottom = await screen.findByRole("navigation", { name: "Navegación inferior" });
    await waitFor(() => expect(within(bottom).getByRole("link", { name: /Programa/ })).toHaveAttribute("href", "/cuencada/2027"));
  });

  it("points Programa at the latest past edition when the featured edition is announced without dates", async () => {
    server.use(
      http.get(apiUrl("/cuencadas/home"), () =>
        // `announced` (WP-3.1a) is not in this build's HomeMode yet: an unknown mode counts as undated.
        HttpResponse.json({
          ...makeMemoriesHome(),
          mode: "announced",
          featured: makePublicCuencada({ year: 2027, status: "upcoming" })
        })
      )
    );
    renderApp("/chat", authenticatedState());

    const bottom = await screen.findByRole("navigation", { name: "Navegación inferior" });
    await waitFor(() => expect(within(bottom).getByRole("link", { name: /Programa/ })).toHaveAttribute("href", "/cuencada/2026"));
    expect(within(screen.getByRole("navigation", { name: "Navegación principal" })).getByRole("link", { name: "Programa" })).toHaveAttribute(
      "href",
      "/cuencada/2026"
    );
  });

  it("falls back to / for Programa when the home query has no edition", async () => {
    server.use(http.get(apiUrl("/cuencadas/home"), () => HttpResponse.json(makeMemoriesHome({ latestPast: null }))));
    renderApp("/chat", statusState("anonymous"));

    const top = await screen.findByRole("navigation", { name: "Navegación principal" });
    expect(within(top).getByRole("link", { name: "Programa" })).toHaveAttribute("href", "/");
  });
});
