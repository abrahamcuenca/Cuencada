import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { apiUrl, authenticatedState } from "../../test/auth";
import { createTestServer } from "../../test/msw";
import { renderApp } from "../../test/renderApp";
import { cancelOnlineLogoutRetry } from "../features/auth/session";
import { LOGOUT_NAVIGATION_TIMEOUT_MS } from "./MorePage";

// The Home chunk never loads, so the navigation to "/" never commits.
vi.mock("../features/cuencadas/pages/HomePage", () => new Promise(() => {}));

const server = createTestServer(http.post(apiUrl("/auth/logout"), () => new HttpResponse(null, { status: 204 })));
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
afterEach(() => {
  server.resetHandlers();
  cancelOnlineLogoutRetry();
});

describe("MorePage", () => {
  it("logs out even when the navigation home never commits, and disables the button meanwhile", async () => {
    const { store } = renderApp("/mas", authenticatedState());

    const button = await screen.findByRole("button", { name: "Cerrar sesión" });
    await userEvent.click(button);

    await waitFor(() => expect(button).toBeDisabled());
    expect(store.getState().auth.status).toBe("authenticated");
    await waitFor(() => expect(store.getState().auth.status).toBe("anonymous"), { timeout: LOGOUT_NAVIGATION_TIMEOUT_MS + 2000 });
  });
});
