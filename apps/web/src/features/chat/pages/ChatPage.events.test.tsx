/**
 * WP-5.4: event rooms in the chat (icon, event title, link to the event) and
 * the `room_removed` frame (drop the room, close it if open, clear its cached
 * history, toast "Ya no participas en …").
 */
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authenticatedState } from "../../../../test/auth";
import { createTestServer } from "../../../../test/msw";
import { renderApp } from "../../../../test/renderApp";
import { conversationApi } from "../conversationApi";
import { resetChatEventsForTests } from "../events";
import { configureChatSocketForTests, resetChatSocketForTests } from "../socket";
import { createFakeSocket, FakeSocket } from "../testing/fakeSocket";
import { type ChatDb, chatHandlers, frames, makeChatDb, makeEventRoom, makeMessage, makeRooms, PEOPLE, ROOMS } from "../testing/fixtures";

const server = createTestServer();
let db: ChatDb;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  db = makeChatDb();
  db.rooms = [...makeRooms(), makeEventRoom()];
  db.messages.set(ROOMS.evento, [makeMessage(60, { roomId: ROOMS.evento, sender: PEOPLE.tomas, body: "¿Quién lleva la hielera?" })]);
  server.use(...chatHandlers(db));
  FakeSocket.reset();
  configureChatSocketForTests({ createSocket: createFakeSocket, random: () => 0 });
});
afterEach(() => {
  cleanup();
  resetChatSocketForTests();
  resetChatEventsForTests();
  server.resetHandlers();
});

async function openSocket(): Promise<FakeSocket> {
  await waitFor(() => expect(FakeSocket.instances.length).toBeGreaterThan(0));
  const socket = FakeSocket.latest();
  act(() => socket.open());
  return socket;
}

describe("ChatPage event rooms (WP-5.4)", { timeout: 20_000 }, () => {
  it("lists an event room with the party icon and the event title", async () => {
    renderApp("/chat", authenticatedState());
    const room = await screen.findByRole("link", { name: /Paseo a la laguna/ });
    expect(room).toHaveAttribute("href", `/chat/${ROOMS.evento}`);
    expect(within(room).getByText("🎉")).toBeInTheDocument();
    expect(within(room).getByText("(evento)")).toBeInTheDocument();
  });

  it("links an open event conversation to its event page", async () => {
    renderApp(`/chat/${ROOMS.evento}`, authenticatedState());
    expect(await screen.findByText("¿Quién lleva la hielera?", { selector: "p, span, div" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Paseo a la laguna" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ver evento" })).toHaveAttribute("href", "/eventos/2026/paseo-a-la-laguna-k7q2");
  });

  it("on room_removed drops the room, closes the open conversation, clears its history and says why", async () => {
    const { store, router } = renderApp(`/chat/${ROOMS.evento}`, authenticatedState());
    expect(await screen.findByRole("heading", { level: 2, name: "Paseo a la laguna" })).toBeInTheDocument();
    await waitFor(() => expect(conversationApi.endpoints.getMessages.select(ROOMS.evento)(store.getState()).data?.messages).toHaveLength(1));
    const socket = await openSocket();

    act(() => socket.receive(frames.roomRemoved(ROOMS.evento)));

    await waitFor(() => expect(router.state.location.pathname).toBe("/chat"));
    expect(await screen.findByText("Ya no participas en Paseo a la laguna.")).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Salas" });
    expect(within(list).queryByRole("link", { name: /Paseo a la laguna/ })).not.toBeInTheDocument();
    expect(within(list).getByRole("link", { name: /Toda la familia/ })).toBeInTheDocument();
    // [SEC] The cached history of the room is gone (no messages left to show if it were reopened from cache).
    expect(conversationApi.endpoints.getMessages.select(ROOMS.evento)(store.getState()).data?.messages ?? []).toEqual([]);
  });

  it("drops a removed room from the list without closing another open conversation", async () => {
    const { router } = renderApp(`/chat/${ROOMS.familia}`, authenticatedState());
    expect(await screen.findByText("Mensaje 5")).toBeInTheDocument();
    const socket = await openSocket();
    expect(screen.getByRole("link", { name: /Paseo a la laguna/ })).toBeInTheDocument();

    act(() => socket.receive(frames.roomRemoved(ROOMS.evento)));

    await waitFor(() => expect(screen.queryByRole("link", { name: /Paseo a la laguna/ })).not.toBeInTheDocument());
    expect(router.state.location.pathname).toBe(`/chat/${ROOMS.familia}`);
    expect(screen.getByText("Mensaje 5")).toBeInTheDocument();
    expect(await screen.findByText("Ya no participas en Paseo a la laguna.")).toBeInTheDocument();
  });
});
