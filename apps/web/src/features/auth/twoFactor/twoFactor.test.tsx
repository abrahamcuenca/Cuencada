import {
  loginInputSchema,
  type TrustedDevice,
  type TwoFactorChallenge,
  type TwoFactorStatus,
  twoFactorEnableInputSchema,
  twoFactorSetupInputSchema,
  twoFactorVerifyInputSchema
} from "@cuencada/types";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { authenticatedState, makeUser, statusState, tokenBody } from "../../../../test/auth";
import { createTestServer } from "../../../../test/msw";
import { renderApp, warmRoutes } from "../../../../test/renderApp";
import { authReducer, credentialsReceived, initialAuthState, twoFactorSetupRequired } from "../authSlice";
import { apiError, contractRoute, makeSession, noContent, tokenResponse } from "../testing/contractHandlers";
import { recoveryCodesText } from "./RecoveryCodesPanel";

const server = createTestServer();
beforeAll(async () => {
  server.listen({ onUnhandledRequest: "error" });
  await warmRoutes("/entrar", "/activar-verificacion", "/perfil/sesiones");
}, 60_000);
afterAll(() => server.close());
afterEach(() => server.resetHandlers());

const CHALLENGE_TOKEN = "Ch4llenge".repeat(5);
const PASSWORD = "una frase muy larga";

function challenge(overrides: Partial<TwoFactorChallenge> = {}): TwoFactorChallenge {
  return {
    twoFactorRequired: true,
    challengeToken: CHALLENGE_TOKEN,
    trustDeviceAllowed: true,
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    ...overrides
  };
}

function status(overrides: Partial<TwoFactorStatus> = {}): TwoFactorStatus {
  return {
    enabled: false,
    enabledAt: null,
    required: false,
    recoveryCodesRemaining: 0,
    sessionVerified: false,
    trustDeviceAllowed: true,
    ...overrides
  };
}

async function submitLogin(): Promise<void> {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText("Correo electrónico"), "prima@example.com");
  await user.type(screen.getByLabelText("Contraseña"), PASSWORD);
  await user.click(screen.getByRole("button", { name: "Entrar" }));
}

describe("login code step", () => {
  it("asks for the 6-digit code, trusts the device on request and keeps the challenge out of the store and URL", async () => {
    const verify = vi.fn();
    server.use(
      contractRoute("post", "/auth/login", loginInputSchema, () => HttpResponse.json(challenge())),
      contractRoute("post", "/auth/2fa/verify", twoFactorVerifyInputSchema, ({ body }) => {
        verify(body);
        return tokenResponse(makeUser({ twoFactorEnabled: true }), "token-2fa");
      })
    );
    const { store, router } = renderApp("/entrar", statusState("anonymous"));
    await submitLogin();

    const input = await screen.findByLabelText(/Código de 6 números/);
    expect(input).toHaveAttribute("autocomplete", "one-time-code");
    expect(input).toHaveAttribute("inputmode", "numeric");
    expect(JSON.stringify(store.getState())).not.toContain(CHALLENGE_TOKEN);
    expect(router.state.location.search + router.state.location.hash).not.toContain(CHALLENGE_TOKEN);

    const user = userEvent.setup();
    await user.type(input, "123 456");
    await user.click(screen.getByLabelText("Confiar en este dispositivo 30 días"));
    await user.click(screen.getByRole("button", { name: "Verificar" }));

    await waitFor(() => expect(store.getState().auth.accessToken).toBe("token-2fa"));
    expect(verify).toHaveBeenCalledWith({ challengeToken: CHALLENGE_TOKEN, code: "123456", trustDevice: true });
    expect(JSON.stringify(store.getState())).not.toContain(CHALLENGE_TOKEN);
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("hides 'Confiar en este dispositivo' for administrators and accepts a recovery code", async () => {
    const verify = vi.fn();
    server.use(
      contractRoute("post", "/auth/login", loginInputSchema, () => HttpResponse.json(challenge({ trustDeviceAllowed: false }))),
      contractRoute("post", "/auth/2fa/verify", twoFactorVerifyInputSchema, ({ body }) => {
        verify(body);
        return tokenResponse(makeUser({ role: "admin", twoFactorEnabled: true }));
      })
    );
    renderApp("/entrar", statusState("anonymous"));
    await submitLogin();
    await screen.findByLabelText(/Código de 6 números/);
    expect(screen.queryByLabelText("Confiar en este dispositivo 30 días")).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Usar un código de recuperación" }));
    await user.type(screen.getByLabelText(/Código de recuperación/), "ABCD-EFGH-IJKL-MNOP");
    await user.click(screen.getByRole("button", { name: "Verificar" }));
    await waitFor(() =>
      expect(verify).toHaveBeenCalledWith({ challengeToken: CHALLENGE_TOKEN, recoveryCode: "abcdefghijklmnop", trustDevice: false })
    );
  });

  it("shows a generic message for a wrong code and starts over when the challenge is gone", async () => {
    let calls = 0;
    server.use(
      contractRoute("post", "/auth/login", loginInputSchema, () => HttpResponse.json(challenge())),
      contractRoute("post", "/auth/2fa/verify", twoFactorVerifyInputSchema, () => {
        calls += 1;
        return calls === 1 ? apiError("TWO_FACTOR_INVALID") : apiError("TOKEN_INVALID");
      })
    );
    renderApp("/entrar", statusState("anonymous"));
    await submitLogin();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/Código de 6 números/), "000000");
    await user.click(screen.getByRole("button", { name: "Verificar" }));
    expect(await screen.findByText("El código no es válido. Revisa tu app e inténtalo de nuevo.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Verificar" }));
    await user.click(await screen.findByRole("button", { name: "Volver a iniciar sesión" }));
    expect(await screen.findByLabelText("Correo electrónico")).toBeInTheDocument();
  });
});

describe("administrator enrollment gate", () => {
  it("sends an admin who must enroll to /activar-verificacion, then walks the wizard to the recovery codes", async () => {
    const admin = makeUser({ role: "admin", twoFactorEnabled: false, twoFactorSetupRequired: true });
    const codes = Array.from({ length: 10 }, (_, index) => `aaaa-bbbb-cccc-dd${String.fromCharCode(97 + index)}a`);
    server.use(
      contractRoute("get", "/auth/2fa/status", null, () => HttpResponse.json(status({ required: true, trustDeviceAllowed: false }))),
      contractRoute("post", "/auth/2fa/setup", twoFactorSetupInputSchema, () =>
        HttpResponse.json({
          otpauthUri: "otpauth://totp/Cuencada:prima%40example.com?secret=ABCDEFGH&issuer=Cuencada",
          qrSvgDataUri: "data:image/svg+xml;base64,PHN2Zy8+",
          manualKey: "ABCD EFGH",
          issuer: "Cuencada",
          accountName: "prima@example.com"
        })
      ),
      contractRoute("post", "/auth/2fa/enable", twoFactorEnableInputSchema, () =>
        HttpResponse.json({
          ...tokenBody("token-enrolled", { ...admin, twoFactorEnabled: true, twoFactorSetupRequired: false }),
          recoveryCodes: codes
        })
      ),
      contractRoute("get", "/admin/summary", null, () => apiError("FORBIDDEN"))
    );
    const { store, router } = renderApp("/admin", authenticatedState(admin));

    await waitFor(() => expect(router.state.location.pathname).toBe("/activar-verificacion"));
    expect(await screen.findByText(/Por seguridad, los administradores deben activar la verificación en dos pasos/)).toBeInTheDocument();

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Contraseña actual"), PASSWORD);
    await user.click(screen.getByRole("button", { name: "Continuar" }));
    const qr = await screen.findByRole("img", { name: /Código QR/ });
    expect(qr.getAttribute("src")?.startsWith("data:image/svg+xml")).toBe(true);
    expect(screen.getByText("ABCD EFGH")).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Código de 6 números/), "123456");
    await user.click(screen.getByRole("button", { name: "Activar" }));

    const list = await screen.findByRole("list", { name: "Códigos de recuperación" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(10);
    expect(store.getState().auth.accessToken).toBe("token-enrolled");
    expect(store.getState().auth.twoFactorSetupRequired).toBe(false);
    // The codes and the secret never reach the store.
    expect(JSON.stringify(store.getState())).not.toContain(codes[0]);
    expect(JSON.stringify(store.getState())).not.toContain("ABCDEFGH");

    await user.click(screen.getByRole("button", { name: "Ya los guardé" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/admin"));
  });

  it("flags the session on a 403 TWO_FACTOR_SETUP_REQUIRED and clears it with new credentials", () => {
    let state = authReducer({ ...initialAuthState, status: "authenticated" }, twoFactorSetupRequired());
    expect(state.twoFactorSetupRequired).toBe(true);
    state = authReducer(state, credentialsReceived({ accessToken: "t", user: makeUser({ role: "admin", twoFactorSetupRequired: false }) }));
    expect(state.twoFactorSetupRequired).toBe(false);
    // Ignored without a session.
    expect(authReducer(initialAuthState, twoFactorSetupRequired()).twoFactorSetupRequired).toBe(false);
  });
});

describe("Sesiones y seguridad: verificación en dos pasos", () => {
  function serveSessions(): void {
    server.use(contractRoute("get", "/auth/sessions", null, () => HttpResponse.json([makeSession()])));
  }

  it("offers 'Activar' when it is off", async () => {
    serveSessions();
    server.use(contractRoute("get", "/auth/2fa/status", null, () => HttpResponse.json(status())));
    renderApp("/perfil/sesiones", authenticatedState());
    expect(await screen.findByRole("heading", { name: "Verificación en dos pasos" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Activar" })).toBeInTheDocument();
  });

  it("explains why an administrator cannot disable it and hides trusted devices", async () => {
    serveSessions();
    server.use(
      contractRoute("get", "/auth/2fa/status", null, () =>
        HttpResponse.json(
          status({ enabled: true, enabledAt: "2026-10-01T12:00:00Z", required: true, recoveryCodesRemaining: 9, sessionVerified: true, trustDeviceAllowed: false })
        )
      )
    );
    renderApp("/perfil/sesiones", authenticatedState(makeUser({ role: "admin", twoFactorEnabled: true })));
    expect(await screen.findByText(/Los administradores no pueden desactivarla/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Desactivar" })).not.toBeInTheDocument();
    expect(screen.getByText(/Te quedan 9 códigos de recuperación/)).toBeInTheDocument();
    expect(screen.queryByText("Dispositivos de confianza")).not.toBeInTheDocument();
  });

  it("lists a member's trusted devices and removes one", async () => {
    const device: TrustedDevice = {
      id: "3e4f5a6b-7c8d-4e9f-8a0b-1c2d3e4f5a6b",
      label: "iPhone · Safari",
      createdAt: "2026-10-01T12:00:00Z",
      lastUsedAt: "2026-10-02T12:00:00Z",
      expiresAt: "2026-10-31T12:00:00Z",
      current: true
    };
    const removed = vi.fn();
    serveSessions();
    server.use(
      contractRoute("get", "/auth/2fa/status", null, () =>
        HttpResponse.json(status({ enabled: true, enabledAt: "2026-10-01T12:00:00Z", recoveryCodesRemaining: 10, sessionVerified: true }))
      ),
      contractRoute("get", "/auth/2fa/trusted-devices", null, () => HttpResponse.json([device])),
      contractRoute("delete", "/auth/2fa/trusted-devices/:id", null, ({ params }) => {
        removed(params.id);
        return noContent();
      })
    );
    renderApp("/perfil/sesiones", authenticatedState(makeUser({ twoFactorEnabled: true })));
    const list = await screen.findByRole("list", { name: "Dispositivos de confianza" });
    expect(within(list).getByText("Este navegador")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Desactivar" })).toBeInTheDocument();
    await userEvent.setup().click(within(list).getByRole("button", { name: "Quitar iPhone · Safari" }));
    await waitFor(() => expect(removed).toHaveBeenCalledWith(device.id));
  });
});

describe("recoveryCodesText", () => {
  it("writes Spanish instructions and one code per line", () => {
    const text = recoveryCodesText(["aaaa-bbbb-cccc-dddd", "eeee-ffff-gggg-hhhh"]);
    expect(text).toContain("Cada código sirve una sola vez");
    expect(text.split("\n")).toContain("eeee-ffff-gggg-hhhh");
  });
});
