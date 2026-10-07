import { screen, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { apiUrl, authenticatedState, makeUser, statusState } from "../../../../test/auth";
import { renderApp } from "../../../../test/renderApp";
import { makeMemoriesHome } from "../testing/fixtures";
import { MEMBER_TEASER_TEXT } from "./HomePage";

const server = setupServer(
  http.get(apiUrl("/cuencadas/home"), () => HttpResponse.json(makeMemoriesHome())),
  http.get(apiUrl("/cuencadas"), () => HttpResponse.json([])),
  // Members' extras on Home (announcements, gallery preview): empty answers are enough here.
  http.get(apiUrl("/announcements"), () => HttpResponse.json({ items: [], nextCursor: null })),
  http.get(apiUrl("/cuencadas/2026/media"), () => HttpResponse.json({ items: [], nextCursor: null }))
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const MEMBER_LINKS = [/Álbum vivo/, /Directorio/, /Árbol familiar/];

async function highlights(): Promise<ReturnType<typeof within>> {
  return within(await screen.findByRole("region", { name: "Todo en un solo lugar" }));
}

describe("HomePage · Todo en un solo lugar", () => {
  it("shows anonymous visitors the Programa link and one login teaser instead of the member links", async () => {
    renderApp("/", statusState("anonymous"));

    const section = await highlights();
    expect(section.getByRole("link", { name: /Programa/ })).toHaveAttribute("href", "/cuencada/2026");
    for (const name of MEMBER_LINKS) expect(section.queryByRole("link", { name })).not.toBeInTheDocument();
    expect(section.getByText(MEMBER_TEASER_TEXT)).toBeInTheDocument();
    expect(section.getByRole("link", { name: "Entrar" })).toHaveAttribute("href", "/entrar");
  });

  it.each([
    ["a verified member", makeUser()],
    ["an unverified member", makeUser({ emailVerified: false })],
    ["an admin", makeUser({ role: "admin" })]
  ])("shows %s every highlight and no teaser", async (_label, user) => {
    renderApp("/", authenticatedState(user));

    const section = await highlights();
    expect(section.getByRole("link", { name: /Programa/ })).toHaveAttribute("href", "/cuencada/2026");
    expect(section.getByRole("link", { name: /Álbum vivo/ })).toHaveAttribute("href", "/galeria/2026");
    expect(section.getByRole("link", { name: /Directorio/ })).toHaveAttribute("href", "/directorio");
    expect(section.getByRole("link", { name: /Árbol familiar/ })).toHaveAttribute("href", "/arbol");
    expect(section.queryByText(MEMBER_TEASER_TEXT)).not.toBeInTheDocument();
  });

  it.each(["idle", "restoring"] as const)("shows only the public highlights while the session is %s (no teaser flash)", async (status) => {
    renderApp("/", statusState(status));

    const section = await highlights();
    expect(section.getByRole("link", { name: /Programa/ })).toBeInTheDocument();
    for (const name of MEMBER_LINKS) expect(section.queryByRole("link", { name })).not.toBeInTheDocument();
    expect(section.queryByText(MEMBER_TEASER_TEXT)).not.toBeInTheDocument();
  });

  it("gives the teaser the whole row when there is no edition to link the Programa to", async () => {
    server.use(http.get(apiUrl("/cuencadas/home"), () => HttpResponse.json(makeMemoriesHome({ latestPast: null }))));
    renderApp("/", statusState("anonymous"));

    const section = await highlights();
    expect(section.queryByRole("link", { name: /Programa/ })).not.toBeInTheDocument();
    expect(section.getByText(MEMBER_TEASER_TEXT)).toBeInTheDocument();
  });
});
