import { changePasswordInputSchema, PASSWORD_BREACHED_MESSAGE } from "@cuencada/types";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { apiUrl, authenticatedState, makeUser } from "../../../../test/auth";
import { renderApp } from "../../../../test/renderApp";
import { PASSWORDS_DIFFER_MESSAGE, RATE_LIMITED_MESSAGE } from "../forms";
import { cancelOnlineLogoutRetry } from "../session";
import { apiError, breachedPasswordResponse, contractRoute, tokenResponse } from "../testing/contractHandlers";
import { WRONG_CURRENT_PASSWORD_MESSAGE } from "./ChangePasswordPage";
import { createTestServer } from "../../../../test/msw";

const server = createTestServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
afterEach(() => {
  server.resetHandlers();
  cancelOnlineLogoutRetry();
});

const TEMP = "Temporal123!";
const NEW = "una frase nueva y larga";

async function submitChange(currentLabel: string, current = TEMP, next = NEW, confirm = NEW): Promise<void> {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText(currentLabel), current);
  await user.type(screen.getByLabelText("Nueva contraseña"), next);
  await user.type(screen.getByLabelText("Confirma la nueva"), confirm);
}

describe("ChangePasswordPage", () => {
  it("names each show/hide toggle after its own field", async () => {
    renderApp("/cambiar-contrasena", authenticatedState(makeUser({ mustChangePassword: true })));

    expect(await screen.findByRole("button", { name: "Mostrar contraseña temporal" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mostrar nueva contraseña" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Mostrar confirmación" }));
    expect(screen.getByRole("button", { name: "Ocultar confirmación" })).toBeInTheDocument();
    expect(screen.getByLabelText("Confirma la nueva")).toHaveAttribute("type", "text");
  });

  it("completes the forced change: new token, gate cleared, back to the app", async () => {
    const changed = vi.fn();
    server.use(
      contractRoute("post", "/auth/change-password", changePasswordInputSchema, ({ body }) => {
        changed(body);
        return tokenResponse(makeUser({ mustChangePassword: false }), "token-rotado");
      })
    );
    const { store, router } = renderApp("/perfil", authenticatedState(makeUser({ mustChangePassword: true })));

    await waitFor(() => expect(router.state.location.pathname).toBe("/cambiar-contrasena"));
    expect(await screen.findByRole("heading", { name: /Cambia tu contraseña/ })).toBeInTheDocument();
    await submitChange("Contraseña temporal");
    await userEvent.click(screen.getByRole("button", { name: "Guardar y continuar" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(changed).toHaveBeenCalledWith({ currentPassword: TEMP, newPassword: NEW });
    expect(store.getState().auth.passwordChangeRequired).toBe(false);
    expect(store.getState().auth.accessToken).toBe("token-rotado");
    expect(JSON.stringify(store.getState())).not.toContain(NEW);

    await router.navigate("/perfil");
    expect(router.state.location.pathname).toBe("/perfil");
  });

  it("offers Cerrar sesión as the only way out of the forced change", async () => {
    server.use(http.post(apiUrl("/auth/logout"), () => new HttpResponse(null, { status: 204 })));
    const { store, router } = renderApp("/cambiar-contrasena", authenticatedState(makeUser({ mustChangePassword: true })));

    await userEvent.click(await screen.findByRole("button", { name: "Cerrar sesión" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/entrar"));
    expect(store.getState().auth.status).toBe("anonymous");
  });

  it("supports a voluntary change and returns to the remembered page", async () => {
    server.use(
      contractRoute("post", "/auth/change-password", changePasswordInputSchema, () => tokenResponse()),
      contractRoute("get", "/auth/sessions", null, () => Response.json([]))
    );
    const { router } = renderApp("/cambiar-contrasena", authenticatedState());
    await router.navigate("/cambiar-contrasena", { state: { from: "/perfil/sesiones" }, replace: true });

    expect(await screen.findByRole("heading", { name: /Cambiar contraseña/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cerrar sesión" })).not.toBeInTheDocument();
    await submitChange("Contraseña actual");
    await userEvent.click(screen.getByRole("button", { name: "Guardar contraseña" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/perfil/sesiones"));
  });

  it("shows a field error and keeps the session when the server rejects the current password with 400 VALIDATION", async () => {
    server.use(
      contractRoute("post", "/auth/change-password", changePasswordInputSchema, () =>
        HttpResponse.json(
          { error: { code: "VALIDATION", message: "Datos inválidos.", details: [{ path: "currentPassword", message: "Incorrecta." }] } },
          { status: 400 }
        )
      )
    );
    const { store, router } = renderApp("/cambiar-contrasena", authenticatedState(makeUser({ mustChangePassword: true })));

    await submitChange("Contraseña temporal");
    await userEvent.click(screen.getByRole("button", { name: "Guardar y continuar" }));

    expect(await screen.findByText(WRONG_CURRENT_PASSWORD_MESSAGE)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Contraseña temporal")).toHaveFocus());
    expect(screen.getByLabelText("Contraseña temporal")).toHaveAttribute("aria-invalid", "true");
    expect(store.getState().auth.status).toBe("authenticated");
    expect(router.state.location.pathname).toBe("/cambiar-contrasena");
  });

  it("shows the server message for a VALIDATION error on another field", async () => {
    server.use(
      contractRoute("post", "/auth/change-password", changePasswordInputSchema, () =>
        HttpResponse.json(
          { error: { code: "VALIDATION", message: "La contraseña es demasiado común.", details: [{ path: "newPassword", message: "Común." }] } },
          { status: 400 }
        )
      )
    );
    renderApp("/cambiar-contrasena", authenticatedState());

    await submitChange("Contraseña actual");
    await userEvent.click(screen.getByRole("button", { name: "Guardar contraseña" }));

    expect(await screen.findByText("La contraseña es demasiado común.")).toBeInTheDocument();
    expect(screen.queryByText(WRONG_CURRENT_PASSWORD_MESSAGE)).not.toBeInTheDocument();
  });

  it("shows the breached-password message on the new-password field and keeps the session", async () => {
    server.use(contractRoute("post", "/auth/change-password", changePasswordInputSchema, () => breachedPasswordResponse("newPassword")));
    const { store } = renderApp("/cambiar-contrasena", authenticatedState(makeUser({ mustChangePassword: true })));

    await submitChange("Contraseña temporal");
    await userEvent.click(screen.getByRole("button", { name: "Guardar y continuar" }));

    expect(await screen.findByText(PASSWORD_BREACHED_MESSAGE)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Nueva contraseña")).toHaveFocus());
    expect(screen.getByLabelText("Nueva contraseña")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Contraseña temporal")).not.toHaveAttribute("aria-invalid", "true");
    expect(store.getState().auth.status).toBe("authenticated");
  });

  it("treats 401 INVALID_CREDENTIALS as a wrong current password without logging out", async () => {
    server.use(contractRoute("post", "/auth/change-password", changePasswordInputSchema, () => apiError("INVALID_CREDENTIALS")));
    const { store } = renderApp("/cambiar-contrasena", authenticatedState(makeUser({ mustChangePassword: true })));

    await submitChange("Contraseña temporal");
    await userEvent.click(screen.getByRole("button", { name: "Guardar y continuar" }));

    expect(await screen.findByText(WRONG_CURRENT_PASSWORD_MESSAGE)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Contraseña temporal")).toHaveFocus());
    expect(store.getState().auth.status).toBe("authenticated");
  });

  it("validates the new password locally: length, reuse and confirmation", async () => {
    const changed = vi.fn();
    server.use(
      contractRoute("post", "/auth/change-password", changePasswordInputSchema, () => {
        changed();
        return tokenResponse();
      })
    );
    renderApp("/cambiar-contrasena", authenticatedState(makeUser({ mustChangePassword: true })));

    await submitChange("Contraseña temporal", TEMP, "corta", "otra");
    await userEvent.click(screen.getByRole("button", { name: "Guardar y continuar" }));
    expect(await screen.findByText("La contraseña debe tener al menos 12 caracteres.")).toBeInTheDocument();
    expect(screen.getByText(PASSWORDS_DIFFER_MESSAGE)).toBeInTheDocument();

    await userEvent.clear(screen.getByLabelText("Nueva contraseña"));
    await userEvent.type(screen.getByLabelText("Nueva contraseña"), "misma contraseña larga");
    await userEvent.clear(screen.getByLabelText("Contraseña temporal"));
    await userEvent.type(screen.getByLabelText("Contraseña temporal"), "misma contraseña larga");
    await userEvent.click(screen.getByRole("button", { name: "Guardar y continuar" }));
    expect(await screen.findByText("La nueva contraseña debe ser distinta de la actual.")).toBeInTheDocument();
    expect(changed).not.toHaveBeenCalled();
  });

  it("shows the rate-limit message on 429", async () => {
    server.use(contractRoute("post", "/auth/change-password", changePasswordInputSchema, () => apiError("RATE_LIMITED")));
    renderApp("/cambiar-contrasena", authenticatedState());

    await submitChange("Contraseña actual");
    await userEvent.click(screen.getByRole("button", { name: "Guardar contraseña" }));

    expect(await screen.findByText(RATE_LIMITED_MESSAGE)).toBeInTheDocument();
  });
});
