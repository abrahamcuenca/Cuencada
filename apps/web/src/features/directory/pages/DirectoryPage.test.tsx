import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { apiUrl, authenticatedState, makeUser } from "../../../../test/auth";
import { createTestServer } from "../../../../test/msw";
import { renderApp } from "../../../../test/renderApp";
import { resetResendCooldown } from "../../auth/components/VerifyEmailBanner";
import { DIRECTORY_PAGE_SIZE } from "../api";
import { OWN_PROFILE_BANNER_TEXT } from "./DirectoryPage";
import { directoryHandlers, type FakeDirectoryDb, makeDirectoryDb, makeEntry, memberId, SAMPLE_CARD } from "../testUtils";

const server = createTestServer();
let db: FakeDirectoryDb;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  db = makeDirectoryDb([
    makeEntry(1, { fullName: "Rosa Elena Ejemplo", city: "Mérida", phone: "+52 555 010 0101", email: "rosa@example.com" }),
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

  it("reloads page 1 when Cargar más gets a 400 for a stale cursor (e.g. after hiding myself)", async () => {
    db.entries = Array.from({ length: DIRECTORY_PAGE_SIZE + 2 }, (_, index) => makeEntry(index + 1));
    const user = userEvent.setup();
    renderApp("/directorio", authenticatedState());

    await screen.findByRole("link", { name: /Primo 1 Ejemplo/ });
    // I unlisted myself meanwhile: the server refuses the old cursor once.
    db.entries = db.entries.slice(1);
    db.staleCursorOnce = true;
    await user.click(screen.getByRole("button", { name: "Cargar más" }));

    await waitFor(() =>
      expect(db.log).toEqual([`limit=${DIRECTORY_PAGE_SIZE}`, `limit=${DIRECTORY_PAGE_SIZE}&cursor=${DIRECTORY_PAGE_SIZE}`, `limit=${DIRECTORY_PAGE_SIZE}`])
    );
    await waitFor(() => expect(screen.queryByRole("link", { name: /Primo 1 Ejemplo/ })).not.toBeInTheDocument());
    expect(within(list()).getAllByRole("link")).toHaveLength(DIRECTORY_PAGE_SIZE);
    // The fresh first page has a valid cursor again.
    await user.click(screen.getByRole("button", { name: "Cargar más" }));
    await waitFor(() => expect(within(list()).getAllByRole("link")).toHaveLength(DIRECTORY_PAGE_SIZE + 1));
  });

  it("suggests cities from the loaded rows by prefix, ignoring accents", async () => {
    db.entries = [
      makeEntry(1, { fullName: "Rosa Elena Ejemplo", city: "Mérida" }),
      makeEntry(2, { fullName: "Tomás Ejemplo", city: "Monterrey" }),
      makeEntry(3, { fullName: "Lía Ejemplo", city: "Oaxaca" })
    ];
    const user = userEvent.setup();
    renderApp("/directorio", authenticatedState());

    await screen.findByRole("link", { name: /Rosa Elena Ejemplo/ });
    await user.click(screen.getByRole("button", { name: "Filtros" }));
    const sheet = await screen.findByRole("dialog", { name: "Filtros" });
    const city = within(sheet).getByLabelText(/Ciudad/);
    await user.type(city, "me");

    const options = (): string[] => Array.from(document.querySelectorAll("[data-testid='city-suggestions'] option")).map((option) => option.getAttribute("value") ?? "");
    expect(options()).toEqual(["Mérida"]);
    expect(city).toHaveAttribute("list");
    await user.clear(city);
    await user.type(city, "m");
    expect(options()).toEqual(["Mérida", "Monterrey"]);
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

  it("treats EMAIL_UNVERIFIED as unverified whatever the cached user says", async () => {
    server.use(
      http.get(apiUrl("/directory"), () => HttpResponse.json({ error: { code: "EMAIL_UNVERIFIED", message: "Verifica tu correo." } }, { status: 403 }))
    );
    renderApp("/directorio", authenticatedState());

    expect(await screen.findByRole("heading", { name: "Verifica tu correo para ver el directorio" })).toBeInTheDocument();
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
    // The buttons show the actual number.
    expect(within(card).getByRole("link", { name: /WhatsApp \+52 555 010 0101/ })).toHaveAttribute("href", "https://wa.me/525550100101");
    expect(within(card).getByRole("link", { name: /WhatsApp/ })).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(within(card).getByRole("link", { name: /Llamar al \+52 555 010 0101/ })).toHaveAttribute("href", "tel:+525550100101");
    expect(within(card).getByRole("link", { name: /Correo/ })).toHaveAttribute("href", "mailto:rosa@example.com");
  });

  it("never guesses a country code: a 10-digit number gets Llamar but no WhatsApp link", async () => {
    db.entries = [makeEntry(5, { fullName: "Iván Ejemplo", phone: "555 010 0101" })];
    renderApp(`/directorio/${memberId(5)}`, authenticatedState());

    const card = await screen.findByRole("article", { name: "Iván Ejemplo" });
    expect(within(card).getByRole("link", { name: /Llamar al 555 010 0101/ })).toHaveAttribute("href", "tel:5550100101");
    expect(within(card).queryByRole("link", { name: /WhatsApp/ })).not.toBeInTheDocument();
    expect(card.querySelector('a[href*="wa.me"]')).toBeNull();
    expect(within(card).getByText(/no tiene código de país/)).toBeInTheDocument();
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

describe("DirectoryPage contacts (WP-4.4)", () => {
  it("shows tappable contact chips under a member in the list, as separate links from the card", async () => {
    db.entries = [makeEntry(6, { fullName: "Rosa Contactos Ejemplo", displayName: "Rosa", contacts: SAMPLE_CARD }), makeEntry(7, { contacts: [] })];
    renderApp("/directorio", authenticatedState());

    const card = await screen.findByRole("link", { name: /^Rosa Contactos Ejemplo/ });
    expect(card).toHaveAttribute("href", `/directorio/${memberId(6)}`);
    const chips = screen.getByRole("list", { name: "Contacto de Rosa Contactos Ejemplo" });
    expect(within(chips).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
      "tel:+525550100101",
      "https://wa.me/525550100101",
      "https://instagram.com/rosa.ejemplo"
    ]);
    // A member with an empty card gets no chip row.
    expect(screen.getAllByRole("list", { name: /^Contacto de/ })).toHaveLength(1);
  });

  it("lists every visible contact in the detail with the server's display text, and no legacy buttons", async () => {
    db.entries = [makeEntry(8, { fullName: "Rosa Contactos Ejemplo", displayName: "Rosa", phone: "+525550100101", contacts: SAMPLE_CARD })];
    renderApp(`/directorio/${memberId(8)}`, authenticatedState());

    const card = await screen.findByRole("article", { name: "Rosa Contactos Ejemplo" });
    const contacts = within(card).getByRole("list", { name: "Contacto de Rosa" });
    expect(within(contacts).getAllByRole("link")).toHaveLength(3);
    expect(within(contacts).getByRole("link", { name: /Instagram.*@rosa\.ejemplo/ })).toHaveAttribute("rel", "noopener noreferrer nofollow");
    expect(within(card).queryByRole("link", { name: /Llamar al/ })).not.toBeInTheDocument();
  });

  it("says when the member shares no contact", async () => {
    db.entries = [makeEntry(9, { fullName: "Sin Contacto Ejemplo", contacts: [] })];
    renderApp(`/directorio/${memberId(9)}`, authenticatedState());

    const card = await screen.findByRole("article", { name: "Sin Contacto Ejemplo" });
    expect(within(card).getByText("No comparte datos de contacto.")).toBeInTheDocument();
    expect(card.querySelector('a[href^="tel:"], a[href^="mailto:"], a[href^="https:"]')).toBeNull();
  });
});

describe("DirectoryPage own profile links (WP-4.7)", () => {
  const me = makeUser();
  const myEntry = (): ReturnType<typeof makeEntry> => ({ ...makeEntry(9, { fullName: "Prima Morales Ejemplo" }), userId: me.id });

  it("shows an Editar mi perfil banner above the search", async () => {
    renderApp("/directorio", authenticatedState(me));

    await screen.findByRole("link", { name: /Rosa Elena Ejemplo/ });
    expect(screen.getByText(OWN_PROFILE_BANNER_TEXT)).toBeInTheDocument();
    expect(within(screen.getByRole("main")).getByRole("link", { name: /Editar mi perfil/ })).toHaveAttribute("href", "/perfil");
  });

  it("marks the member's own row with (tú) and no one else's", async () => {
    db.entries = [...db.entries, myEntry()];
    renderApp("/directorio", authenticatedState(me));

    expect(await screen.findByRole("link", { name: /Prima Morales Ejemplo \(tú\)/ })).toHaveAttribute("href", `/directorio/${me.id}`);
    expect(within(list()).getByRole("link", { name: /Rosa Elena Ejemplo/ })).not.toHaveTextContent("(tú)");
  });

  it("offers Editar mi perfil on the member's own card", async () => {
    db.entries = [...db.entries, myEntry()];
    renderApp(`/directorio/${me.id}`, authenticatedState(me));

    const card = await screen.findByRole("article", { name: "Prima Morales Ejemplo" });
    expect(within(card).getByRole("link", { name: /Editar mi perfil/ })).toHaveAttribute("href", "/perfil");
  });

  it("has no Editar mi perfil on someone else's card", async () => {
    renderApp(`/directorio/${memberId(1)}`, authenticatedState(me));

    const card = await screen.findByRole("article", { name: "Rosa Elena Ejemplo" });
    expect(within(card).queryByRole("link", { name: /Editar mi perfil/ })).not.toBeInTheDocument();
  });
});
