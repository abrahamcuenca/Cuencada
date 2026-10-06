import { emailVerifyConfirmInputSchema } from "@cuencada/types";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { authenticatedState, makeUser, statusState } from "../../../../test/auth";
import { renderApp } from "../../../../test/renderApp";
import { clearFragmentToken, readAndScrubFragmentToken } from "../../../shared/lib/fragmentToken";
import { LINK_INVALID_MESSAGE, LINK_MISSING_MESSAGE } from "../forms";
import { apiError, contractRoute, FRAGMENT_TOKEN, noContent } from "../testing/contractHandlers";
import { EMAIL_VERIFIED_MESSAGE } from "./VerifyEmailPage";
import { createTestServer } from "../../../../test/msw";

const server = createTestServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
afterEach(() => {
  server.resetHandlers();
  clearFragmentToken();
  window.history.replaceState(null, "", "/");
});

function openVerify(preloaded = statusState("anonymous")): ReturnType<typeof renderApp> {
  window.history.replaceState(null, "", `/verificar#t=${FRAGMENT_TOKEN}`);
  return renderApp("/verificar", preloaded);
}

async function openAndConfirm(preloaded = statusState("anonymous")): Promise<ReturnType<typeof renderApp>> {
  const result = openVerify(preloaded);
  await userEvent.click(await screen.findByRole("button", { name: "Confirmar mi correo" }));
  return result;
}

describe("VerifyEmailPage", () => {
  it("confirms the email for an anonymous visitor and forgets the token", async () => {
    const verified = vi.fn();
    server.use(
      contractRoute("post", "/auth/email/verify", emailVerifyConfirmInputSchema, ({ body }) => {
        verified(body.token);
        return noContent();
      })
    );
    await openAndConfirm();

    expect(await screen.findByText(EMAIL_VERIFIED_MESSAGE)).toBeInTheDocument();
    expect(verified).toHaveBeenCalledWith(FRAGMENT_TOKEN);
    expect(within(screen.getByRole("main")).getByRole("link", { name: "Entrar" })).toHaveAttribute("href", "/entrar");
    window.history.replaceState(null, "", "/verificar");
    expect(readAndScrubFragmentToken()).toBeNull();
  });

  it("refreshes the current user so emailVerified turns true when logged in", async () => {
    const user = makeUser({ emailVerified: false });
    server.use(
      contractRoute("post", "/auth/email/verify", emailVerifyConfirmInputSchema, () => noContent()),
      contractRoute("get", "/me", null, () => Response.json({ ...user, emailVerified: true }))
    );
    const { store } = await openAndConfirm(authenticatedState(user));

    expect(await screen.findByText(EMAIL_VERIFIED_MESSAGE)).toBeInTheDocument();
    await waitFor(() => expect(store.getState().auth.user?.emailVerified).toBe(true));
  });

  it("explains an expired or used link", async () => {
    server.use(contractRoute("post", "/auth/email/verify", emailVerifyConfirmInputSchema, () => apiError("TOKEN_INVALID")));
    await openAndConfirm();

    expect(await screen.findByText(LINK_INVALID_MESSAGE)).toBeInTheDocument();
    expect(screen.getByText(/Entra a tu cuenta para pedir otro enlace/)).toBeInTheDocument();
  });

  it("offers to resend the link to a logged-in, unverified user when the token is invalid", async () => {
    server.use(contractRoute("post", "/auth/email/verify", emailVerifyConfirmInputSchema, () => apiError("TOKEN_INVALID")));
    await openAndConfirm(authenticatedState(makeUser({ emailVerified: false })));

    expect(await screen.findByText(LINK_INVALID_MESSAGE)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Reenviar enlace" }).length).toBeGreaterThan(0);
  });

  it("shows the incomplete-link message when there is no token", async () => {
    window.history.replaceState(null, "", "/verificar");
    renderApp("/verificar", statusState("anonymous"));

    expect(await screen.findByText(LINK_MISSING_MESSAGE)).toBeInTheDocument();
  });

  it("does not use the token until the user taps Confirmar mi correo", async () => {
    const verified = vi.fn();
    server.use(
      contractRoute("post", "/auth/email/verify", emailVerifyConfirmInputSchema, () => {
        verified();
        return noContent();
      })
    );
    openVerify();

    expect(await screen.findByRole("button", { name: "Confirmar mi correo" })).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(verified).not.toHaveBeenCalled();
  });

  it("names the logged-in account and keeps the session when verifying", async () => {
    const user = makeUser({ displayName: "Rosa Cuenca", emailVerified: false });
    server.use(
      contractRoute("post", "/auth/email/verify", emailVerifyConfirmInputSchema, () => noContent()),
      contractRoute("get", "/me", null, () => Response.json({ ...user, emailVerified: true }))
    );
    const { store } = openVerify(authenticatedState(user, "token-A"));

    expect(await screen.findByText(/Tienes la sesión abierta como/)).toHaveTextContent("Rosa Cuenca");
    expect(screen.getByText(/no cambia tu sesión/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Confirmar mi correo" }));

    expect(await screen.findByText(EMAIL_VERIFIED_MESSAGE)).toBeInTheDocument();
    expect(store.getState().auth.accessToken).toBe("token-A");
  });

  it("discards the token and goes home on Ahora no", async () => {
    const verified = vi.fn();
    server.use(
      contractRoute("post", "/auth/email/verify", emailVerifyConfirmInputSchema, () => {
        verified();
        return noContent();
      })
    );
    const { router } = openVerify();

    await userEvent.click(await screen.findByRole("button", { name: "Ahora no" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(verified).not.toHaveBeenCalled();
    window.history.replaceState(null, "", "/verificar");
    expect(readAndScrubFragmentToken()).toBeNull();
  });
});
