import { screen } from "@testing-library/react";
import { http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { apiUrl, statusState } from "../../../test/auth";
import { renderApp } from "../../../test/renderApp";
import { clearFragmentToken } from "../../shared/lib/fragmentToken";
import { FRAGMENT_TOKEN as TOKEN } from "./testing/contractHandlers";
import { createTestServer } from "../../../test/msw";

// Token-consuming POSTs stay pending: these tests only check the URL scrubbing.
const pending = (): Promise<Response> => new Promise<Response>(() => {});
const server = createTestServer(
  http.post(apiUrl("/auth/magic-link/consume"), pending),
  http.post(apiUrl("/invites/inspect"), pending),
  http.post(apiUrl("/auth/email/verify"), pending)
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
afterEach(() => {
  server.resetHandlers();
  clearFragmentToken();
  window.history.replaceState(null, "", "/");
});

describe("fragment-token pages", () => {
  it.each([
    ["/entrar/enlace", "Entrar a la Cuencada"],
    ["/invitacion", "Te invitaron a la Cuencada"],
    ["/restablecer", "Nueva contraseña"],
    ["/verificar", "Verificar correo"]
  ])("scrub the token from the address bar when %s loads", async (path, heading) => {
    window.history.replaceState(null, "", `${path}#t=${TOKEN}`);

    renderApp(path, statusState("anonymous"));

    expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
    expect(screen.queryByText(/no es válido/)).not.toBeInTheDocument();
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(TOKEN);
  });

  it("removes the hash from the router location after an in-app navigation that carried it", async () => {
    window.history.replaceState(null, "", `/invitacion#t=${TOKEN}`);

    const { router } = renderApp(`/invitacion#t=${TOKEN}`, statusState("anonymous"));

    await screen.findByRole("heading", { name: "Te invitaron a la Cuencada" });
    await vi.waitFor(() => expect(router.state.location.hash).toBe(""));
    expect(router.state.location.pathname).toBe("/invitacion");
  });

  it("tells the user the link is invalid when /verificar has no token", async () => {
    window.history.replaceState(null, "", "/verificar");

    renderApp("/verificar", statusState("anonymous"));

    expect(await screen.findByText(/no es válido o está incompleto/)).toBeInTheDocument();
  });
});
