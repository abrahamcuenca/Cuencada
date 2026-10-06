import { screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { authenticatedState, makeUser } from "../../test/auth";
import { createTestServer } from "../../test/msw";
import { renderApp } from "../../test/renderApp";

// Simulates a banner chunk that cannot load (offline, or a stale tab after a deploy).
vi.mock("../features/auth/components/VerifyEmailBanner", () => {
  throw new Error("Failed to fetch dynamically imported module");
});
// The failure is reported, not thrown; keep the test output quiet.
vi.mock("../shared/lib/reportUnexpected", () => ({ reportUnexpected: vi.fn() }));

const server = createTestServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("AppLayout", () => {
  it("keeps the shell working when the verify-email banner chunk fails to load", async () => {
    renderApp("/", authenticatedState(makeUser({ emailVerified: false })));

    expect(await screen.findByRole("navigation", { name: "Navegación inferior" })).toBeInTheDocument();
    expect(await screen.findByRole("main")).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("region", { name: "Verifica tu correo" })).not.toBeInTheDocument();
    expect(screen.queryByText("Algo salió mal")).not.toBeInTheDocument();
  });
});
