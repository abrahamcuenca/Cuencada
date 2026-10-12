/**
 * `/notificaciones` and the bell (WP-6.1): Spanish entries grouped by day,
 * tap-through links, mark one / all read (the badge follows), "Salir" on an
 * event notice, live `notification` frames (feed and badge), malformed
 * entries dropped, the empty and error states.
 */
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { apiUrl, authenticatedState, makeUser } from "../../../../test/auth";
import { createTestServer } from "../../../../test/msw";
import { renderApp, warmRoutes } from "../../../../test/renderApp";
import { resetChatEventsForTests } from "../../chat/events";
import { configureChatSocketForTests, resetChatSocketForTests } from "../../chat/socket";
import { createFakeSocket, FakeSocket } from "../../chat/testing/fakeSocket";
import { chatHandlers, makeChatDb } from "../../chat/testing/fixtures";
import { parseNotificationPage } from "../feedApi";
import { makeFeed, makeNotificationsDb, type NotificationsDb, notificationFrame, notificationId, notificationsHandlers, TARGETS } from "../testing/fixtures";

const server = createTestServer();
let db: NotificationsDb;
let left: string[];

beforeAll(async () => {
  server.listen({ onUnhandledRequest: "error" });
  await warmRoutes("/notificaciones");
}, 30_000);
afterAll(() => server.close());
beforeEach(() => {
  db = makeNotificationsDb();
  left = [];
  server.use(
    ...notificationsHandlers(db),
    ...chatHandlers(makeChatDb()),
    http.delete(apiUrl("/events/:id/participants/me"), ({ params }) => {
      left.push(String(params.id));
      db.items = db.items.filter((item) => item.kind !== "event_added");
      return new HttpResponse(null, { status: 204 });
    })
  );
  FakeSocket.reset();
  configureChatSocketForTests({ createSocket: createFakeSocket, random: () => 0 });
});
afterEach(() => {
  cleanup();
  resetChatSocketForTests();
  resetChatEventsForTests();
  server.resetHandlers();
});

function bell(): HTMLElement {
  return within(screen.getByRole("banner")).getByRole("link", { name: /^Notificaciones/ });
}

async function feedList(): Promise<HTMLElement> {
  await screen.findByText("Ana Morales Vega te etiquetó en una foto");
  return screen.getByRole("main");
}

describe("NotificationsPage", { timeout: 20_000 }, () => {
  it("lists each kind in Spanish, grouped by day, linking to its target, unread ones marked", async () => {
    renderApp("/notificaciones", authenticatedState());
    expect(await screen.findByRole("heading", { level: 1, name: "Notificaciones" })).toBeInTheDocument();
    const main = await feedList();
    expect(within(main).getAllByRole("heading", { level: 2 }).length).toBeGreaterThanOrEqual(2);
    const link = (text: string | RegExp): HTMLElement => within(main).getByRole("link", { name: text });
    expect(link(/Sin leer:\s*Ana Morales Vega te etiquetó en una foto/)).toHaveAttribute("href", `/galeria/2026?foto=${TARGETS.media}`);
    expect(within(main).getByText(/aprobar o rechazar la etiqueta/)).toBeInTheDocument();
    expect(link(/Ana Morales Vega y 2 más comentaron tu foto/)).toHaveAttribute("href", `/eventos/2026/paseo-a-la-laguna-k7q2?vista=fotos&foto=${TARGETS.media}`);
    expect(link(/^A Ana Morales Vega y 2 más les gustó tu foto/)).toHaveAttribute("href", `/recuerdos/${TARGETS.proposal}?foto=${TARGETS.media}`);
    expect(link(/Rosa Quintero Lara te agregó a «Paseo a la laguna»/)).toHaveAttribute("href", "/eventos/2026/paseo-a-la-laguna-k7q2");
    expect(link(/^Tu propuesta del árbol fue aprobada/)).toHaveAttribute("href", `/arbol?propuesta=${TARGETS.proposal}`);
    // The bell shows the unread count.
    await waitFor(() => expect(bell()).toHaveAccessibleName("Notificaciones: 3 notificaciones sin leer"));
  });

  it("marks everything read in one tap and clears the badge", async () => {
    const user = userEvent.setup();
    renderApp("/notificaciones", authenticatedState());
    const main = await feedList();
    await waitFor(() => expect(bell()).toHaveAccessibleName(/3 notificaciones sin leer/));
    await user.click(within(main).getByRole("button", { name: "Marcar todo como leído" }));
    await waitFor(() => expect(within(main).queryByText(/Sin leer:/)).not.toBeInTheDocument());
    expect(db.bodies).toContainEqual({ all: true });
    await waitFor(() => expect(bell()).toHaveAccessibleName("Notificaciones"));
    expect(within(main).getByRole("button", { name: "Marcar todo como leído" })).toBeDisabled();
  });

  it("marks one entry read when it is opened", async () => {
    const user = userEvent.setup();
    const { router } = renderApp("/notificaciones", authenticatedState());
    const main = await feedList();
    // The gallery page it opens: any other read answers 404 here (not under test).
    server.use(http.get(apiUrl("/*"), () => HttpResponse.json({ error: { code: "NOT_FOUND", message: "No." } }, { status: 404 })));
    await user.click(within(main).getByRole("link", { name: /te etiquetó en una foto/ }));
    await waitFor(() => expect(db.bodies).toContainEqual({ ids: [notificationId(1)] }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/galeria/2026"));
    expect(router.state.location.search).toBe(`?foto=${TARGETS.media}`);
  });

  it("keeps the one-tap Salir of an event notice", async () => {
    const user = userEvent.setup();
    renderApp("/notificaciones", authenticatedState());
    const main = await feedList();
    await user.click(within(main).getByRole("button", { name: "Salir de Paseo a la laguna" }));
    expect(await screen.findByText("Saliste de Paseo a la laguna.")).toBeInTheDocument();
    expect(left).toEqual([TARGETS.event]);
    await waitFor(() => expect(within(main).queryByText(/te agregó a/)).not.toBeInTheDocument());
  });

  it("puts a live notification frame on top (replacing its older copy) and updates the badge", async () => {
    renderApp("/notificaciones", authenticatedState());
    const main = await feedList();
    await waitFor(() => expect(FakeSocket.instances.length).toBeGreaterThan(0));
    const socket = FakeSocket.latest();
    act(() => socket.open());
    const [, commented] = makeFeed();
    if (commented === undefined) throw new Error("fixture");
    act(() =>
      socket.receive(notificationFrame({ ...commented, count: 4, actor: { name: "Bea Ríos Luna", avatarUrl: null }, createdAt: new Date().toISOString() }, 7))
    );
    const fresh = await within(main).findByRole("link", { name: /Bea Ríos Luna y 3 más comentaron tu foto/ });
    expect(within(main).queryByText(/Ana Morales Vega y 2 más comentaron/)).not.toBeInTheDocument();
    expect(within(main).getAllByRole("link")[0]).toBe(fresh);
    await waitFor(() => expect(bell()).toHaveAccessibleName("Notificaciones: 7 notificaciones sin leer"));
  });

  it("shows the empty state, and a retry when the feed fails", async () => {
    db.items = [];
    renderApp("/notificaciones", authenticatedState());
    expect(await screen.findByRole("heading", { name: "No tienes notificaciones" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Marcar todo como leído" })).not.toBeInTheDocument();
    cleanup();
    db.feedStatus = 500;
    renderApp("/notificaciones", authenticatedState());
    expect(await screen.findByRole("heading", { name: "No pudimos cargar tus notificaciones" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reintentar" })).toBeInTheDocument();
  });

  it("pages with Cargar más", async () => {
    db.pageSize = 3;
    const user = userEvent.setup();
    renderApp("/notificaciones", authenticatedState());
    const main = await feedList();
    expect(within(main).queryByText(/fue aprobada/)).not.toBeInTheDocument();
    await user.click(within(main).getByRole("button", { name: "Cargar más" }));
    expect(await within(main).findByText(/fue aprobada/)).toBeInTheDocument();
    expect(db.log).toContain("GET /notifications?limit=30&cursor=3");
  });
});

describe("the bell", { timeout: 20_000 }, () => {
  it("caps the badge at 999+ and hides for unverified members", async () => {
    server.use(http.get(apiUrl("/notifications/unread-count"), () => HttpResponse.json({ count: 999 })));
    renderApp("/mas", authenticatedState());
    await waitFor(() => expect(bell()).toHaveAccessibleName("Notificaciones: 999 o más notificaciones sin leer"));
    expect(bell()).toHaveAttribute("href", "/notificaciones");
    cleanup();
    renderApp("/mas", authenticatedState(makeUser({ emailVerified: false })));
    await screen.findByRole("banner");
    expect(within(screen.getByRole("banner")).queryByRole("link", { name: /^Notificaciones/ })).not.toBeInTheDocument();
  });
});

describe("parseNotificationPage", () => {
  it("drops malformed entries (wrong target, comment-like extras stripped) without hiding the others", () => {
    const [first, second] = makeFeed();
    const raw = {
      items: [first, { ...second, kind: "event_added" }, { ...first, id: "nope" }, { ...first, id: notificationId(9), body: "texto" }],
      nextCursor: "abc"
    };
    const page = parseNotificationPage(raw);
    expect(page.items.map((item) => item.id)).toEqual([notificationId(1), notificationId(9)]);
    expect(page.items[1]).not.toHaveProperty("body");
    expect(page.nextCursor).toBe("abc");
    expect(parseNotificationPage(null)).toEqual({ items: [], nextCursor: null });
  });
});
