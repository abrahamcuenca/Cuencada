import { passwordResetConfirmInputSchema, passwordResetRequestInputSchema } from "@cuencada/types";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { HttpResponse, http } from "msw";
import { apiUrl, authenticatedState, makeUser, statusState } from "../../../../test/auth";
import { renderApp } from "../../../../test/renderApp";
import { clearFragmentToken, readAndScrubFragmentToken } from "../../../shared/lib/fragmentToken";
import { EMAIL_MAY_BE_SLOW_HINT, LINK_INVALID_MESSAGE, LINK_MISSING_MESSAGE, PASSWORDS_DIFFER_MESSAGE, RATE_LIMITED_MESSAGE } from "../forms";
import { apiError, contractRoute, FRAGMENT_TOKEN, noContent, okAccepted } from "../testing/contractHandlers";
import { cancelOnlineLogoutRetry } from "../session";
import { RESET_REQUESTED_MESSAGE } from "./ForgotPasswordPage";
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
    expect(screen.getByText(EMAIL_MAY_BE_SLOW_HINT)).toBeInTheDocument();
    expect(requested).toHaveBeenCalledWith("nadie@example.com");

    // "vuelve a pedirlo": back to the form, email kept.
    await userEvent.click(screen.getByRole("button", { name: "Pedir otro enlace" }));
    expect(await screen.findByLabelText("Correo electrónico")).toHaveValue("nadie@example.com");
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

  it("asks a logged-in user to log out before using the reset link, then resets", async () => {
    const confirmed = vi.fn();
    server.use(
      http.post(apiUrl("/auth/logout"), () => new HttpResponse(null, { status: 204 })),
      contractRoute("post", "/auth/password-reset/confirm", passwordResetConfirmInputSchema, () => {
        confirmed();
        return noContent();
      })
    );
    const { store, router } = openReset(authenticatedState(makeUser({ displayName: "Rosa Ejemplo" })));

    expect(await screen.findByText(/Ya tienes la sesión abierta como/)).toHaveTextContent("Rosa Ejemplo");
    expect(screen.queryByLabelText("Nueva contraseña")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cerrar sesión y continuar" }));
    await waitFor(() => expect(store.getState().auth.status).toBe("anonymous"));
    await submitReset();

    await waitFor(() => expect(router.state.location.pathname).toBe("/entrar"));
    expect(confirmed).toHaveBeenCalledTimes(1);
  });

  it("keeps the session and discards the reset link on Seguir como", async () => {
    const { store, router } = openReset(authenticatedState(makeUser({ displayName: "Rosa Ejemplo" })));

    await userEvent.click(await screen.findByRole("button", { name: "Seguir como Rosa Ejemplo" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(store.getState().auth.status).toBe("authenticated");
    window.history.replaceState(null, "", "/restablecer");
    expect(readAndScrubFragmentToken()).toBeNull();
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
