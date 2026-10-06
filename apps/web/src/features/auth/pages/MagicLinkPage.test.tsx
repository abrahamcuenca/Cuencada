import { magicLinkConsumeInputSchema } from "@cuencada/types";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { apiUrl, authenticatedState, makeUser, statusState } from "../../../../test/auth";
import { createTestServer } from "../../../../test/msw";
import { renderApp } from "../../../../test/renderApp";
import { clearFragmentToken, readAndScrubFragmentToken } from "../../../shared/lib/fragmentToken";
import { LINK_INVALID_MESSAGE, LINK_MISSING_MESSAGE, RATE_LIMITED_MESSAGE } from "../forms";
import { cancelOnlineLogoutRetry } from "../session";
import { apiError, contractRoute, FRAGMENT_TOKEN, tokenResponse } from "../testing/contractHandlers";
import { MAGIC_LINK_TITLE } from "./MagicLinkPage";

const server = createTestServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
afterEach(() => {
  server.resetHandlers();
  clearFragmentToken();
  cancelOnlineLogoutRetry();
  window.history.replaceState(null, "", "/");
});

const USER_A = makeUser({ id: "11111111-1111-4111-8111-111111111111", displayName: "Rosa Ejemplo", email: "rosa@example.com" });
const USER_B = makeUser({ id: "22222222-2222-4222-8222-222222222222", displayName: "Primo B", email: "b@example.com" });

function serveConsume(respond: () => Response | Promise<Response> = () => tokenResponse(USER_B, "token-B")): ReturnType<typeof vi.fn> {
  const consumed = vi.fn();
  server.use(
    contractRoute("post", "/auth/magic-link/consume", magicLinkConsumeInputSchema, ({ body }) => {
      consumed(body.token);
      return respond();
    })
  );
  return consumed;
}

function openLink(preloaded = statusState("anonymous")): ReturnType<typeof renderApp> {
  window.history.replaceState(null, "", `/entrar/enlace#t=${FRAGMENT_TOKEN}`);
  return renderApp("/entrar/enlace", preloaded);
}

describe("MagicLinkPage", () => {
  it("does not consume the token on load for an anonymous visitor; it waits for a tap", async () => {
    const consumed = serveConsume();
    openLink();

    expect(await screen.findByRole("heading", { name: MAGIC_LINK_TITLE })).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(consumed).not.toHaveBeenCalled();
  });

  it("exchanges the token once after the tap, logs in, redirects home and forgets the token", async () => {
    const consumed = serveConsume(() => tokenResponse(makeUser(), "token-enlace"));
    const { store, router } = openLink();

    await userEvent.click(await screen.findByRole("button", { name: "Entrar" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(consumed).toHaveBeenCalledTimes(1);
    expect(consumed).toHaveBeenCalledWith(FRAGMENT_TOKEN);
    expect(store.getState().auth.accessToken).toBe("token-enlace");
    expect(window.location.href).not.toContain(FRAGMENT_TOKEN);
    window.history.replaceState(null, "", "/entrar/enlace");
    expect(readAndScrubFragmentToken()).toBeNull();
    expect(JSON.stringify(store.getState())).not.toContain(FRAGMENT_TOKEN);
  });

  it("shows the consuming state while the token is checked", async () => {
    serveConsume(() => new Promise<Response>(() => {}));
    openLink();

    await userEvent.click(await screen.findByRole("button", { name: "Entrar" }));

    expect(await screen.findByRole("heading", { name: "Entrando…" })).toBeInTheDocument();
    expect(screen.getByText("Validando tu enlace…")).toBeInTheDocument();
  });

  it("sends a user with a temporary password to /cambiar-contrasena", async () => {
    serveConsume(() => tokenResponse(makeUser({ mustChangePassword: true })));
    const { router } = openLink();

    await userEvent.click(await screen.findByRole("button", { name: "Entrar" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/cambiar-contrasena"));
  });

  it("explains an expired or used link and offers to request another one", async () => {
    serveConsume(() => apiError("TOKEN_INVALID"));
    openLink();

    await userEvent.click(await screen.findByRole("button", { name: "Entrar" }));

    expect(await screen.findByText(LINK_INVALID_MESSAGE)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Pedir otro enlace" })).toHaveAttribute("href", "/entrar");
    window.history.replaceState(null, "", "/entrar/enlace");
    expect(readAndScrubFragmentToken()).toBeNull();
  });

  it("shows the rate-limit message on 429", async () => {
    serveConsume(() => apiError("RATE_LIMITED"));
    openLink();

    await userEvent.click(await screen.findByRole("button", { name: "Entrar" }));

    expect(await screen.findByText(RATE_LIMITED_MESSAGE)).toBeInTheDocument();
  });

  it("tells the user the link is incomplete when there is no token, without calling the server", async () => {
    window.history.replaceState(null, "", "/entrar/enlace");
    renderApp("/entrar/enlace", statusState("anonymous"));

    expect(await screen.findByText(LINK_MISSING_MESSAGE)).toBeInTheDocument();
  });

  it("waits for the boot refresh before offering anything", async () => {
    const consumed = serveConsume();
    openLink(statusState("restoring"));

    expect(await screen.findByText("Cargando tu sesión…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Entrar" })).not.toBeInTheDocument();
    expect(consumed).not.toHaveBeenCalled();
  });

  describe("while another user is logged in", () => {
    it("shows the interstitial and does not consume the token until the user confirms", async () => {
      const consumed = serveConsume();
      const { store } = openLink(authenticatedState(USER_A, "token-A"));

      expect(await screen.findByText(/Ya tienes la sesión abierta como/)).toHaveTextContent("Rosa Ejemplo");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(consumed).not.toHaveBeenCalled();
      expect(store.getState().auth.user?.id).toBe(USER_A.id);
    });

    it("logs out first, then consumes the token, when the user chooses Cerrar sesión y continuar", async () => {
      const order: string[] = [];
      server.use(
        http.post(apiUrl("/auth/logout"), () => {
          order.push("logout");
          return new HttpResponse(null, { status: 204 });
        })
      );
      serveConsume(() => {
        order.push("consume");
        return tokenResponse(USER_B, "token-B");
      });
      const { store, router } = openLink(authenticatedState(USER_A, "token-A"));

      await userEvent.click(await screen.findByRole("button", { name: "Cerrar sesión y continuar" }));

      await waitFor(() => expect(router.state.location.pathname).toBe("/"));
      expect(order).toEqual(["logout", "consume"]);
      expect(store.getState().auth.user?.id).toBe(USER_B.id);
      expect(store.getState().auth.accessToken).toBe("token-B");
    });

    it("keeps the current session and discards the token when the user chooses Seguir como", async () => {
      const consumed = serveConsume();
      const { store, router } = openLink(authenticatedState(USER_A, "token-A"));

      await userEvent.click(await screen.findByRole("button", { name: "Seguir como Rosa Ejemplo" }));

      await waitFor(() => expect(router.state.location.pathname).toBe("/"));
      expect(consumed).not.toHaveBeenCalled();
      expect(store.getState().auth.accessToken).toBe("token-A");
      window.history.replaceState(null, "", "/entrar/enlace");
      expect(readAndScrubFragmentToken()).toBeNull();
    });
  });
});
