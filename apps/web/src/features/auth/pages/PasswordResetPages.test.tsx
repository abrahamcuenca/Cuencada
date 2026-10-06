import { passwordResetConfirmInputSchema, passwordResetRequestInputSchema } from "@cuencada/types";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { authenticatedState, statusState } from "../../../../test/auth";
import { renderApp } from "../../../../test/renderApp";
import { clearFragmentToken, readAndScrubFragmentToken } from "../../../shared/lib/fragmentToken";
import { LINK_INVALID_MESSAGE, LINK_MISSING_MESSAGE, PASSWORDS_DIFFER_MESSAGE, RATE_LIMITED_MESSAGE } from "../forms";
import { apiError, contractRoute, FRAGMENT_TOKEN, noContent, okAccepted } from "../testing/contractHandlers";
import { RESET_REQUESTED_MESSAGE } from "./ForgotPasswordPage";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
afterEach(() => {
  server.resetHandlers();
  clearFragmentToken();
  window.history.replaceState(null, "", "/");
});

const PASSWORD = "nueva frase de acceso";

describe("ForgotPasswordPage", () => {
  it("requests a reset link and shows a generic confirmation", async () => {
    const requested = vi.fn();
    server.use(
      contractRoute("post", "/auth/password-reset/request", passwordResetRequestInputSchema, ({ body }) => {
        requested(body.email);
        return okAccepted();
      })
    );
    renderApp("/recuperar", statusState("anonymous"));

    await userEvent.type(await screen.findByLabelText("Correo electrónico"), "nadie@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Enviar enlace" }));

    expect(await screen.findByText(RESET_REQUESTED_MESSAGE)).toBeInTheDocument();
    expect(requested).toHaveBeenCalledWith("nadie@example.com");
  });

  it("asks for a valid email first", async () => {
    renderApp("/recuperar", statusState("anonymous"));

    await userEvent.click(await screen.findByRole("button", { name: "Enviar enlace" }));

    expect(await screen.findByText("Correo electrónico inválido.")).toBeInTheDocument();
  });

  it("shows the rate-limit message on 429", async () => {
    server.use(contractRoute("post", "/auth/password-reset/request", passwordResetRequestInputSchema, () => apiError("RATE_LIMITED")));
    renderApp("/recuperar", statusState("anonymous"));

    await userEvent.type(await screen.findByLabelText("Correo electrónico"), "prima@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Enviar enlace" }));

    expect(await screen.findByText(RATE_LIMITED_MESSAGE)).toBeInTheDocument();
  });
});

function openReset(preloaded = statusState("anonymous")): ReturnType<typeof renderApp> {
  window.history.replaceState(null, "", `/restablecer#t=${FRAGMENT_TOKEN}`);
  return renderApp("/restablecer", preloaded);
}

async function submitReset(password = PASSWORD, confirm = PASSWORD): Promise<void> {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText("Nueva contraseña"), password);
  await user.type(screen.getByLabelText("Confirma tu contraseña"), confirm);
  await user.click(screen.getByRole("button", { name: "Guardar contraseña" }));
}

describe("ResetPasswordPage", () => {
  it("saves the new password, forgets the token and sends the user to /entrar", async () => {
    const confirmed = vi.fn();
    server.use(
      contractRoute("post", "/auth/password-reset/confirm", passwordResetConfirmInputSchema, ({ body }) => {
        confirmed(body);
        return noContent();
      })
    );
    const { router } = openReset();

    await submitReset();

    await waitFor(() => expect(router.state.location.pathname).toBe("/entrar"));
    expect(confirmed).toHaveBeenCalledWith({ token: FRAGMENT_TOKEN, newPassword: PASSWORD });
    expect(await screen.findByText("Contraseña actualizada. Ya puedes entrar.")).toBeInTheDocument();
    window.history.replaceState(null, "", "/restablecer");
    expect(readAndScrubFragmentToken()).toBeNull();
  });

  it("clears this tab's session after a reset, because the server revoked it", async () => {
    server.use(contractRoute("post", "/auth/password-reset/confirm", passwordResetConfirmInputSchema, () => noContent()));
    const { store, router } = openReset(authenticatedState());

    await submitReset();

    await waitFor(() => expect(router.state.location.pathname).toBe("/entrar"));
    expect(store.getState().auth.status).toBe("anonymous");
  });

  it("requires matching passwords of at least 12 characters", async () => {
    openReset();

    await submitReset("corta", "otra");

    expect(await screen.findByText("La contraseña debe tener al menos 12 caracteres.")).toBeInTheDocument();
    expect(screen.getByText(PASSWORDS_DIFFER_MESSAGE)).toBeInTheDocument();
  });

  it("shows the dead-link state with a way to request another link when the token is invalid", async () => {
    server.use(contractRoute("post", "/auth/password-reset/confirm", passwordResetConfirmInputSchema, () => apiError("TOKEN_INVALID")));
    openReset();

    await submitReset();

    expect(await screen.findByText(LINK_INVALID_MESSAGE)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Pedir otro enlace" })).toHaveAttribute("href", "/recuperar");
  });

  it("shows the rate-limit message on 429 and keeps the form", async () => {
    server.use(contractRoute("post", "/auth/password-reset/confirm", passwordResetConfirmInputSchema, () => apiError("RATE_LIMITED")));
    openReset();

    await submitReset();

    expect(await screen.findByText(RATE_LIMITED_MESSAGE)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Guardar contraseña" })).toBeEnabled();
  });

  it("shows the incomplete-link message when there is no token", async () => {
    window.history.replaceState(null, "", "/restablecer");
    renderApp("/restablecer", statusState("anonymous"));

    expect(await screen.findByText(LINK_MISSING_MESSAGE)).toBeInTheDocument();
  });
});
