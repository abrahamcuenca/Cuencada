import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { authenticatedState, makeUser } from "../../../../test/auth";
import { createTestServer } from "../../../../test/msw";
import { renderApp } from "../../../../test/renderApp";
import { resetChatEventsForTests } from "../events";
import { configureChatSocketForTests, resetChatSocketForTests } from "../socket";
import { createFakeSocket, FakeSocket } from "../testing/fakeSocket";
import { type ChatDb, chatHandlers, frames, makeChatDb, makeMessage, makeRooms, ME, PEOPLE, ROOMS } from "../testing/fixtures";

const server = createTestServer();
let db: ChatDb;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  db = makeChatDb();
  server.use(...chatHandlers(db));
  FakeSocket.reset();
  configureChatSocketForTests({ createSocket: createFakeSocket, random: () => 0 });
});
afterEach(() => {
  // Unmount first: a render during teardown would otherwise create a new connection after the reset.
  cleanup();
  resetChatSocketForTests();
  resetChatEventsForTests();
  server.resetHandlers();
  vi.unstubAllGlobals();
});

/** Waits for the page's socket and opens it. */
async function openSocket(): Promise<FakeSocket> {
  await waitFor(() => expect(FakeSocket.instances.length).toBeGreaterThan(0));
  const socket = FakeSocket.latest();
  act(() => socket.open());
  return socket;
}

function log(): HTMLElement {
  return screen.getByRole("log");
}

function sendFrames(socket: FakeSocket): { type: string; clientMessageId?: string; body?: string }[] {
  return socket.frames().filter((frame): frame is { type: string; clientMessageId?: string; body?: string } => {
    return typeof frame === "object" && frame !== null && "type" in frame && frame.type === "send";
  });
}

function stubDesktopPointer(fine: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    (query: string): MediaQueryList =>
      ({
        matches: fine && query.includes("pointer: fine"),
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false
      }) satisfies MediaQueryList
  );
}

describe("ChatPage", { timeout: 20_000 }, () => {
  it("lists the rooms (global first) with unread badges, and badges the Chat tab", async () => {
    renderApp("/chat", authenticatedState());

    const list = await screen.findByRole("list", { name: "Salas" });
    const links = within(list).getAllByRole("link");
    // The global room is pinned first, then the most recent activity.
    expect(links.map((link) => link.querySelector("span span")?.textContent)).toEqual(["Toda la familia", "Cuencada 2025", "Cuencada 2026"]);
    expect(links[0]).toHaveAttribute("href", `/chat/${ROOMS.familia}`);
    expect(within(links[0] as HTMLElement).getByText("3 mensajes sin leer")).toBeInTheDocument();
    expect(within(links[0] as HTMLElement).getByText("Lucía: Mensaje 5")).toBeInTheDocument();
    expect(within(links[1] as HTMLElement).getByText("Marta: ¡Gracias por todo, familia!")).toBeInTheDocument();
    const bottom = screen.getByRole("navigation", { name: "Navegación inferior" });
    await waitFor(() => expect(within(bottom).getByRole("link", { name: /Chat, 3 mensajes sin leer/ })).toBeInTheDocument());
  });

  it("shows 999+ when the server caps the unread count", async () => {
    db.rooms = makeRooms({ familia: { unreadCount: 999 } });
    renderApp("/chat", authenticatedState());
    const room = await screen.findByRole("link", { name: /Toda la familia/ });
    expect(within(room).getByText("999+")).toBeInTheDocument();
    expect(within(room).getByText("Más de 999 mensajes sin leer")).toBeInTheDocument();
  });

  it("updates unread counts, previews and the tab badge from live frames", async () => {
    renderApp("/chat", authenticatedState());
    await screen.findByRole("list", { name: "Salas" });
    const socket = await openSocket();

    act(() => socket.receive(frames.message(makeMessage(40, { roomId: ROOMS.y2026, sender: PEOPLE.tomas, body: "¿Quién trae bloqueador?" }))));

    const room = await screen.findByRole("link", { name: /Cuencada 2026/ });
    expect(within(room).getByText("Tomás: ¿Quién trae bloqueador?")).toBeInTheDocument();
    expect(within(room).getByText("1 mensaje sin leer")).toBeInTheDocument();
    const bottom = screen.getByRole("navigation", { name: "Navegación inferior" });
    await waitFor(() => expect(within(bottom).getByRole("link", { name: /Chat, 4 mensajes sin leer/ })).toBeInTheDocument());

    // My own messages never count as unread.
    act(() => socket.receive(frames.message(makeMessage(41, { roomId: ROOMS.y2026, sender: ME, body: "Yo llevo" }))));
    await waitFor(() => expect(within(room).getByText("Tú: Yo llevo")).toBeInTheDocument());
    expect(within(room).getByText("1 mensaje sin leer")).toBeInTheDocument();
  });

  it("opens a conversation full screen, marks it read and streams new and deleted messages", async () => {
    renderApp(`/chat/${ROOMS.familia}`, authenticatedState());

    expect(await screen.findByText("Mensaje 5")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Toda la familia" })).toBeInTheDocument();
    expect(log()).toHaveAttribute("aria-live", "polite");
    // Full screen on phones: no BottomNav.
    expect(screen.queryByRole("navigation", { name: "Navegación inferior" })).not.toBeInTheDocument();
    await waitFor(() => expect(db.reads).toEqual([{ roomId: ROOMS.familia, messageId: makeMessage(5).id }]));

    const socket = await openSocket();
    act(() => socket.receive(frames.message(makeMessage(6, { sender: PEOPLE.marta, body: "Ya llegamos al hotel" }))));
    expect(await within(log()).findByText("Ya llegamos al hotel")).toBeInTheDocument();
    act(() => socket.receive(frames.message(makeMessage(6, { sender: PEOPLE.marta, body: "Ya llegamos al hotel" }))));
    expect(within(log()).getAllByText("Ya llegamos al hotel")).toHaveLength(1);

    act(() => socket.receive(frames.deleted(ROOMS.familia, makeMessage(6).id)));
    await waitFor(() => expect(within(log()).queryByText("Ya llegamos al hotel")).not.toBeInTheDocument());
    expect(within(log()).getByText("🚫 Mensaje eliminado")).toBeInTheDocument();
    // Frames for other rooms do not leak into this conversation.
    act(() => socket.receive(frames.message(makeMessage(7, { roomId: ROOMS.y2025, body: "Otra sala" }))));
    expect(within(log()).queryByText("Otra sala")).not.toBeInTheDocument();
    // Read again for the newest message, throttled.
    await waitFor(() => expect(db.reads.at(-1)?.messageId).toBe(makeMessage(6).id), { timeout: 5000 });
  });

  it("sends optimistically, dedupes the echo, and retries a failed message with the same id", async () => {
    const user = userEvent.setup();
    renderApp(`/chat/${ROOMS.familia}`, authenticatedState());
    await screen.findByText("Mensaje 5");
    const socket = await openSocket();

    await user.type(screen.getByRole("textbox", { name: "Mensaje" }), "  Hola familia  ");
    await user.click(screen.getByRole("button", { name: "Enviar" }));

    expect(await within(log()).findByText("Hola familia")).toBeInTheDocument();
    expect(within(log()).getByText("Enviando…")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Mensaje" })).toHaveValue("");
    const [sent] = sendFrames(socket);
    expect(sent).toMatchObject({ type: "send", roomId: ROOMS.familia, body: "Hola familia" });
    const clientMessageId = sent?.clientMessageId ?? "";
    expect(clientMessageId).toMatch(/^[0-9a-f-]{36}$/);

    act(() => socket.receive(frames.error(clientMessageId)));
    expect(await within(log()).findByText("⚠️ No se envió")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(sendFrames(socket).map((frame) => frame.clientMessageId)).toEqual([clientMessageId, clientMessageId]);

    act(() => socket.receive(frames.message(makeMessage(8, { sender: ME, body: "Hola familia" }), clientMessageId)));
    await waitFor(() => expect(within(log()).queryByText("Enviando…")).not.toBeInTheDocument());
    expect(within(log()).getAllByText("Hola familia")).toHaveLength(1);
    expect(within(log()).queryByText("⚠️ No se envió")).not.toBeInTheDocument();
  });

  it("queues a message while connecting and sends it when the socket opens", async () => {
    const user = userEvent.setup();
    renderApp(`/chat/${ROOMS.familia}`, authenticatedState());
    await screen.findByText("Mensaje 5");
    expect(await screen.findByText("Conectando…")).toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: "Mensaje" }), "En camino");
    await user.click(screen.getByRole("button", { name: "Enviar" }));
    expect(await within(log()).findByText("Enviando…")).toBeInTheDocument();

    const socket = await openSocket();
    expect(sendFrames(socket)).toEqual([expect.objectContaining({ body: "En camino" })]);
    expect(screen.queryByText("Conectando…")).not.toBeInTheDocument();

    act(() => socket.serverClose(1006));
    expect(await screen.findByText(/Reconectando…/)).toBeInTheDocument();
  });

  it("loads older history with Cargar anteriores until the beginning", async () => {
    db = makeChatDb(120);
    server.use(...chatHandlers(db));
    const user = userEvent.setup();
    renderApp(`/chat/${ROOMS.familia}`, authenticatedState());

    expect(await screen.findByText("Mensaje 120")).toBeInTheDocument();
    expect(screen.getByText("Mensaje 71")).toBeInTheDocument();
    expect(screen.queryByText("Mensaje 70")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cargar anteriores" }));
    expect(await screen.findByText("Mensaje 21")).toBeInTheDocument();
    expect(db.historyRequests.at(-1)).toEqual({ roomId: ROOMS.familia, before: "c:70", limit: 50 });

    await user.click(screen.getByRole("button", { name: "Cargar anteriores" }));
    expect(await screen.findByText("Mensaje 1")).toBeInTheDocument();
    expect(screen.getAllByText(/^Mensaje \d+$/)).toHaveLength(120);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Cargar anteriores" })).not.toBeInTheDocument());
  });

  it("deletes my message after confirming, and only offers delete on others' messages to admins", async () => {
    db.messages.set(ROOMS.familia, [makeMessage(1), makeMessage(2, { sender: ME, body: "Mensaje mío" })]);
    const user = userEvent.setup();
    renderApp(`/chat/${ROOMS.familia}`, authenticatedState());
    await screen.findByText("Mensaje mío");

    expect(screen.queryByRole("button", { name: /Opciones del mensaje de Lucía/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Opciones del mensaje de Tú" }));
    const menu = await screen.findByRole("dialog", { name: "Mensaje" });
    await user.click(within(menu).getByRole("button", { name: "Eliminar" }));
    const confirm = await screen.findByRole("alertdialog", { name: "¿Eliminar este mensaje?" });
    await user.click(within(confirm).getByRole("button", { name: "Eliminar" }));

    await waitFor(() => expect(db.deleted).toEqual([makeMessage(2).id]));
    expect(await within(log()).findByText("🚫 Mensaje eliminado")).toBeInTheDocument();
    expect(within(log()).queryByText("Mensaje mío")).not.toBeInTheDocument();
  });

  it("lets an admin open the delete menu on someone else's message (also by right-click)", async () => {
    const user = userEvent.setup();
    renderApp(`/chat/${ROOMS.familia}`, authenticatedState(makeUser({ role: "admin" })));
    await screen.findByText("Mensaje 5");
    expect(screen.getAllByRole("button", { name: /Opciones del mensaje de Lucía Ramírez Solís/ })).toHaveLength(5);

    fireEvent.contextMenu(screen.getByText("Mensaje 3"));
    const menu = await screen.findByRole("dialog", { name: "Mensaje" });
    await user.click(within(menu).getByRole("button", { name: "Eliminar" }));
    const confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: "Cancelar" }));
    expect(db.deleted).toEqual([]);
  });

  it("shows the verify-email state on 403 and never asks for a ticket", async () => {
    db.readStatus = 403;
    renderApp(`/chat/${ROOMS.familia}`, authenticatedState());

    expect(await screen.findByRole("heading", { name: "Verifica tu correo para usar el chat" })).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(db.tickets).toEqual([]);
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it("shows the verify-email state when the ticket is refused", async () => {
    db.ticketStatus = 403;
    renderApp("/chat", authenticatedState());
    expect(await screen.findByRole("heading", { name: "Verifica tu correo para usar el chat" })).toBeInTheDocument();
  });

  it("renders bodies as text and links only http(s) URLs", async () => {
    db.messages.set(ROOMS.familia, [
      makeMessage(1, { body: 'javascript:alert(1) <img src=x onerror="alert(1)"> https://example.com/fotos' })
    ]);
    renderApp(`/chat/${ROOMS.familia}`, authenticatedState());

    const link = await within(await screen.findByRole("log")).findByRole("link", { name: "https://example.com/fotos" });
    expect(link).toHaveAttribute("href", "https://example.com/fotos");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveAttribute("target", "_blank");
    expect(within(log()).getAllByRole("link")).toHaveLength(1);
    expect(log().querySelector("img")).toBeNull();
    expect(within(log()).getByText(/javascript:alert\(1\) <img/)).toBeInTheDocument();
  });

  it("Enter sends on desktop and Shift+Enter adds a line; on phones Enter is a newline", async () => {
    stubDesktopPointer(true);
    const user = userEvent.setup();
    renderApp(`/chat/${ROOMS.familia}`, authenticatedState());
    await screen.findByText("Mensaje 5");
    const socket = await openSocket();
    const box = screen.getByRole("textbox", { name: "Mensaje" });

    // Desktop: the composer gets focus on open.
    await waitFor(() => expect(box).toHaveFocus());
    await user.type(box, "Línea 1{Shift>}{Enter}{/Shift}Línea 2");
    expect(box).toHaveValue("Línea 1\nLínea 2");
    await user.type(box, "{Enter}");
    expect(box).toHaveValue("");
    expect(sendFrames(socket)).toEqual([expect.objectContaining({ body: "Línea 1\nLínea 2" })]);

    stubDesktopPointer(false);
    await user.type(box, "Hola{Enter}");
    expect(box).toHaveValue("Hola\n");
    expect(sendFrames(socket)).toHaveLength(1);
  });

  it("shows the counter near the limit and blocks sending over 2000 characters", async () => {
    renderApp(`/chat/${ROOMS.familia}`, authenticatedState());
    await screen.findByText("Mensaje 5");
    const box = screen.getByRole("textbox", { name: "Mensaje" });

    fireEvent.change(box, { target: { value: "a".repeat(1799) } });
    expect(screen.queryByText(/\/ 2,000/)).not.toBeInTheDocument();
    fireEvent.change(box, { target: { value: "a".repeat(1800) } });
    expect(screen.getByText("1,800 / 2,000")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enviar" })).toBeEnabled();
    fireEvent.change(box, { target: { value: "a".repeat(2001) } });
    expect(screen.getByText(/2,001 \/ 2,000 · Demasiado largo/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enviar" })).toBeDisabled();
  });

  it("shows the new-messages pill instead of jumping when the reader scrolled up", async () => {
    const user = userEvent.setup();
    renderApp(`/chat/${ROOMS.familia}`, authenticatedState());
    await screen.findByText("Mensaje 5");
    const socket = await openSocket();
    const list = log();
    Object.defineProperty(list, "scrollHeight", { configurable: true, get: () => 2000 });
    Object.defineProperty(list, "clientHeight", { configurable: true, get: () => 400 });

    list.scrollTop = 600;
    fireEvent.scroll(list);
    act(() => socket.receive(frames.message(makeMessage(6, { sender: PEOPLE.tomas, body: "¿Ya vieron las fotos?" }))));
    const pill = await screen.findByRole("button", { name: "Nuevos mensajes ↓" });
    expect(list.scrollTop).toBe(600);

    await user.click(pill);
    expect(list.scrollTop).toBe(2000);
    expect(screen.queryByRole("button", { name: "Nuevos mensajes ↓" })).not.toBeInTheDocument();

    // At the bottom, new messages scroll into view without a pill.
    list.scrollTop = 1600;
    fireEvent.scroll(list);
    act(() => socket.receive(frames.message(makeMessage(7, { sender: PEOPLE.tomas, body: "¡Qué bonitas!" }))));
    await within(list).findByText("¡Qué bonitas!");
    expect(screen.queryByRole("button", { name: "Nuevos mensajes ↓" })).not.toBeInTheDocument();
    expect(list.scrollTop).toBe(2000);
  });

  it("shows who is typing in this room", async () => {
    renderApp(`/chat/${ROOMS.familia}`, authenticatedState());
    await screen.findByText("Mensaje 5");
    const socket = await openSocket();
    act(() => socket.receive(frames.typing(ROOMS.familia, PEOPLE.marta)));
    expect(await screen.findByText("Marta está escribiendo…")).toBeInTheDocument();
    act(() => socket.receive(frames.typing(ROOMS.familia, ME)));
    expect(screen.getByText("Marta está escribiendo…")).toBeInTheDocument();
  });

  it("closes the socket when leaving the chat", async () => {
    const { router } = renderApp(`/chat/${ROOMS.familia}`, authenticatedState());
    await screen.findByText("Mensaje 5");
    const socket = await openSocket();
    await act(() => router.navigate("/chat"));
    expect(socket.closedByClient).toBeNull();
    await act(() => router.navigate("/mas"));
    await waitFor(() => expect(socket.closedByClient).toBe(1000));
  });
});
