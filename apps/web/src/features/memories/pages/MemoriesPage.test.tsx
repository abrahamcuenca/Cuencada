import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { apiUrl, authenticatedState, makeUser } from "../../../../test/auth";
import { createTestServer } from "../../../../test/msw";
import { renderApp, warmRoutes } from "../../../../test/renderApp";
import { galleryApi } from "../../gallery/api";
import { env } from "../../../shared/lib/env";
import { makeBox, makeBoxMedia, type MemoriesDb, memoriesHandlers, makeMemoriesDb, memoryId } from "../testing/fixtures";

const server = createTestServer();
let db: MemoriesDb;

beforeAll(async () => {
  server.listen({ onUnhandledRequest: "error" });
  await warmRoutes("/recuerdos", `/recuerdos/${memoryId(1)}`);
}, 30_000);
afterAll(() => server.close());
beforeEach(() => {
  db = makeMemoriesDb();
  server.use(...memoriesHandlers(db));
});
afterEach(() => server.resetHandlers());

describe("MemoriesPage (/recuerdos)", { timeout: 20_000 }, () => {
  it("shows published boxes as cards with cover or placeholder, title, count and description", async () => {
    db.boxes = [
      makeBox(1, { title: "La casa de los abuelos", coverUrl: "https://bucket.example/memories/thumb-1.webp?X-Amz-Signature=c", mediaCount: 12 }),
      makeBox(2, { title: "Bodas", mediaCount: 1, description: null }),
      makeBox(3, { title: "Borrador secreto", status: "draft" })
    ];
    renderApp("/recuerdos", authenticatedState());

    expect(await screen.findByRole("heading", { level: 1, name: "Baúl de recuerdos" })).toBeInTheDocument();
    const list = await screen.findByRole("list", { name: "Baúles" });
    const cards = within(list).getAllByRole("article");
    expect(cards).toHaveLength(2);
    const first = cards[0] as HTMLElement;
    expect(within(first).getByRole("link", { name: "La casa de los abuelos" })).toHaveAttribute("href", `/recuerdos/${memoryId(1)}`);
    expect(first.querySelector("img")).toHaveAttribute("src", "https://bucket.example/memories/thumb-1.webp?X-Amz-Signature=c");
    expect(within(first).getByText("12 fotos y videos")).toBeInTheDocument();
    expect(within(first).getByText("Escaneadas por la Rama Norte.")).toBeInTheDocument();
    const second = cards[1] as HTMLElement;
    expect(second.querySelector("img")).toBeNull();
    expect(within(second).getByText("1 foto o video")).toBeInTheDocument();
    expect(screen.queryByText("Borrador secreto")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Administrar" })).not.toBeInTheDocument();
  });

  it("shows an empty state, and the panel shortcut for admins", async () => {
    renderApp("/recuerdos", authenticatedState(makeUser({ role: "admin" })));
    expect(await screen.findByText("El baúl todavía está vacío")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Administrar/ })).toHaveAttribute("href", "/admin/recuerdos");
  });
});

describe("MemoryAlbumPage (/recuerdos/:id)", { timeout: 20_000 }, () => {
  it("shows the description and the box's photos in the gallery grid, and opens the lightbox", async () => {
    const box = makeBox(1, { title: "La casa de los abuelos", mediaCount: 2, description: "Fotos de 1970 a 1990." });
    db.boxes = [box];
    db.media.set(box.id, [makeBoxMedia(1, box), makeBoxMedia(2, box)]);
    const user = userEvent.setup();
    renderApp(`/recuerdos/${box.id}`, authenticatedState());

    expect(await screen.findByRole("heading", { level: 1, name: "La casa de los abuelos" })).toBeInTheDocument();
    expect(screen.getByText("Fotos de 1970 a 1990.")).toBeInTheDocument();
    expect(screen.getByText("2 fotos y videos")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Baúl de recuerdos/ })).toHaveAttribute("href", "/recuerdos");
    await user.click(await screen.findByRole("button", { name: "Ver foto: Foto número 2" }));
    const viewer = await screen.findByRole("dialog", { name: "Visor de fotos" });
    expect(within(viewer).getByText("2 de 2")).toBeInTheDocument();
    expect(db.log).toContain(`GET /memories/${box.id}/media?limit=30`);
  });

  it("opens ?foto=<id> (notification links) in the lightbox and drops it from the URL on close", async () => {
    const box = makeBox(1, { mediaCount: 2 });
    db.boxes = [box];
    db.media.set(box.id, [makeBoxMedia(1, box), makeBoxMedia(2, box)]);
    const user = userEvent.setup();
    const { router } = renderApp(`/recuerdos/${box.id}?foto=${makeBoxMedia(2, box).id}`, authenticatedState());
    const viewer = await screen.findByRole("dialog", { name: "Visor de fotos" });
    expect(within(viewer).getByText("2 de 2")).toBeInTheDocument();
    await user.click(within(viewer).getByRole("button", { name: "Cerrar visor" }));
    await waitFor(() => expect(router.state.location.search).toBe(""));
    expect(screen.queryByRole("dialog", { name: "Visor de fotos" })).not.toBeInTheDocument();
  });

  it("opens a ?foto=<id> photo that is beyond the first loaded page through the per-item detail (WP-6.2)", async () => {
    const box = makeBox(1, { mediaCount: 31 });
    db.boxes = [box];
    db.media.set(box.id, [makeBoxMedia(1, box)]);
    const later = { ...makeBoxMedia(31, box), caption: "Foto de la página dos" };
    server.use(
      http.get(apiUrl("/media/:id/detail"), ({ params }) =>
        params.id === later.id
          ? HttpResponse.json({
              item: later,
              tags: [],
              likes: { likeCount: 0, likedByMe: false },
              commentCount: 0,
              comments: { items: [], nextCursor: null },
              canTag: true
            })
          : HttpResponse.json({ error: { code: "NOT_FOUND", message: "No encontramos esa foto o video." } }, { status: 404 })
      )
    );
    renderApp(`/recuerdos/${box.id}?foto=${later.id}`, authenticatedState());
    const viewer = await screen.findByRole("dialog", { name: "Visor de fotos" }, { timeout: 5000 });
    expect(await within(viewer).findByRole("img", { name: "Foto de la página dos" })).toBeInTheDocument();
  });

  it("shows the same not-found state for a hidden, a draft and a missing box (no request leaks the difference)", async () => {
    db.boxes = [makeBox(1, { status: "hidden", title: "Oculto W63" }), makeBox(2, { status: "draft", title: "Borrador W63" })];
    for (const id of [memoryId(1), memoryId(2), memoryId(3)]) {
      const view = renderApp(`/recuerdos/${id}`, authenticatedState());
      expect(await screen.findByRole("heading", { name: "No encontramos ese baúl" })).toBeInTheDocument();
      expect(screen.queryByText(/W63/)).not.toBeInTheDocument();
      expect(db.log).not.toContain(`GET /memories/${id}/media?limit=30`);
      view.router.dispose();
      document.body.innerHTML = "";
    }
  });

  it("treats a malformed id as not found without calling the API", async () => {
    renderApp("/recuerdos/no-es-un-id", authenticatedState());
    expect(await screen.findByRole("heading", { name: "No encontramos ese baúl" })).toBeInTheDocument();
    expect(db.log.filter((line) => line.startsWith("GET /memories/"))).toEqual([]);
  });

  it("offers the upload button on a published box and sends the intent to the box (server-derived prefix)", async () => {
    const box = makeBox(1);
    db.boxes = [box];
    const previous = env.mediaUploadOrigin;
    env.mediaUploadOrigin = "https://bucket.example";
    try {
      const { store } = renderApp(`/recuerdos/${box.id}`, authenticatedState());
      expect(await screen.findByText("Aún no hay fotos en este baúl")).toBeInTheDocument();
      expect(screen.getAllByRole("button", { name: /Subir fotos y videos/ }).length).toBeGreaterThan(0);
      const intent = await store
        .dispatch(galleryApi.endpoints.createMemoryUpload.initiate({ memoryAlbumId: box.id, body: { fileName: "abuela.jpg", mimeType: "image/jpeg", byteSize: 1000, caption: null } }))
        .unwrap();
      expect(intent.mediaId).toBe(memoryId(700));
      expect(db.log).toContain(`POST /memories/${box.id}/uploads`);
      expect(db.bodies.get(`POST /memories/${box.id}/uploads`)).toEqual({ fileName: "abuela.jpg", mimeType: "image/jpeg", byteSize: 1000, caption: null });
    } finally {
      env.mediaUploadOrigin = previous;
    }
  });
});
