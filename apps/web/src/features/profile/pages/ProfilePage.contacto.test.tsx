/** WP-4.7: `/perfil#contacto` lands on the Contacto section (scroll + heading focus). */
import { act, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { authenticatedState } from "../../../../test/auth";
import { createTestServer } from "../../../../test/msw";
import { renderApp } from "../../../../test/renderApp";

const server = createTestServer();
let scrolled: Element[] = [];

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  scrolled = [];
  // jsdom has no scrollIntoView: record which element asked to be shown.
  Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
    scrolled.push(this);
  });
});
afterEach(() => {
  server.resetHandlers();
  // biome-ignore lint/performance/noDelete: restores jsdom's original (absent) method.
  delete (Element.prototype as Partial<Element>).scrollIntoView;
});

const contactHeading = (): Promise<HTMLElement> => screen.findByRole("heading", { level: 2, name: "Contacto" });

describe("ProfilePage #contacto", () => {
  it("scrolls to the Contacto section and focuses its heading once the profile loads", async () => {
    renderApp("/perfil#contacto", authenticatedState());

    const heading = await contactHeading();
    await waitFor(() => expect(heading).toHaveFocus());
    expect(scrolled).toEqual([document.getElementById("contacto")]);
    expect(document.getElementById("contacto")).toContainElement(heading);
  });

  it("scrolls again when the Contacto link is followed while already on /perfil", async () => {
    const { router } = renderApp("/perfil", authenticatedState());
    const heading = await contactHeading();
    expect(scrolled).toEqual([]);
    expect(heading).not.toHaveFocus();

    await act(() => router.navigate("/perfil#contacto"));
    await waitFor(() => expect(heading).toHaveFocus());
    expect(scrolled).toHaveLength(1);
  });

  it("ignores fragments that are not a profile section", async () => {
    renderApp("/perfil#sesiones%", authenticatedState());

    const heading = await contactHeading();
    expect(scrolled).toEqual([]);
    expect(heading).not.toHaveFocus();
  });
});
