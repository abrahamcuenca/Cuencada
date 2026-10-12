import { screen, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { apiUrl, authenticatedState } from "../../../../test/auth";
import { createTestServer } from "../../../../test/msw";
import { renderApp, warmRoutes } from "../../../../test/renderApp";
import { makeBox, memoryId } from "../testing/fixtures";

const server = createTestServer();

beforeAll(async () => {
  server.listen({ onUnhandledRequest: "error" });
  await warmRoutes("/");
  await import("./HomeMemories");
}, 30_000);
afterAll(() => server.close());
afterEach(() => server.resetHandlers());

describe("Home's Baúl de recuerdos strip", { timeout: 20_000 }, () => {
  it("shows up to three published boxes and a link to /recuerdos", async () => {
    server.use(http.get(apiUrl("/memories"), () => HttpResponse.json({ items: [1, 2, 3, 4].map((n) => makeBox(n)) })));
    renderApp("/", authenticatedState());
    const strip = await screen.findByRole("region", { name: "Baúl de recuerdos" });
    expect(within(strip).getAllByRole("article")).toHaveLength(3);
    expect(within(strip).getByRole("link", { name: "Ver todos" })).toHaveAttribute("href", "/recuerdos");
    expect(within(strip).getByRole("link", { name: "Fotos antiguas 1" })).toHaveAttribute("href", `/recuerdos/${memoryId(1)}`);
    // Compact cards: no description.
    expect(within(strip).queryByText("Escaneadas por la Rama Norte.")).not.toBeInTheDocument();
  });

  it("renders nothing when there is no published box", async () => {
    renderApp("/", authenticatedState());
    await screen.findByRole("heading", { level: 1 });
    // Let the strip's request settle.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("region", { name: "Baúl de recuerdos" })).not.toBeInTheDocument();
  });

  it("is not requested for signed-out visitors", async () => {
    let calls = 0;
    server.use(
      http.get(apiUrl("/memories"), () => {
        calls += 1;
        return HttpResponse.json({ items: [] });
      })
    );
    renderApp("/");
    await screen.findByRole("heading", { level: 1 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toBe(0);
  });
});
