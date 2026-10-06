import type { SessionListItem } from "@cuencada/types";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { apiUrl, authenticatedState } from "../../../../test/auth";
import { renderApp } from "../../../../test/renderApp";
import { RATE_LIMITED_MESSAGE } from "../forms";
import { cancelOnlineLogoutRetry } from "../session";
import { apiError, contractRoute, makeSession, noContent } from "../testing/contractHandlers";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
afterEach(() => {
  server.resetHandlers();
  cancelOnlineLogoutRetry();
});

const WINDOWS_ID = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const ANDROID_ID = "2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a";

/** A tiny in-memory session store behind the contract routes. */
function serveSessions(initial: SessionListItem[]): { revoked: string[] } {
  let sessions = [...initial];
  const revoked: string[] = [];
  server.use(
    contractRoute("get", "/auth/sessions", null, () => Response.json(sessions)),
    contractRoute("delete", "/auth/sessions/:id", null, ({ params }) => {
      const id = String(params.id);
      if (!sessions.some((session) => session.id === id && !session.current)) return apiError("NOT_FOUND");
      revoked.push(id);
      sessions = sessions.filter((session) => session.id !== id);
      return noContent();
    }),
    contractRoute("post", "/auth/sessions/revoke-others", null, () => {
      revoked.push(...sessions.filter((session) => !session.current).map((session) => session.id));
      sessions = sessions.filter((session) => session.current);
      return noContent();
    })
  );
  return { revoked };
}

const SESSIONS: SessionListItem[] = [
  makeSession(),
  makeSession({
    id: WINDOWS_ID,
    current: false,
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36",
    lastUsedAt: new Date(Date.now() - 3 * 24 * 3600_000).toISOString(),
    ipAddress: null
  }),
  makeSession({
    id: ANDROID_ID,
    current: false,
    userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36"
  })
];

describe("SessionsPage", () => {
  it("lists sessions with a device summary, last activity and the current badge", async () => {
    serveSessions(SESSIONS);
    renderApp("/perfil/sesiones", authenticatedState());

    const list = await screen.findByRole("list", { name: "Tus sesiones" });
    const items = await within(list).findAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(within(items[0] ?? list).getByText("iPhone · Safari")).toBeInTheDocument();
    expect(within(items[0] ?? list).getByText("Esta sesión")).toBeInTheDocument();
    expect(within(items[0] ?? list).queryByRole("button")).not.toBeInTheDocument();
    expect(within(items[1] ?? list).getByText("Windows · Chrome")).toBeInTheDocument();
    expect(within(items[1] ?? list).getByText("hace 3 días")).toBeInTheDocument();
    expect(within(items[2] ?? list).getByText("Android · Chrome")).toBeInTheDocument();
    expect(within(items[1] ?? list).getByText(/Último uso/)).toBeInTheDocument();
  });

  it("never shows the IP address", async () => {
    serveSessions(SESSIONS);
    renderApp("/perfil/sesiones", authenticatedState());

    await screen.findByText("iPhone · Safari");
    expect(screen.queryByText(/189\.203\.10\.4/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\bIP\b/)).not.toBeInTheDocument();
  });

  it("revokes one session and refreshes the list", async () => {
    const { revoked } = serveSessions(SESSIONS);
    renderApp("/perfil/sesiones", authenticatedState());

    await userEvent.click(await screen.findByRole("button", { name: "Cerrar la sesión de Windows · Chrome" }));

    await waitFor(() => expect(screen.queryByText("Windows · Chrome")).not.toBeInTheDocument());
    expect(revoked).toEqual([WINDOWS_ID]);
    expect(await screen.findByText("Sesión cerrada.")).toBeInTheDocument();
  });

  it("shows the server message when revoking fails", async () => {
    serveSessions(SESSIONS);
    server.use(contractRoute("delete", "/auth/sessions/:id", null, () => apiError("RATE_LIMITED")));
    renderApp("/perfil/sesiones", authenticatedState());

    await userEvent.click(await screen.findByRole("button", { name: "Cerrar la sesión de Windows · Chrome" }));

    expect(await screen.findByText(RATE_LIMITED_MESSAGE)).toBeInTheDocument();
  });

  it("closes every other session after confirming", async () => {
    const { revoked } = serveSessions(SESSIONS);
    renderApp("/perfil/sesiones", authenticatedState());

    await userEvent.click(await screen.findByRole("button", { name: "Cerrar las demás sesiones" }));
    const dialog = await screen.findByRole("alertdialog", { name: "¿Cerrar las demás sesiones?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Cerrar las demás" }));

    await waitFor(() => expect(within(screen.getByRole("list", { name: "Tus sesiones" })).getAllByRole("listitem")).toHaveLength(1));
    expect(revoked).toEqual([WINDOWS_ID, ANDROID_ID]);
  });

  it("logs out on every device: revokes the others, then logs this one out", async () => {
    const { revoked } = serveSessions(SESSIONS);
    const logout = vi.fn();
    server.use(
      http.post(apiUrl("/auth/logout"), () => {
        logout();
        return new HttpResponse(null, { status: 204 });
      })
    );
    const { store, router } = renderApp("/perfil/sesiones", authenticatedState());

    await userEvent.click(await screen.findByRole("button", { name: "Cerrar sesión en todos los dispositivos" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cerrar sesión en todos" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/entrar"));
    expect(revoked).toEqual([WINDOWS_ID, ANDROID_ID]);
    expect(logout).toHaveBeenCalledTimes(1);
    expect(store.getState().auth.status).toBe("anonymous");
  });

  it("shows a retry state when the list cannot load", async () => {
    server.use(contractRoute("get", "/auth/sessions", null, () => apiError("INTERNAL", "Error interno.")));
    renderApp("/perfil/sesiones", authenticatedState());

    expect(await screen.findByRole("heading", { name: "No pudimos cargar tus sesiones" })).toBeInTheDocument();
    serveSessions(SESSIONS);
    await userEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(await screen.findByText("Windows · Chrome")).toBeInTheDocument();
  });
});
