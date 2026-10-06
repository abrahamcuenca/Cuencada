import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { apiUrl, authenticatedState, makeUser } from "../../../../test/auth";
import { createTestServer } from "../../../../test/msw";
import { renderApp } from "../../../../test/renderApp";
import { resetResendCooldown } from "../../auth/components/VerifyEmailBanner";
import { DIRECTORY_PAGE_SIZE } from "../api";
import { directoryHandlers, type FakeDirectoryDb, makeDirectoryDb, makeEntry, memberId } from "../testUtils";

const server = createTestServer();
let db: FakeDirectoryDb;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  db = makeDirectoryDb([
    makeEntry(1, { fullName: "Rosa Elena Ejemplo", city: "Mérida", phone: "555 010 0101", email: "rosa@example.com" }),
    makeEntry(2, { fullName: "Tomás Ejemplo", familyBranch: "Rama Sur", city: "Monterrey" }),
    makeEntry(3, { fullName: "Rosario Ejemplo" })
  ]);
  server.use(...directoryHandlers(db));
  resetResendCooldown();
});
afterEach(() => server.resetHandlers());

const list = (): HTMLElement => screen.getByRole("list", { name: "Familiares" });

describe("DirectoryPage list", () => {
  it("shows a card per member with name, branch and the city only when visible", async () => {
    renderApp("/directorio", authenticatedState());

    const rosa = await screen.findByRole("link", { name: /Rosa Elena Ejemplo/ });
    expect(rosa).toHaveAttribute("href", `/directorio/${memberId(1)}`);
    expect(rosa).toHaveTextContent("Mérida · Rama Norte");
    expect(within(list()).getByRole("link", { name: /Rosario Ejemplo/ })).toHaveTextContent(/^RERosario EjemploRama Norte›$/);
    expect(db.log).toEqual([`limit=${DIRECTORY_PAGE_SIZE}`]);
  });

  it("debounces the search and sends it only from two characters", async () => {
    const user = userEvent.setup();
    renderApp("/directorio", authenticatedState());
    await screen.findByRole("link", { name: /Tomás Ejemplo/ });
    const search = screen.getByRole("searchbox", { name: "Buscar por nombre o ciudad" });
    expect(search).toHaveAttribute("inputmode", "search");

    await user.type(search, "R");
    expect(await screen.findByText("Escribe al menos 2 letras para buscar.")).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(db.log).toEqual([`limit=${DIRECTORY_PAGE_SIZE}`]);

    await user.type(search, "osa");
    await waitFor(() => expect(screen.queryByRole("link", { name: /Tomás Ejemplo/ })).not.toBeInTheDocument());
    expect(screen.getByRole("link", { name: /Rosa Elena Ejemplo/ })).toBeInTheDocument();
    expect(db.log).toEqual([`limit=${DIRECTORY_PAGE_SIZE}`, `q=Rosa&limit=${DIRECTORY_PAGE_SIZE}`]);
  });

  it("waits 300 ms after the last keystroke", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderApp("/directorio", authenticatedState());
      await screen.findByRole("link", { name: /Tomás Ejemplo/ });

      await user.type(screen.getByRole("searchbox"), "To");
      vi.advanceTimersByTime(299);
      expect(db.log).toHaveLength(1);
      vi.advanceTimersByTime(1);
      await waitFor(() => expect(db.log).toEqual([`limit=${DIRECTORY_PAGE_SIZE}`, `q=To&limit=${DIRECTORY_PAGE_SIZE}`]));
    } finally {
      vi.useRealTimers();
    }
  });

  it("loads the next page by cursor and appends it", async () => {
    db.entries = Array.from({ length: DIRECTORY_PAGE_SIZE + 2 }, (_, index) => makeEntry(index + 1));
    const user = userEvent.setup();
    renderApp("/directorio", authenticatedState());

    await screen.findByRole("link", { name: /Primo 1 Ejemplo/ });
    expect(within(list()).getAllByRole("link")).toHaveLength(DIRECTORY_PAGE_SIZE);
    await user.click(screen.getByRole("button", { name: "Cargar más" }));

    await waitFor(() => expect(within(list()).getAllByRole("link")).toHaveLength(DIRECTORY_PAGE_SIZE + 2));
    expect(db.log).toEqual([`limit=${DIRECTORY_PAGE_SIZE}`, `limit=${DIRECTORY_PAGE_SIZE}&cursor=${DIRECTORY_PAGE_SIZE}`]);
    expect(screen.queryByRole("button", { name: "Cargar más" })).not.toBeInTheDocument();
  });

  it("sends the branch and city filters to the server", async () => {
    const user = userEvent.setup();
    renderApp("/directorio", authenticatedState());
    await screen.findByRole("link", { name: /Tomás Ejemplo/ });

    await user.click(screen.getByRole("button", { name: "Filtros" }));
    const sheet = await screen.findByRole("dialog", { name: "Filtros" });
    await user.type(within(sheet).getByLabelText(/Ciudad/), "Mérida");
    await user.click(within(sheet).getByRole("button", { name: "Ver resultados" }));

    await waitFor(() => expect(db.log).toContain(`city=M%C3%A9rida&limit=${DIRECTORY_PAGE_SIZE}`));

    await waitFor(() => expect(within(list()).getAllByRole("link")).toHaveLength(1));
    expect(within(list()).getByRole("link", { name: /Rosa Elena Ejemplo/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Filtros (1)" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Filtros (1)" }));
    const again = await screen.findByRole("dialog", { name: "Filtros" });
    await user.clear(within(again).getByLabelText(/Ciudad/));
    await user.type(within(again).getByLabelText(/Rama familiar/), "Rama Sur");
    await user.click(within(again).getByRole("button", { name: "Ver resultados" }));

    await waitFor(() => expect(db.log).toContain(`familyBranch=Rama+Sur&limit=${DIRECTORY_PAGE_SIZE}`));
    expect(await within(list()).findByRole("link", { name: /Tomás Ejemplo/ })).toBeInTheDocument();
    expect(within(list()).getAllByRole("link")).toHaveLength(1);
  });

  it("shows the empty search state with a way to clear it", async () => {
    const user = userEvent.setup();
    renderApp("/directorio", authenticatedState());
    await screen.findByRole("link", { name: /Tomás Ejemplo/ });

    await user.type(screen.getByRole("searchbox"), "Zacarías");
    expect(await screen.findByRole("heading", { name: 'No encontramos a nadie con "Zacarías"' })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Quitar filtros" }));

    expect(await screen.findByRole("link", { name: /Tomás Ejemplo/ })).toBeInTheDocument();
    expect(screen.getByRole("searchbox")).toHaveValue("");
  });

  it("offers a retry when the list fails", async () => {
    db.listError = "INTERNAL";
    const user = userEvent.setup();
    renderApp("/directorio", authenticatedState());

    expect(await screen.findByRole("heading", { name: "No pudimos cargar el directorio" })).toBeInTheDocument();
    db.listError = null;
    await user.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(await screen.findByRole("link", { name: /Tomás Ejemplo/ })).toBeInTheDocument();
  });

  it("never writes the directory to web storage", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    try {
      renderApp("/directorio", authenticatedState());
      await screen.findByRole("link", { name: /Rosa Elena Ejemplo/ });

      expect(setItem).not.toHaveBeenCalled();
      expect(window.localStorage.length).toBe(0);
      expect(window.sessionStorage.length).toBe(0);
    } finally {
      setItem.mockRestore();
    }
  });
});

describe("DirectoryPage expired avatar URLs", () => {
  it("refetches the list once when an avatar fails to load", async () => {
    db.entries = [makeEntry(1, { fullName: "Rosa Elena Ejemplo", avatarUrl: "https://bucket.example/a1.webp?X-Amz-Signature=old" })];
    renderApp("/directorio", authenticatedState());

    const link = await screen.findByRole("link", { name: /Rosa Elena Ejemplo/ });
    const img = link.querySelector("img");
    if (!img) throw new Error("missing avatar image");
    fireEvent.error(img);
    await waitFor(() => expect(db.log).toHaveLength(2));
    fireEvent.error(img);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(db.log).toHaveLength(2);
  });
});

describe("DirectoryPage access", () => {
  it("asks an unverified member to verify the email, with the resend action", async () => {
    db.listError = "FORBIDDEN";
    const requests: string[] = [];
    server.use(
      http.post(apiUrl("/auth/email/verify-request"), () => {
        requests.push("verify-request");
        return HttpResponse.json({ ok: true });
      })
    );
    const user = userEvent.setup();
    renderApp("/directorio", authenticatedState(makeUser({ emailVerified: false })));

    expect(await screen.findByRole("heading", { name: "Verifica tu correo para ver el directorio" })).toBeInTheDocument();
    const main = within(screen.getByRole("main"));
    await user.click(main.getByRole("button", { name: "Reenviar enlace" }));
    await waitFor(() => expect(requests).toEqual(["verify-request"]));
  });

  it("asks to verify the email on 403 EMAIL_UNVERIFIED (WP-0.8a server code)", async () => {
    db.listError = "EMAIL_UNVERIFIED";
    renderApp("/directorio", authenticatedState(makeUser({ emailVerified: false })));

    expect(await screen.findByRole("heading", { name: "Verifica tu correo para ver el directorio" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "No tienes acceso al directorio" })).not.toBeInTheDocument();
  });

  it("says access is closed for any other 403", async () => {
    db.listError = "FORBIDDEN";
    renderApp("/directorio", authenticatedState());

    expect(await screen.findByRole("heading", { name: "No tienes acceso al directorio" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Verifica tu correo/ })).not.toBeInTheDocument();
  });
});

describe("DirectoryPage detail", () => {
  it("shows only the fields the member shares, with their contact links", async () => {
    const user = userEvent.setup();
    renderApp("/directorio", authenticatedState());

    await user.click(await screen.findByRole("link", { name: /Rosa Elena Ejemplo/ }));
    const card = await screen.findByRole("article", { name: "Rosa Elena Ejemplo" });

    expect(within(card).getByRole("heading", { name: "Rosa Elena Ejemplo" })).toHaveFocus();
    expect(within(card).getByText("Mérida")).toBeInTheDocument();
    expect(within(card).getByText("rosa@example.com")).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: /WhatsApp/ })).toHaveAttribute("href", "https://wa.me/525550100101");
    expect(within(card).getByRole("link", { name: /WhatsApp/ })).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(within(card).getByRole("link", { name: /Llamar/ })).toHaveAttribute("href", "tel:+525550100101");
    expect(within(card).getByRole("link", { name: /Correo/ })).toHaveAttribute("href", "mailto:rosa@example.com");
  });

  it("shows no contact field or link the member did not share", async () => {
    renderApp(`/directorio/${memberId(3)}`, authenticatedState());

    const card = await screen.findByRole("article", { name: "Rosario Ejemplo" });
    expect(within(card).getByText("Rama Norte")).toBeInTheDocument();
    expect(within(card).queryByText("Ciudad")).not.toBeInTheDocument();
    expect(within(card).queryByText("Teléfono")).not.toBeInTheDocument();
    expect(within(card).queryByText("Correo")).not.toBeInTheDocument();
    expect(within(card).queryByRole("link", { name: /WhatsApp|Llamar|Correo/ })).not.toBeInTheDocument();
    expect(card.querySelector('a[href^="tel:"], a[href^="mailto:"], a[href*="wa.me"]')).toBeNull();
  });

  it("links to the family tree when the member is in it", async () => {
    db.entries = [makeEntry(4, { fullName: "Jorge Ejemplo", personId: "5b000000-0000-4000-8000-000000000004" })];
    renderApp(`/directorio/${memberId(4)}`, authenticatedState());

    const card = await screen.findByRole("article", { name: "Jorge Ejemplo" });
    expect(within(card).getByRole("link", { name: /Ver en el árbol/ })).toHaveAttribute("href", "/arbol/5b000000-0000-4000-8000-000000000004");
  });

  it.each(["..", "no-es-un-uuid", "%2e%2e%2Fadmin"])("shows not found and sends no request for the id %s", async (id) => {
    const requests: string[] = [];
    server.events.on("request:start", ({ request }) => {
      requests.push(new URL(request.url).pathname);
    });
    try {
      renderApp(`/directorio/${id}`, authenticatedState());

      expect(await screen.findByRole("heading", { name: "No encontramos a este familiar" })).toBeInTheDocument();
      await screen.findByRole("link", { name: /Rosa Elena Ejemplo/ });
      expect(requests.filter((path) => path.startsWith("/api/directory/"))).toEqual([]);
    } finally {
      server.events.removeAllListeners();
    }
  });

  it("says when the member is not found", async () => {
    renderApp(`/directorio/${memberId(99)}`, authenticatedState());

    expect(await screen.findByRole("heading", { name: "No encontramos a este familiar" })).toBeInTheDocument();
  });
});
