import { loginInputSchema, magicLinkRequestInputSchema } from "@cuencada/types";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { authenticatedState, makeUser, statusState } from "../../../../test/auth";
import { renderApp } from "../../../../test/renderApp";
import { INVALID_CREDENTIALS_MESSAGE, RATE_LIMITED_MESSAGE } from "../forms";
import { apiError, contractRoute, okAccepted, tokenResponse } from "../testing/contractHandlers";
import { createTestServer } from "../../../../test/msw";

const server = createTestServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
afterEach(() => server.resetHandlers());

const PASSWORD = "una frase muy larga";

/** Renders /entrar as an anonymous visitor, optionally with a `from` redirect state. */
function renderLogin(from?: string): ReturnType<typeof renderApp> {
  const result = renderApp("/entrar", statusState("anonymous"));
  if (from !== undefined) {
    void result.router.navigate("/entrar", { state: { from }, replace: true });
  }
  return result;
}

async function fillAndSubmit(email: string, password: string): Promise<void> {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText("Correo electrónico"), email);
  if (password !== "") await user.type(screen.getByLabelText("Contraseña"), password);
  await user.click(screen.getByRole("button", { name: "Entrar" }));
}

describe("LoginPage", () => {
  it("logs in, stores the session and goes to the remembered page", async () => {
    const login = vi.fn();
    server.use(
      contractRoute("post", "/auth/login", loginInputSchema, ({ body }) => {
        login(body.email);
        return tokenResponse(makeUser({ email: body.email }), "token-login");
      })
    );
    const { store, router } = renderLogin("/galeria/2026?foto=3");

    await fillAndSubmit("Prima@Example.com ", PASSWORD);

    await waitFor(() => expect(router.state.location.pathname).toBe("/galeria/2026"));
    expect(router.state.location.search).toBe("?foto=3");
    expect(login).toHaveBeenCalledWith("prima@example.com");
    expect(store.getState().auth.accessToken).toBe("token-login");
    expect(store.getState().auth.status).toBe("authenticated");
  });

  it("never keeps the password in the store", async () => {
    server.use(contractRoute("post", "/auth/login", loginInputSchema, () => tokenResponse()));
    const { store, router } = renderLogin();

    await fillAndSubmit("prima@example.com", PASSWORD);

    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(JSON.stringify(store.getState())).not.toContain(PASSWORD);
  });

  it.each([["//evil.example/robar"], ["https://evil.example"], ["/\\evil.example"]])(
    "ignores an unsafe redirect target %s and goes home",
    async (from) => {
      server.use(contractRoute("post", "/auth/login", loginInputSchema, () => tokenResponse()));
      const { router } = renderLogin(from);

      await fillAndSubmit("prima@example.com", PASSWORD);

      await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    }
  );

  it("sends a user with a temporary password to /cambiar-contrasena", async () => {
    server.use(contractRoute("post", "/auth/login", loginInputSchema, () => tokenResponse(makeUser({ mustChangePassword: true }))));
    const { router } = renderLogin("/directorio");

    await fillAndSubmit("prima@example.com", PASSWORD);

    await waitFor(() => expect(router.state.location.pathname).toBe("/cambiar-contrasena"));
    expect(await screen.findByRole("heading", { name: /Cambia tu contraseña/ })).toBeInTheDocument();
  });

  it("shows Spanish field errors and sends nothing when the form is empty or the email is invalid", async () => {
    const login = vi.fn();
    server.use(
      contractRoute("post", "/auth/login", loginInputSchema, () => {
        login();
        return tokenResponse();
      })
    );
    renderLogin();

    await userEvent.click(await screen.findByRole("button", { name: "Entrar" }));
    expect(await screen.findByText("Correo electrónico inválido.")).toBeInTheDocument();
    expect(screen.getByText("Escribe tu contraseña.")).toBeInTheDocument();
    expect(screen.getByLabelText("Correo electrónico")).toHaveAttribute("aria-invalid", "true");
    await waitFor(() => expect(screen.getByLabelText("Correo electrónico")).toHaveFocus());

    await fillAndSubmit("no-es-correo", PASSWORD);
    expect(await screen.findByText("Correo electrónico inválido.")).toBeInTheDocument();
    expect(login).not.toHaveBeenCalled();
  });

  it("shows the same generic message for a wrong password and an unknown email", async () => {
    server.use(contractRoute("post", "/auth/login", loginInputSchema, () => apiError("INVALID_CREDENTIALS", "Mensaje del servidor que podría variar.")));
    renderLogin();

    await fillAndSubmit("nadie@example.com", PASSWORD);

    const message = await screen.findByText(INVALID_CREDENTIALS_MESSAGE);
    expect(message.closest('[role="alert"]')).not.toBeNull();
    expect(screen.queryByText(/podría variar/)).not.toBeInTheDocument();
  });

  it("shows the rate-limit message on 429", async () => {
    server.use(contractRoute("post", "/auth/login", loginInputSchema, () => apiError("RATE_LIMITED")));
    renderLogin();

    await fillAndSubmit("prima@example.com", PASSWORD);

    expect(await screen.findByText(RATE_LIMITED_MESSAGE)).toBeInTheDocument();
  });

  it("disables the submit button while the login is pending", async () => {
    let release: () => void = () => {};
    server.use(
      contractRoute("post", "/auth/login", loginInputSchema, async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return tokenResponse();
      })
    );
    const { router } = renderLogin();

    await fillAndSubmit("prima@example.com", PASSWORD);

    const button = await screen.findByRole("button", { name: /Entrar/ });
    await waitFor(() => expect(button).toBeDisabled());
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: /Recibir enlace/ })).toBeDisabled();
    release();
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("requests a magic link and shows a confirmation that does not reveal whether the account exists", async () => {
    const requested = vi.fn();
    server.use(
      contractRoute("post", "/auth/magic-link/request", magicLinkRequestInputSchema, ({ body }) => {
        requested(body.email);
        return okAccepted();
      })
    );
    renderLogin();

    await userEvent.type(await screen.findByLabelText("Correo electrónico"), "tia@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Recibir enlace por correo" }));

    expect(await screen.findByRole("heading", { name: "Revisa tu correo" })).toBeInTheDocument();
    expect(screen.getByText(/Si tia@example.com tiene una cuenta/)).toBeInTheDocument();
    expect(requested).toHaveBeenCalledWith("tia@example.com");

    await userEvent.click(screen.getByRole("button", { name: "Usar otro correo" }));
    expect(await screen.findByLabelText("Correo electrónico")).toBeInTheDocument();
  });

  it("asks for a valid email before requesting a magic link", async () => {
    renderLogin();

    await userEvent.click(await screen.findByRole("button", { name: "Recibir enlace por correo" }));

    expect(await screen.findByText("Correo electrónico inválido.")).toBeInTheDocument();
  });

  it("shows the rate-limit message when magic links are throttled", async () => {
    server.use(contractRoute("post", "/auth/magic-link/request", magicLinkRequestInputSchema, () => apiError("RATE_LIMITED")));
    renderLogin();

    await userEvent.type(await screen.findByLabelText("Correo electrónico"), "tia@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Recibir enlace por correo" }));

    expect(await screen.findByText(RATE_LIMITED_MESSAGE)).toBeInTheDocument();
  });

  it("links to password recovery", async () => {
    renderLogin();

    expect(await screen.findByRole("link", { name: "¿Olvidaste tu contraseña?" })).toHaveAttribute("href", "/recuperar");
  });

  it("toggles the password visibility with a Mostrar/Ocultar label", async () => {
    renderLogin();
    const input = await screen.findByLabelText("Contraseña");
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveAttribute("autocomplete", "current-password");

    await userEvent.click(screen.getByRole("button", { name: "Mostrar contraseña" }));
    expect(input).toHaveAttribute("type", "text");

    await userEvent.click(screen.getByRole("button", { name: "Ocultar contraseña" }));
    expect(input).toHaveAttribute("type", "password");
  });

  it("hides a revealed password again when the form is submitted", async () => {
    server.use(contractRoute("post", "/auth/login", loginInputSchema, () => apiError("INVALID_CREDENTIALS")));
    renderLogin();
    await userEvent.type(await screen.findByLabelText("Correo electrónico"), "prima@example.com");
    await userEvent.type(screen.getByLabelText("Contraseña"), PASSWORD);
    await userEvent.click(screen.getByRole("button", { name: "Mostrar contraseña" }));
    expect(screen.getByLabelText("Contraseña")).toHaveAttribute("type", "text");

    await userEvent.click(screen.getByRole("button", { name: "Entrar" }));

    expect(await screen.findByText(INVALID_CREDENTIALS_MESSAGE)).toBeInTheDocument();
    expect(screen.getByLabelText("Contraseña")).toHaveAttribute("type", "password");
  });

  it("marks the email as the username for password managers", async () => {
    renderLogin();

    expect(await screen.findByLabelText("Correo electrónico")).toHaveAttribute("autocomplete", "username");
  });

  it("does not show the TopNav Entrar button on the login page itself", async () => {
    renderLogin();

    await screen.findByRole("heading", { name: "Entrar" });
    expect(screen.queryByRole("link", { name: "Entrar" })).not.toBeInTheDocument();
  });

  it("sends an already logged-in user to the home page", async () => {
    const { router } = renderApp("/entrar", authenticatedState());

    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });
});
