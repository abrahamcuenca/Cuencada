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
import { chatHandlers, frames, makeChatDb, makeEventRoom, makeMessage, PEOPLE } from "../../chat/testing/fixtures";
import { EVENT_NOT_FOUND_TEXT, EVENT_NOT_FOUND_TITLE } from "../lib/format";
import { asOrganizer, type EventsDb, eventId, eventsHandlers, FOLKS, makeAlbum, makeAlbumMedia, makeDetail, makeEventsDb, makeParticipant, putDetail } from "../testing/fixtures";

const server = createTestServer();
let db: EventsDb;
const PATH = "/eventos/2026/paseo-1-k7q1";

beforeAll(async () => {
  server.listen({ onUnhandledRequest: "error" });
  await warmRoutes(PATH);
}, 30_000);
afterAll(() => server.close());
beforeEach(() => {
  db = makeEventsDb();
  server.use(...eventsHandlers(db));
  FakeSocket.reset();
  configureChatSocketForTests({ createSocket: createFakeSocket, random: () => 0 });
});
afterEach(() => {
  cleanup();
  resetChatSocketForTests();
  resetChatEventsForTests();
  server.resetHandlers();
});

/** Directory entries for the participants picker (fictional). */
function directoryHandler(): ReturnType<typeof http.get> {
  return http.get(apiUrl("/directory"), () =>
    HttpResponse.json({
      items: [
        { userId: FOLKS.rosa.userId, personId: null, displayName: FOLKS.rosa.displayName, fullName: FOLKS.rosa.displayName, familyBranch: null, avatarUrl: null, bio: null },
        { userId: eventId(950), personId: null, displayName: "Marta Ibáñez Ríos", fullName: "Marta Ibáñez Ríos", familyBranch: "Rama Ejemplo", avatarUrl: null, bio: null }
      ],
      nextCursor: null
    })
  );
}

describe("EventDetailPage", { timeout: 20_000 }, () => {
  describe("404 parity [SEC]", () => {
    it("shows the same screen for an event that does not exist or that I cannot see", async () => {
      renderApp("/eventos/2026/no-existe-zz99", authenticatedState());
      expect(await screen.findByRole("heading", { level: 1, name: EVENT_NOT_FOUND_TITLE })).toBeInTheDocument();
      const missing = document.querySelector("main")?.textContent;
      cleanup();

      // The fake server answers the exact same 404 for an invisible event (it is simply not in `db.details`).
      renderApp(PATH, authenticatedState());
      expect(await screen.findByRole("heading", { level: 1, name: EVENT_NOT_FOUND_TITLE })).toBeInTheDocument();
      expect(screen.getByText(EVENT_NOT_FOUND_TEXT)).toBeInTheDocument();
      expect(document.querySelector("main")?.textContent).toBe(missing);
      expect(screen.getByRole("link", { name: "Ver eventos" })).toHaveAttribute("href", "/eventos");
    });

    it("shows it for a malformed address too, without asking the server", async () => {
      renderApp("/eventos/2026/Not_A_Slug!", authenticatedState());
      expect(await screen.findByRole("heading", { level: 1, name: EVENT_NOT_FOUND_TITLE })).toBeInTheDocument();
      cleanup();
      renderApp("/eventos/abcd/paseo", authenticatedState());
      expect(await screen.findByRole("heading", { level: 1, name: EVENT_NOT_FOUND_TITLE })).toBeInTheDocument();
      expect(db.log.filter((line) => line.startsWith("GET /events/"))).toEqual([]);
    });
  });

  it("shows the hero, details, organizers and the first 8 participants, then +N", async () => {
    const many = Array.from({ length: 10 }, (_, i) => makeParticipant({ userId: eventId(700 + i), displayName: `Persona ${i + 1}` }));
    putDetail(db, makeDetail({ participants: [makeParticipant({ role: "organizer" }), ...many], participantCount: 11 }));
    const user = userEvent.setup();
    renderApp(PATH, authenticatedState());

    expect(await screen.findByRole("heading", { level: 1, name: "Paseo a la laguna 1" })).toBeInTheDocument();
    expect(screen.getByText(/sábado, 14 de noviembre de 2026/)).toBeInTheDocument();
    expect(screen.getByText("Laguna Ejemplo, Pueblo Ejemplo")).toBeInTheDocument();
    expect(screen.getByText("Organiza: Rosa Quintero Lara")).toBeInTheDocument();
    expect(screen.getByText(/Cada familia lleva un platillo/)).toBeInTheDocument();
    const people = screen.getByRole("region", { name: /Participantes/ });
    expect(within(people).getAllByRole("listitem")).toHaveLength(8);
    await user.click(within(people).getByRole("button", { name: /3 más/ }));
    expect(within(await screen.findByRole("dialog", { name: "Participantes (11)" })).getAllByRole("listitem")).toHaveLength(11);
  });

  it("says Por anunciar for an undated event", async () => {
    putDetail(db, makeDetail({ startsAt: null, endsAt: null }));
    renderApp(PATH, authenticatedState());
    expect(await screen.findByText("Por anunciar")).toBeInTheDocument();
  });

  it("joins with Me apunto and leaves with Salir del evento", async () => {
    putDetail(db, makeDetail());
    const user = userEvent.setup();
    renderApp(PATH, authenticatedState());
    await user.click(await screen.findByRole("button", { name: /Me apunto/ }));
    expect(await screen.findByText("¡Te apuntaste a Paseo a la laguna 1!")).toBeInTheDocument();
    expect(db.log).toContain(`POST /events/${eventId(1)}/join`);

    await user.click(await screen.findByRole("button", { name: "Salir del evento" }));
    const confirm = await screen.findByRole("alertdialog", { name: "¿Salir de Paseo a la laguna 1?" });
    await user.click(within(confirm).getByRole("button", { name: "Salir del evento" }));
    expect(await screen.findByText("Saliste de Paseo a la laguna 1.")).toBeInTheDocument();
    expect(db.log).toContain(`DELETE /events/${eventId(1)}/participants/me`);
    expect(await screen.findByRole("button", { name: /Me apunto/ })).toBeInTheDocument();
  });

  it("tells the last organizer why they cannot leave", async () => {
    putDetail(db, asOrganizer(makeDetail({ participants: [], participantCount: 0 })));
    renderApp(PATH, authenticatedState());
    expect(await screen.findByText(/Eres la única persona que organiza/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Salir del evento" })).not.toBeInTheDocument();
  });

  describe("admin vs member controls", () => {
    it("gives a plain member no organizer tools", async () => {
      putDetail(db, makeDetail());
      renderApp(PATH, authenticatedState());
      await screen.findByRole("heading", { level: 1, name: "Paseo a la laguna 1" });
      expect(screen.queryByRole("region", { name: "Organización" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Editar evento/ })).not.toBeInTheDocument();
    });

    it("gives an organizer edit/people/albums/publish but not Ocultar, and no slug field", async () => {
      putDetail(db, asOrganizer(makeDetail()));
      const user = userEvent.setup();
      renderApp(PATH, authenticatedState());
      const tools = await screen.findByRole("region", { name: "Organización" });
      for (const name of [/Editar evento/, /Personas/, /Álbumes/, /Pasar a borrador/, /Agregar portada/]) expect(within(tools).getByRole("button", { name })).toBeInTheDocument();
      expect(within(tools).queryByRole("button", { name: /Ocultar/ })).not.toBeInTheDocument();
      expect(within(tools).queryByRole("button", { name: /Eliminar/ })).not.toBeInTheDocument();

      await user.click(within(tools).getByRole("button", { name: /Editar evento/ }));
      const sheet = await screen.findByRole("dialog", { name: "Editar evento" });
      expect(within(sheet).queryByRole("textbox", { name: /Dirección/ })).not.toBeInTheDocument();
      expect(within(sheet).getByText("/eventos/2026/paseo-1-k7q1")).toBeInTheDocument();
      await user.clear(within(sheet).getByRole("textbox", { name: /Título/ }));
      await user.type(within(sheet).getByRole("textbox", { name: /Título/ }), "Paseo largo");
      await user.click(within(sheet).getByRole("button", { name: "Guardar cambios" }));
      await waitFor(() => expect(db.bodies[`PATCH /events/${eventId(1)}`]).toEqual({ title: "Paseo largo" }));
      expect(await screen.findByRole("heading", { level: 1, name: "Paseo largo" })).toBeInTheDocument();
    });

    it("gives an admin Ocultar, Eliminar and the slug field (admin endpoint)", async () => {
      putDetail(db, asOrganizer(makeDetail(), { canDelete: true }));
      const user = userEvent.setup();
      const { router } = renderApp(PATH, authenticatedState(makeUser({ role: "admin" })));
      const tools = await screen.findByRole("region", { name: "Organización" });
      expect(within(tools).getByRole("button", { name: /Eliminar/ })).toBeInTheDocument();

      await user.click(within(tools).getByRole("button", { name: /Editar evento/ }));
      const sheet = await screen.findByRole("dialog", { name: "Editar evento" });
      const slug = within(sheet).getByRole("textbox", { name: /Dirección/ });
      await user.clear(slug);
      await user.type(slug, "paseo-a-la-laguna");
      await user.click(within(sheet).getByRole("button", { name: "Guardar cambios" }));
      await waitFor(() => expect(router.state.location.pathname).toBe("/eventos/2026/paseo-a-la-laguna"));
      expect(db.bodies[`PATCH /admin/events/${eventId(1)}`]).toEqual({ slug: "paseo-a-la-laguna" });

      await user.click(await screen.findByRole("button", { name: /Ocultar/ }));
      const confirm = await screen.findByRole("alertdialog", { name: /Ocultar/ });
      await user.click(within(confirm).getByRole("button", { name: "Ocultar evento" }));
      await waitFor(() => expect(db.bodies[`PATCH /events/${eventId(1)}`]).toEqual({ status: "hidden" }));
      expect(await screen.findByRole("button", { name: /Mostrar/ })).toBeInTheDocument();
    });
  });

  it("adds participants from the directory only, with the consent note", async () => {
    putDetail(db, asOrganizer(makeDetail()));
    server.use(directoryHandler());
    const user = userEvent.setup();
    renderApp(PATH, authenticatedState());
    await user.click(await screen.findByRole("button", { name: /Personas/ }));
    const sheet = await screen.findByRole("dialog", { name: "Personas del evento" });
    expect(within(sheet).getByText("Les avisaremos y podrán salir cuando quieran.")).toBeInTheDocument();
    // Rosa already participates: only Marta is offered.
    const picker = await within(sheet).findByRole("list", { name: "Personas del directorio" });
    expect(within(picker).queryByText(FOLKS.rosa.displayName)).not.toBeInTheDocument();
    await user.click(within(picker).getByRole("checkbox", { name: /Marta Ibáñez Ríos/ }));
    await user.click(within(sheet).getByRole("button", { name: "Agregar (1)" }));
    await waitFor(() => expect(db.bodies[`POST /events/${eventId(1)}/participants`]).toEqual({ userIds: [eventId(950)] }));
    expect(await screen.findByText("Agregaste a 1 persona.")).toBeInTheDocument();
  });

  it("guards the last organizer in the people sheet", async () => {
    putDetail(db, asOrganizer(makeDetail({ participants: [makeParticipant()], participantCount: 1 })));
    server.use(directoryHandler());
    const user = userEvent.setup();
    renderApp(PATH, authenticatedState());
    await user.click(await screen.findByRole("button", { name: /Personas/ }));
    const sheet = await screen.findByRole("dialog", { name: "Personas del evento" });
    const me = within(sheet).getByText("Prima Morales").closest("li") as HTMLElement; // Safe: every manage row is an <li>.
    expect(within(me).getByRole("button", { name: "Quitar como organizador" })).toBeDisabled();
    expect(within(me).getByText(/Es la única persona que organiza/)).toBeInTheDocument();
  });

  it("explains EVENT_ALBUM_NOT_EMPTY when deleting an album with photos", async () => {
    putDetail(db, asOrganizer(makeDetail({ albums: [makeAlbum(1, { mediaCount: 4 })] })));
    db.failNext = { status: 409, code: "EVENT_ALBUM_NOT_EMPTY", message: "El álbum tiene fotos." };
    const user = userEvent.setup();
    renderApp(PATH, authenticatedState());
    await user.click(await screen.findByRole("button", { name: /Álbumes/ }));
    const sheet = await screen.findByRole("dialog", { name: "Álbumes" });
    await user.click(within(sheet).getByRole("button", { name: "Eliminar Fotos" }));
    await user.click(within(await screen.findByRole("alertdialog", { name: "¿Eliminar «Fotos»?" })).getByRole("button", { name: "Eliminar álbum" }));
    expect(await screen.findByText(/Este álbum tiene fotos\. Bórralas/)).toBeInTheDocument();
  });

  it("shows the album's photos in the Fotos tab with an album picker", async () => {
    const albums = [makeAlbum(1, { mediaCount: 1 }), makeAlbum(2, { title: "Comida" })];
    const event = asOrganizer(makeDetail({ albums }));
    putDetail(db, event);
    db.media.set(albums[0]?.id ?? "", [makeAlbumMedia(1, event, albums[0] ?? makeAlbum(1))]);
    db.media.set(albums[1]?.id ?? "", []);
    const user = userEvent.setup();
    renderApp(`${PATH}?vista=fotos`, authenticatedState());
    expect(await screen.findByRole("button", { name: "Ver foto: Foto del paseo 1" })).toBeInTheDocument();
    expect(db.log).toContain(`GET /events/${eventId(1)}/albums/${albums[0]?.id}/media?limit=30`);

    await user.selectOptions(screen.getByRole("combobox", { name: "Álbum" }), albums[1]?.id ?? "");
    expect(await screen.findByRole("heading", { name: "Aún no hay fotos en este álbum" })).toBeInTheDocument();
  });

  it("asks a non-participant to join instead of showing photos or chat", async () => {
    putDetail(db, makeDetail());
    const user = userEvent.setup();
    renderApp(`${PATH}?vista=fotos`, authenticatedState());
    expect(await screen.findByRole("heading", { name: "Apúntate para ver las fotos" })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Chat" }));
    expect(await screen.findByRole("heading", { name: "Apúntate para chatear" })).toBeInTheDocument();
    expect(db.log.some((line) => line.includes("/albums/"))).toBe(false);
  });

  it("embeds the event chat, and reloads with a toast on room_removed", async () => {
    const chat = makeChatDb();
    const room = makeEventRoom({ id: eventId(800) });
    chat.rooms = [room];
    chat.messages.set(room.id, [makeMessage(70, { roomId: room.id, sender: PEOPLE.tomas, body: "¿Quién trae hielo?" })]);
    server.use(...chatHandlers(chat));
    putDetail(db, asOrganizer(makeDetail()));
    renderApp(`${PATH}?vista=chat`, authenticatedState());

    expect(await screen.findByText("¿Quién trae hielo?")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Abrir en el chat/ })).toHaveAttribute("href", `/chat/${room.id}`);
    expect(screen.queryByRole("link", { name: "Ver evento" })).not.toBeInTheDocument();
    await waitFor(() => expect(FakeSocket.instances.length).toBeGreaterThan(0));
    const socket = FakeSocket.latest();
    act(() => socket.open());

    // The server took me out of the event: it is now invisible to me.
    db.details.clear();
    act(() => socket.receive(frames.roomRemoved(room.id)));
    expect(await screen.findByText("Ya no participas en Paseo a la laguna 1.")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { level: 1, name: EVENT_NOT_FOUND_TITLE })).toBeInTheDocument();
  });
});
