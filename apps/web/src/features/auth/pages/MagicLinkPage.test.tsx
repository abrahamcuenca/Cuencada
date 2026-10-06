import { magicLinkConsumeInputSchema } from "@cuencada/types";
import { screen, waitFor } from "@testing-library/react";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { makeUser, statusState } from "../../../../test/auth";
import { renderApp } from "../../../../test/renderApp";
import { clearFragmentToken, readAndScrubFragmentToken } from "../../../shared/lib/fragmentToken";
import { LINK_INVALID_MESSAGE, LINK_MISSING_MESSAGE, RATE_LIMITED_MESSAGE } from "../forms";
import { apiError, contractRoute, FRAGMENT_TOKEN, tokenResponse } from "../testing/contractHandlers";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
afterEach(() => {
  server.resetHandlers();
  clearFragmentToken();
  window.history.replaceState(null, "", "/");
});

function openLink(): ReturnType<typeof renderApp> {
  window.history.replaceState(null, "", `/entrar/enlace#t=${FRAGMENT_TOKEN}`);
  return renderApp("/entrar/enlace", statusState("anonymous"));
}

describe("MagicLinkPage", () => {
  it("exchanges the token once, logs in, redirects home and forgets the token", async () => {
    const consumed = vi.fn();
    server.use(
      contractRoute("post", "/auth/magic-link/consume", magicLinkConsumeInputSchema, ({ body }) => {
        consumed(body.token);
        return tokenResponse(makeUser(), "token-enlace");
      })
    );
    const { store, router } = openLink();

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
    server.use(contractRoute("post", "/auth/magic-link/consume", magicLinkConsumeInputSchema, () => new Promise<Response>(() => {})));
    openLink();

    expect(await screen.findByRole("heading", { name: "Entrando…" })).toBeInTheDocument();
    expect(screen.getByText("Validando tu enlace…")).toBeInTheDocument();
  });

  it("sends a user with a temporary password to /cambiar-contrasena", async () => {
    server.use(contractRoute("post", "/auth/magic-link/consume", magicLinkConsumeInputSchema, () => tokenResponse(makeUser({ mustChangePassword: true }))));
    const { router } = openLink();

    await waitFor(() => expect(router.state.location.pathname).toBe("/cambiar-contrasena"));
  });

  it("explains an expired or used link and offers to request another one", async () => {
    server.use(contractRoute("post", "/auth/magic-link/consume", magicLinkConsumeInputSchema, () => apiError("TOKEN_INVALID")));
    openLink();

    expect(await screen.findByText(LINK_INVALID_MESSAGE)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Pedir otro enlace" })).toHaveAttribute("href", "/entrar");
    window.history.replaceState(null, "", "/entrar/enlace");
    expect(readAndScrubFragmentToken()).toBeNull();
  });

  it("shows the rate-limit message on 429", async () => {
    server.use(contractRoute("post", "/auth/magic-link/consume", magicLinkConsumeInputSchema, () => apiError("RATE_LIMITED")));
    openLink();

    expect(await screen.findByText(RATE_LIMITED_MESSAGE)).toBeInTheDocument();
  });

  it("tells the user the link is incomplete when there is no token, without calling the server", async () => {
    window.history.replaceState(null, "", "/entrar/enlace");
    renderApp("/entrar/enlace", statusState("anonymous"));

    expect(await screen.findByText(LINK_MISSING_MESSAGE)).toBeInTheDocument();
  });
});
