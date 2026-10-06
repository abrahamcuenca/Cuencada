import { inviteAcceptInputSchema, inviteInspectInputSchema } from "@cuencada/types";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { HttpResponse, http } from "msw";
import { apiUrl, authenticatedState, makeUser, statusState } from "../../../../test/auth";
import { renderApp } from "../../../../test/renderApp";
import { clearFragmentToken, readAndScrubFragmentToken } from "../../../shared/lib/fragmentToken";
import { cancelOnlineLogoutRetry } from "../session";
import { INVITE_INVALID_MESSAGE, LINK_MISSING_MESSAGE, PASSWORDS_DIFFER_MESSAGE, RATE_LIMITED_MESSAGE } from "../forms";
import { apiError, contractRoute, FRAGMENT_TOKEN, makeInvite, tokenResponse } from "../testing/contractHandlers";
import { INVITE_ACCEPT_REJECTED_MESSAGE, INVITE_EMAIL_MISMATCH_MESSAGE, INVITE_EMAIL_TAKEN_MESSAGE } from "./InvitePage";
import { createTestServer } from "../../../../test/msw";

const server = createTestServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
afterEach(() => {
  server.resetHandlers();
  clearFragmentToken();
  cancelOnlineLogoutRetry();
  window.history.replaceState(null, "", "/");
});

const PASSWORD = "mi frase secreta larga";

function openInvite(invite = makeInvite(), preloaded = statusState("anonymous")): ReturnType<typeof renderApp> {
  server.use(contractRoute("post", "/invites/inspect", inviteInspectInputSchema, () => Response.json(invite)));
  window.history.replaceState(null, "", `/invitacion#t=${FRAGMENT_TOKEN}`);
  return renderApp("/invitacion", preloaded);
}

async function fillForm({ email = "tia.lupe@example.com", password = PASSWORD, confirm = PASSWORD } = {}): Promise<void> {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText("Correo electrónico"), email);
  await user.type(screen.getByLabelText("Crea una contraseña"), password);
  await user.type(screen.getByLabelText("Confirma tu contraseña"), confirm);
  await user.click(screen.getByRole("button", { name: "Crear mi cuenta" }));
}

describe("InvitePage", () => {
  it("shows who invited the user and only the masked email", async () => {
    openInvite();

    expect(await screen.findByText(/Jorge Ejemplo te invitó/)).toBeInTheDocument();
    expect(screen.getAllByText(/t\*\*\*@e\*\*\*\.com/)).toHaveLength(1);
    expect(screen.getByLabelText("Nombre completo")).toHaveValue("Lupe Ejemplo");
    expect(screen.getByLabelText("Correo electrónico")).toHaveValue("");
    expect(screen.queryByText(/tia\.lupe@example\.com/)).not.toBeInTheDocument();
  });

  it("creates the account, logs in, welcomes the user and forgets the token", async () => {
    const accepted = vi.fn();
    server.use(
      contractRoute("post", "/invites/accept", inviteAcceptInputSchema, ({ body }) => {
        accepted(body);
        return tokenResponse(makeUser({ email: body.email, displayName: body.displayName }), "token-invitacion", 201);
      })
    );
    const { store, router } = openInvite();

    await fillForm({ email: "Tia.Lupe@example.com" });

    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(accepted).toHaveBeenCalledWith({ token: FRAGMENT_TOKEN, email: "tia.lupe@example.com", displayName: "Lupe Ejemplo", password: PASSWORD });
    expect(store.getState().auth.accessToken).toBe("token-invitacion");
    expect(await screen.findByText("¡Bienvenida/o a la familia!")).toBeInTheDocument();
    window.history.replaceState(null, "", "/invitacion");
    expect(readAndScrubFragmentToken()).toBeNull();
    expect(JSON.stringify(store.getState())).not.toContain(PASSWORD);
  });

  it("rejects an email that does not match the invite before calling the server", async () => {
    const accepted = vi.fn();
    server.use(
      contractRoute("post", "/invites/accept", inviteAcceptInputSchema, () => {
        accepted();
        return tokenResponse();
      })
    );
    openInvite();

    await fillForm({ email: "otra@persona.mx" });

    expect(await screen.findByText(INVITE_EMAIL_MISMATCH_MESSAGE)).toBeInTheDocument();
    expect(accepted).not.toHaveBeenCalled();
  });

  it("explains the password rules, rates the password live and requires a matching confirmation", async () => {
    openInvite();
    const password = await screen.findByLabelText("Crea una contraseña");
    expect(password).toHaveAccessibleDescription(/Al menos 12 caracteres/);
    expect(password).toHaveAttribute("autocomplete", "new-password");

    await userEvent.type(password, "corta");
    expect(screen.getByText("Te faltan 7 caracteres.")).toBeInTheDocument();
    await userEvent.type(password, " pero ya no tanto");
    expect(screen.getByText("Muy buena.")).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("Correo electrónico"), "tia.lupe@example.com");
    await userEvent.type(screen.getByLabelText("Confirma tu contraseña"), "otra cosa distinta");
    await userEvent.click(screen.getByRole("button", { name: "Crear mi cuenta" }));

    expect(await screen.findByText(PASSWORDS_DIFFER_MESSAGE)).toBeInTheDocument();
  });

  it("shows the contract error for a short password", async () => {
    openInvite();

    await fillForm({ password: "corta", confirm: "corta" });

    expect(await screen.findByText("La contraseña debe tener al menos 12 caracteres.")).toBeInTheDocument();
  });

  it("shows a generic message when the server rejects a bound invite on accept", async () => {
    server.use(contractRoute("post", "/invites/accept", inviteAcceptInputSchema, () => apiError("INVITE_INVALID")));
    openInvite();

    await fillForm();

    expect(await screen.findByText(INVITE_ACCEPT_REJECTED_MESSAGE)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Crear mi cuenta" })).toBeInTheDocument();
  });

  it("explains that the email already has an account on 409", async () => {
    server.use(contractRoute("post", "/invites/accept", inviteAcceptInputSchema, () => apiError("CONFLICT")));
    openInvite();

    await fillForm();

    expect(await screen.findByText(INVITE_EMAIL_TAKEN_MESSAGE)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ir a Entrar" })).toHaveAttribute("href", "/entrar");
  });

  it("shows the rate-limit message on 429", async () => {
    server.use(contractRoute("post", "/invites/accept", inviteAcceptInputSchema, () => apiError("RATE_LIMITED")));
    openInvite();

    await fillForm();

    expect(await screen.findByText(RATE_LIMITED_MESSAGE)).toBeInTheDocument();
  });

  it("accepts an open invite with any email", async () => {
    server.use(contractRoute("post", "/invites/accept", inviteAcceptInputSchema, () => tokenResponse(makeUser(), "t", 201)));
    const { router } = openInvite(makeInvite({ emailMasked: null, invitedByName: null, suggestedDisplayName: null }));

    expect(await screen.findByText(/La familia te invitó/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Nombre completo"), "Primo Nuevo");
    await fillForm({ email: "primo@nuevo.mx" });

    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("shows the invalid state for an expired, revoked or used invite", async () => {
    server.use(contractRoute("post", "/invites/inspect", inviteInspectInputSchema, () => apiError("INVITE_INVALID")));
    window.history.replaceState(null, "", `/invitacion#t=${FRAGMENT_TOKEN}`);
    renderApp("/invitacion", statusState("anonymous"));

    expect(await screen.findByText(INVITE_INVALID_MESSAGE)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Invitación no válida/ })).toBeInTheDocument();
    window.history.replaceState(null, "", "/invitacion");
    expect(readAndScrubFragmentToken()).toBeNull();
  });

  it("shows the incomplete-link message when there is no token", async () => {
    window.history.replaceState(null, "", "/invitacion");
    renderApp("/invitacion", statusState("anonymous"));

    expect(await screen.findByText(LINK_MISSING_MESSAGE)).toBeInTheDocument();
  });

  it("does not offer the accept form while another user is logged in", async () => {
    const accepted = vi.fn();
    server.use(
      contractRoute("post", "/invites/accept", inviteAcceptInputSchema, () => {
        accepted();
        return tokenResponse();
      })
    );
    const { store } = openInvite(makeInvite(), authenticatedState(makeUser({ displayName: "Rosa Ejemplo" }), "token-A"));

    expect(await screen.findByText(/Ya tienes la sesión abierta como/)).toHaveTextContent("Rosa Ejemplo");
    expect(screen.queryByRole("button", { name: "Crear mi cuenta" })).not.toBeInTheDocument();
    expect(accepted).not.toHaveBeenCalled();
    expect(store.getState().auth.accessToken).toBe("token-A");
  });

  it("shows the accept form after the user logs out from the interstitial", async () => {
    server.use(http.post(apiUrl("/auth/logout"), () => new HttpResponse(null, { status: 204 })));
    const { store } = openInvite(makeInvite(), authenticatedState(makeUser({ displayName: "Rosa Ejemplo" })));

    await userEvent.click(await screen.findByRole("button", { name: "Cerrar sesión y continuar" }));

    expect(await screen.findByRole("button", { name: "Crear mi cuenta" })).toBeInTheDocument();
    expect(store.getState().auth.status).toBe("anonymous");
  });
});
