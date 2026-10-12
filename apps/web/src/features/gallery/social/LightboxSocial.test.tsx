/**
 * WP-6.2 lightbox social features over MSW: deep link, hearts and likers,
 * tags (consent banner, pending label, picker, tap-to-place), comments
 * (composer, idempotent retry, author delete → tombstone, report) and the
 * admin comment-report queue. Fictional fixtures only.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { apiUrl, authenticatedState, errorBody, makeUser } from "../../../../test/auth";
import { createTestServer } from "../../../../test/msw";
import { renderApp, warmRoutes } from "../../../../test/renderApp";
import { type FakeGalleryDb, galleryHandlers, makeComment, makeDb, makeMedia, makeTag, socialOf, uuid } from "../testUtils";

const server = createTestServer();
let db: FakeGalleryDb;

beforeAll(async () => {
  server.listen({ onUnhandledRequest: "error" });
  // Pay the lazy chunks' cold transform once, outside the tests' timeouts.
  await warmRoutes("/galeria/2026", "/admin/media");
  await import("./LightboxSocial");
  await import("../admin/AdminCommentReports");
}, 60_000);
afterAll(() => server.close());
beforeEach(() => {
  db = makeDb();
  server.use(...galleryHandlers(db));
});
afterEach(() => server.resetHandlers());

const PHOTO = uuid(1);

async function openViewer(path = `/galeria/2026?foto=${PHOTO}`, user = makeUser()): Promise<HTMLElement> {
  renderApp(path, authenticatedState(user));
  return screen.findByRole("dialog", { name: "Visor de fotos" }, { timeout: 5000 });
}

describe("lightbox deep link (?foto=)", { timeout: 15_000 }, () => {
  it("opens a photo that is not in the loaded list through the per-item detail", async () => {
    db.media = [makeMedia(2)];
    db.byIdOnly = [makeMedia(1, { caption: "Abuela Rosa en Izamal", year: 2025 })];
    const viewer = await openViewer();
    expect(await within(viewer).findByRole("img", { name: "Abuela Rosa en Izamal" })).toBeInTheDocument();
    expect(db.log).toContain(`GET /media/${PHOTO}/detail`);
  });

  it("shows the same not-found state for a missing or invisible photo", async () => {
    db.media = [makeMedia(2)];
    renderApp(`/galeria/2026?foto=${uuid(99)}`, authenticatedState());
    expect(await screen.findByRole("dialog", { name: "No encontramos esa foto" }, { timeout: 5000 })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Entendido" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "No encontramos esa foto" })).not.toBeInTheDocument());
  });

  it("ignores a malformed id without fetching", async () => {
    db.media = [makeMedia(2)];
    renderApp("/galeria/2026?foto=../../admin", authenticatedState());
    await screen.findByRole("button", { name: /Ver foto/ });
    expect(db.log.some((line) => line.includes("/detail"))).toBe(false);
  });

  it("keeps the open photo in the URL when opened from the grid", async () => {
    db.media = [makeMedia(1)];
    const user = userEvent.setup();
    const { router } = renderApp("/galeria/2026", authenticatedState());
    await user.click(await screen.findByRole("button", { name: "Ver foto: Foto número 1" }));
    await screen.findByRole("dialog", { name: "Visor de fotos" });
    expect(router.state.location.search).toBe(`?foto=${PHOTO}`);
  });
});

describe("hearts and likers", { timeout: 15_000 }, () => {
  it("toggles the heart and lists likers by name only", async () => {
    db.media = [makeMedia(1)];
    const state = socialOf(db, PHOTO);
    state.likeCount = 1;
    state.likers = [{ name: "Tía Carmen", avatarUrl: null, isMe: false }];
    const user = userEvent.setup();
    const viewer = await openViewer();

    const heart = await within(viewer).findByRole("button", { name: "Me gusta" });
    expect(heart).toHaveAttribute("aria-pressed", "false");
    await user.click(heart);
    expect(await within(viewer).findByRole("button", { name: "Quitar me gusta" })).toHaveAttribute("aria-pressed", "true");
    expect(within(viewer).getByRole("button", { name: "2 Me gusta" })).toBeInTheDocument();
    expect(db.log).toContain(`PUT /media/${PHOTO}/like`);

    state.likers = [{ name: "Prima Morales", avatarUrl: null, isMe: true }, ...state.likers];
    await user.click(within(viewer).getByRole("button", { name: "2 Me gusta" }));
    const sheet = await screen.findByRole("dialog", { name: "Me gusta" });
    expect(await within(sheet).findByText("Prima Morales (tú)")).toBeInTheDocument();
    expect(within(sheet).getByText("Tía Carmen")).toBeInTheDocument();
  });

  it("rolls the heart back when the server refuses", async () => {
    db.media = [makeMedia(1)];
    server.use(http.put(apiUrl("/media/:id/like"), () => HttpResponse.json(errorBody("RATE_LIMITED", "Demasiados."), { status: 429 })));
    const user = userEvent.setup();
    const viewer = await openViewer();
    await user.click(await within(viewer).findByRole("button", { name: "Me gusta" }));
    expect(await screen.findByText("Demasiados.")).toBeInTheDocument();
    expect(await within(viewer).findByRole("button", { name: "Me gusta" })).toHaveAttribute("aria-pressed", "false");
    expect(within(viewer).getByRole("button", { name: "0 Me gusta" })).toBeDisabled();
  });
});

describe("tags", { timeout: 15_000 }, () => {
  it("labels a pending tag only when the server says pending, and shows the approval banner to the tagged user", async () => {
    db.media = [makeMedia(1)];
    const state = socialOf(db, PHOTO);
    state.tags = [
      makeTag(1, { person: { id: uuid(8001), name: "Tomás Vega", avatarUrl: null } }),
      makeTag(2, { person: { id: uuid(8002), name: "Prima Morales", avatarUrl: null }, status: "pending", isMe: true, canRemove: true, canApprove: true })
    ];
    const user = userEvent.setup();
    const viewer = await openViewer();

    const chips = await within(viewer).findByRole("list", { name: "Personas etiquetadas" });
    expect(within(chips).getByText("Tomás Vega")).toBeInTheDocument();
    expect(within(chips).getAllByText(/Esperando aprobación/)).toHaveLength(1);
    const banner = within(viewer).getByRole("region", { name: "Etiqueta por aprobar" });
    await user.click(within(banner).getByRole("button", { name: "Aprobar" }));
    await waitFor(() => expect(within(viewer).queryByRole("region", { name: "Etiqueta por aprobar" })).not.toBeInTheDocument());
    expect(within(chips).queryByText(/Esperando aprobación/)).not.toBeInTheDocument();
    expect(db.log).toContain(`POST /media/tags/${uuid(7002)}/approve`);
    // Approved now: one tap removes it.
    await user.click(within(chips).getByRole("button", { name: "Quitar mi etiqueta" }));
    await waitFor(() => expect(within(chips).queryByText("Prima Morales")).not.toBeInTheDocument());
    expect(db.log).toContain(`DELETE /media/${PHOTO}/tags/${uuid(7002)}`);
  });

  it("declines a pending tag in one tap", async () => {
    db.media = [makeMedia(1)];
    socialOf(db, PHOTO).tags = [makeTag(2, { person: { id: uuid(8002), name: "Prima Morales", avatarUrl: null }, status: "pending", isMe: true, canRemove: true, canApprove: true })];
    const user = userEvent.setup();
    const viewer = await openViewer();
    const banner = await within(viewer).findByRole("region", { name: "Etiqueta por aprobar" });
    await user.click(within(banner).getByRole("button", { name: "Rechazar" }));
    await waitFor(() => expect(within(viewer).queryByText("Prima Morales")).not.toBeInTheDocument());
    expect(db.log).toContain(`DELETE /media/${PHOTO}/tags/${uuid(7002)}`);
  });

  it("tags a person from the server's candidates, with no pending label for the tagger", async () => {
    db.media = [makeMedia(1)];
    const state = socialOf(db, PHOTO);
    state.candidates = [{ id: uuid(8100), name: "Lupita Herrera", nickname: "Lupe", avatarUrl: null, isMe: false }];
    const user = userEvent.setup();
    const viewer = await openViewer();

    await user.click(await within(viewer).findByRole("button", { name: /Etiquetar/ }));
    const picker = await screen.findByRole("dialog", { name: "Etiquetar a alguien" });
    await user.type(within(picker).getByLabelText("Nombre de la persona"), "lupi");
    await user.click(await within(picker).findByRole("button", { name: /Lupita Herrera/ }, { timeout: 3000 }));
    expect(await screen.findByText("Etiquetaste a Lupita Herrera.")).toBeInTheDocument();
    expect(db.bodies[`POST tags ${PHOTO}`]).toEqual({ personId: uuid(8100) });
    const chips = await within(viewer).findByRole("list", { name: "Personas etiquetadas" });
    expect(within(chips).getByText("Lupita Herrera")).toBeInTheDocument();
    expect(within(chips).queryByText(/Esperando aprobación/)).not.toBeInTheDocument();
    expect(db.log.some((line) => line.startsWith(`GET /media/${PHOTO}/tag-candidates?q=lupi`))).toBe(true);
  });

  it("explains the 30-tag limit", async () => {
    db.media = [makeMedia(1)];
    socialOf(db, PHOTO).candidates = [{ id: uuid(8100), name: "Lupita Herrera", nickname: null, avatarUrl: null, isMe: false }];
    server.use(
      http.post(apiUrl("/media/:id/tags"), () =>
        HttpResponse.json({ error: { code: "CONFLICT", message: "Límite.", details: [{ path: "personId", message: "x", code: "TAG_LIMIT" }] } }, { status: 409 })
      )
    );
    const user = userEvent.setup();
    const viewer = await openViewer();
    await user.click(await within(viewer).findByRole("button", { name: /Etiquetar/ }));
    const picker = await screen.findByRole("dialog", { name: "Etiquetar a alguien" });
    await user.type(within(picker).getByLabelText("Nombre de la persona"), "Lupita");
    await user.click(await within(picker).findByRole("button", { name: /Lupita Herrera/ }, { timeout: 3000 }));
    expect(await within(picker).findByRole("alert")).toHaveTextContent("Esta foto ya tiene 30 personas etiquetadas.");
  });

  it("sends a placed position after tap-to-place", async () => {
    db.media = [makeMedia(1)];
    socialOf(db, PHOTO).candidates = [{ id: uuid(8100), name: "Lupita Herrera", nickname: null, avatarUrl: null, isMe: false }];
    // jsdom has no layout: give the image a box so the overlay renders.
    const sizes = { offsetWidth: 400, offsetHeight: 300, offsetLeft: 0, offsetTop: 0 } as const;
    const restore = Object.entries(sizes).map(([key, value]) => {
      const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, key);
      Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get: () => value });
      return () => {
        if (original) Object.defineProperty(HTMLElement.prototype, key, original);
      };
    });
    try {
      const user = userEvent.setup();
      const viewer = await openViewer();
      await user.click(await within(viewer).findByRole("button", { name: /Etiquetar/ }));
      let picker = await screen.findByRole("dialog", { name: "Etiquetar a alguien" });
      await user.click(within(picker).getByRole("button", { name: /Señalar en la foto/ }));
      const target = await within(viewer).findByRole("button", { name: "Marcar aquí a la persona" });
      target.focus();
      await user.keyboard("{Enter}"); // A keyboard tap marks the centre.
      picker = await screen.findByRole("dialog", { name: "Etiquetar a alguien" });
      expect(within(picker).getByText(/Marcaste un lugar en la foto/)).toBeInTheDocument();
      await user.type(within(picker).getByLabelText("Nombre de la persona"), "Lupita");
      await user.click(await within(picker).findByRole("button", { name: /Lupita Herrera/ }, { timeout: 3000 }));
      await waitFor(() => expect(db.bodies[`POST tags ${PHOTO}`]).toEqual({ personId: uuid(8100), x: 0.5, y: 0.5 }));
    } finally {
      for (const undo of restore) undo();
    }
  });
});

describe("comments drawer", { timeout: 15_000 }, () => {
  it("lists comments with tombstones, posts one and deletes your own", async () => {
    db.media = [makeMedia(1)];
    const state = socialOf(db, PHOTO);
    state.comments = [
      makeComment(1, PHOTO, { body: "¡Qué bonita foto!" }),
      makeComment(2, PHOTO, { deleted: true, body: "", author: null })
    ];
    const user = userEvent.setup();
    const viewer = await openViewer();

    await user.click(await within(viewer).findByRole("button", { name: /Comentarios \(1\)/ }));
    const drawer = await screen.findByRole("dialog", { name: "Comentarios" });
    expect(await within(drawer).findByText("¡Qué bonita foto!")).toBeInTheDocument();
    expect(within(drawer).getByText("Comentario eliminado")).toBeInTheDocument();

    await user.type(within(drawer).getByLabelText("Escribe un comentario"), "Saludos desde Mérida");
    await user.click(within(drawer).getByRole("button", { name: "Publicar" }));
    expect(await within(drawer).findByText("Saludos desde Mérida")).toBeInTheDocument();
    expect(within(drawer).getByLabelText("Escribe un comentario")).toHaveValue("");
    expect(await within(viewer).findByRole("button", { name: /Comentarios \(2\)/ })).toBeInTheDocument();

    const mine = within(drawer).getByText("Saludos desde Mérida").closest("li");
    if (!mine) throw new Error("no comment row");
    // Only your own comment offers "Eliminar"; others offer "Reportar".
    expect(within(mine).queryByRole("button", { name: "Reportar" })).not.toBeInTheDocument();
    await user.click(within(mine).getByRole("button", { name: "Eliminar" }));
    await user.click(within(mine).getByRole("button", { name: "Sí, eliminar" }));
    await waitFor(() => expect(within(drawer).queryByText("Saludos desde Mérida")).not.toBeInTheDocument());
    expect(within(drawer).getAllByText("Comentario eliminado")).toHaveLength(2);
    expect(await within(viewer).findByRole("button", { name: /Comentarios \(1\)/ })).toBeInTheDocument();
  });

  it("retries a failed comment with the same client id", async () => {
    db.media = [makeMedia(1)];
    let calls = 0;
    const clientIds: string[] = [];
    server.use(
      http.post(apiUrl("/media/:id/comments"), async ({ request }) => {
        const body = (await request.json()) as { clientCommentId: string }; // Test fixture: `CreateMediaCommentRequest`.
        clientIds.push(body.clientCommentId);
        calls += 1;
        if (calls === 1) return HttpResponse.json(errorBody("SERVICE_UNAVAILABLE", "Sin conexión."), { status: 503 });
        return HttpResponse.json(makeComment(9, PHOTO, { body: "Hola", author: { name: "Prima Morales", avatarUrl: null, isMe: true }, canDelete: true }), { status: 201 });
      })
    );
    const user = userEvent.setup();
    const viewer = await openViewer();
    await user.click(await within(viewer).findByRole("button", { name: /Comentarios/ }));
    const drawer = await screen.findByRole("dialog", { name: "Comentarios" });
    await user.type(within(drawer).getByLabelText("Escribe un comentario"), "Hola");
    await user.click(within(drawer).getByRole("button", { name: "Publicar" }));
    expect(await within(drawer).findByRole("alert")).toHaveTextContent("Sin conexión.");
    expect(within(drawer).getByLabelText("Escribe un comentario")).toHaveValue("Hola");
    await user.click(within(drawer).getByRole("button", { name: "Publicar" }));
    await waitFor(() => expect(calls).toBe(2));
    expect(clientIds[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(clientIds[1]).toBe(clientIds[0]);
  });

  it("reports someone else's comment with a reason, and says so on a repeat", async () => {
    db.media = [makeMedia(1)];
    socialOf(db, PHOTO).comments = [makeComment(1, PHOTO, { body: "Comentario fuera de lugar" })];
    const user = userEvent.setup();
    const viewer = await openViewer();
    await user.click(await within(viewer).findByRole("button", { name: /Comentarios/ }));
    const drawer = await screen.findByRole("dialog", { name: "Comentarios" });
    const row = (await within(drawer).findByText("Comentario fuera de lugar")).closest("li");
    if (!row) throw new Error("no comment row");
    expect(within(row).queryByRole("button", { name: "Eliminar" })).not.toBeInTheDocument();

    const report = async (): Promise<void> => {
      await user.click(within(row).getByRole("button", { name: "Reportar" }));
      await user.selectOptions(within(row).getByLabelText("Motivo del reporte"), "inappropriate");
      await user.click(within(row).getByRole("button", { name: "Enviar reporte" }));
    };
    await report();
    expect(await screen.findByText("Gracias. Un administrador lo revisará.")).toBeInTheDocument();
    expect(db.bodies[`REPORT comment ${uuid(6001)}`]).toEqual({ reason: "inappropriate", details: null });
    await report();
    expect(await screen.findByText("Ya habías reportado este comentario.")).toBeInTheDocument();
  });
});

describe("admin comment reports", { timeout: 15_000 }, () => {
  it("lists reported comments and deletes one after confirming", async () => {
    db.commentReports = [
      {
        id: uuid(6001),
        mediaId: PHOTO,
        body: "Comentario fuera de lugar",
        authorName: "Primo Lalo",
        authorUserId: uuid(500),
        createdAt: new Date(Date.UTC(2026, 8, 14)).toISOString(),
        deletedAt: null,
        reportCount: 2,
        reports: [{ id: uuid(6101), reason: "inappropriate", details: null, reporterName: "Tía Carmen", createdAt: new Date(Date.UTC(2026, 8, 15)).toISOString() }]
      }
    ];
    const user = userEvent.setup();
    renderApp("/admin/media?cola=comments", authenticatedState(makeUser({ role: "admin" })));
    expect(await screen.findByText("“Comentario fuera de lugar”", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText(/2 reportes/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Eliminar comentario" }));
    const confirm = await screen.findByRole("alertdialog", { name: "¿Eliminar este comentario?" });
    await user.click(within(confirm).getByRole("button", { name: "Eliminar" }));
    await waitFor(() => expect(db.log).toContain(`DELETE /admin/media/comments/${uuid(6001)}`));
    await waitFor(() => expect(screen.queryByText("“Comentario fuera de lugar”")).not.toBeInTheDocument());
  });
});
