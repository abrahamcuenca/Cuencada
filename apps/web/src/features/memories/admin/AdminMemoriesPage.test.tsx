import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authenticatedState, makeUser } from "../../../../test/auth";
import { createTestServer } from "../../../../test/msw";
import { renderApp, warmRoutes } from "../../../../test/renderApp";
import { makeBox, makeBoxMedia, type MemoriesDb, memoriesHandlers, makeMemoriesDb, memoryId } from "../testing/fixtures";
import { moveId } from "./AdminMemoriesPage";

const server = createTestServer();
let db: MemoriesDb;
const PATH = "/admin/recuerdos";

beforeAll(async () => {
  server.listen({ onUnhandledRequest: "error" });
  await warmRoutes(PATH);
}, 30_000);
afterAll(() => server.close());
beforeEach(() => {
  db = makeMemoriesDb({ admin: true });
  server.use(...memoriesHandlers(db));
});
afterEach(() => server.resetHandlers());

const admin = (): ReturnType<typeof authenticatedState> => authenticatedState(makeUser({ role: "admin" }));

function rows(): HTMLElement[] {
  return within(screen.getByRole("list", { name: "Baúles" })).getAllByRole("listitem");
}

describe("moveId", () => {
  it("moves one id up or down and refuses moves off either end", () => {
    expect(moveId(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
    expect(moveId(["a", "b", "c"], 1, 1)).toEqual(["a", "c", "b"]);
    expect(moveId(["a", "b"], 0, -1)).toBeNull();
    expect(moveId(["a", "b"], 1, 1)).toBeNull();
    expect(moveId([], 0, 1)).toBeNull();
  });
});

describe("AdminMemoriesPage", { timeout: 20_000 }, () => {
  it("lists every status with badges, counts and creators", async () => {
    db.boxes = [makeBox(1, { mediaCount: 3 }), makeBox(2, { status: "draft" }), makeBox(3, { status: "hidden", createdByName: null })];
    renderApp(PATH, admin());
    expect(await screen.findByRole("heading", { level: 1, name: "Baúl de recuerdos" })).toBeInTheDocument();
    await screen.findByRole("list", { name: "Baúles" });
    const [first, second, third] = rows();
    expect(within(first as HTMLElement).getByText("Publicado")).toBeInTheDocument();
    expect(within(first as HTMLElement).getByText(/3 fotos y videos · Creado por Rosa Quintero Lara/)).toBeInTheDocument();
    expect(within(second as HTMLElement).getByText("Borrador")).toBeInTheDocument();
    expect(within(second as HTMLElement).getByRole("button", { name: "Publicar" })).toBeInTheDocument();
    expect(within(third as HTMLElement).getByText("Oculto")).toBeInTheDocument();
    expect(within(third as HTMLElement).getByText(/Creado por una cuenta eliminada/)).toBeInTheDocument();
    expect(within(first as HTMLElement).getByRole("button", { name: "Subir Fotos antiguas 1" })).toBeDisabled();
    expect(within(third as HTMLElement).getByRole("button", { name: "Bajar Fotos antiguas 3" })).toBeDisabled();
  });

  it("creates a draft box", async () => {
    const user = userEvent.setup();
    renderApp(PATH, admin());
    await user.click(await screen.findByRole("button", { name: /Nuevo baúl/ }));
    const sheet = await screen.findByRole("dialog", { name: "Nuevo baúl" });
    await user.click(within(sheet).getByRole("button", { name: "Crear baúl" }));
    expect(await within(sheet).findByText("Escribe un título.")).toBeInTheDocument();
    await user.type(within(sheet).getByRole("textbox", { name: /Título/ }), "Bodas de la familia");
    await user.type(within(sheet).getByRole("textbox", { name: /Descripción/ }), "De 1960 en adelante.");
    await user.click(within(sheet).getByRole("button", { name: "Crear baúl" }));
    expect(await screen.findByText("Creaste Bodas de la familia.")).toBeInTheDocument();
    expect(db.bodies.get("POST /admin/memory-albums")).toEqual({ title: "Bodas de la familia", description: "De 1960 en adelante.", status: "draft" });
    expect(await screen.findByRole("link", { name: "Bodas de la familia" })).toHaveAttribute("href", `/recuerdos/${memoryId(1)}`);
  });

  it("publishes a draft at once and asks before hiding a published box", async () => {
    db.boxes = [makeBox(1), makeBox(2, { status: "draft" })];
    const user = userEvent.setup();
    renderApp(PATH, admin());
    await screen.findByRole("list", { name: "Baúles" });
    await user.click(within(rows()[1] as HTMLElement).getByRole("button", { name: "Publicar" }));
    expect(await screen.findByText("Publicaste Fotos antiguas 2.")).toBeInTheDocument();
    expect(db.bodies.get(`PATCH /admin/memory-albums/${memoryId(2)}`)).toEqual({ status: "published" });

    await user.click(within(rows()[0] as HTMLElement).getByRole("button", { name: "Ocultar" }));
    const confirm = await screen.findByRole("alertdialog", { name: "¿Ocultar Fotos antiguas 1?" });
    expect(within(confirm).getByText(/ni sus fotos, etiquetas, corazones o comentarios/)).toBeInTheDocument();
    await user.click(within(confirm).getByRole("button", { name: "Ocultar baúl" }));
    expect(await screen.findByText("Ocultaste Fotos antiguas 1.")).toBeInTheDocument();
    expect(db.bodies.get(`PATCH /admin/memory-albums/${memoryId(1)}`)).toEqual({ status: "hidden" });
  });

  it("reorders with ↑ / ↓ and saves every id in the new order", async () => {
    db.boxes = [makeBox(1), makeBox(2), makeBox(3)];
    const user = userEvent.setup();
    renderApp(PATH, admin());
    await screen.findByRole("list", { name: "Baúles" });
    await user.click(screen.getByRole("button", { name: "Bajar Fotos antiguas 1" }));
    await waitFor(() => expect(db.bodies.get("PUT /admin/memory-albums/order")).toEqual({ ids: [memoryId(2), memoryId(1), memoryId(3)] }));
    await waitFor(() => expect(within(rows()[0] as HTMLElement).getByRole("link", { name: "Fotos antiguas 2" })).toBeInTheDocument());
  });

  it("edits the title and picks the cover from the box's own photos", async () => {
    const box = makeBox(1, { mediaCount: 2 });
    db.boxes = [box];
    db.media.set(box.id, [makeBoxMedia(1, box), makeBoxMedia(2, box), makeBoxMedia(3, box, { kind: "video", mimeType: "video/mp4" })]);
    const user = userEvent.setup();
    renderApp(PATH, admin());
    await user.click(await screen.findByRole("button", { name: "Editar" }));
    const sheet = await screen.findByRole("dialog", { name: "Editar Fotos antiguas 1" });
    const title = within(sheet).getByRole("textbox", { name: /Título/ });
    await user.clear(title);
    await user.type(title, "La casa de los abuelos");
    expect(within(sheet).getByRole("radio", { name: /Automática/ })).toBeChecked();
    // Videos are not offered as covers.
    expect(await within(sheet).findAllByRole("radio", { name: /^Portada:/ })).toHaveLength(2);
    await user.click(within(sheet).getByRole("radio", { name: "Portada: Foto número 2" }));
    await user.click(within(sheet).getByRole("button", { name: "Guardar" }));
    expect(await screen.findByText("Cambios guardados.")).toBeInTheDocument();
    expect(db.bodies.get(`PATCH /admin/memory-albums/${box.id}`)).toEqual({
      title: "La casa de los abuelos",
      description: "Escaneadas por la Rama Norte.",
      status: "published",
      coverMediaId: makeBoxMedia(2, box).id
    });
  });

  it("explains MEMORY_ALBUM_NOT_EMPTY when deleting a box with photos", async () => {
    db.boxes = [makeBox(1, { mediaCount: 4 })];
    db.failNext = { status: 409, detailCode: "MEMORY_ALBUM_NOT_EMPTY", message: "Primero borra las fotos y videos del baúl." };
    const user = userEvent.setup();
    renderApp(PATH, admin());
    await user.click(await screen.findByRole("button", { name: "Eliminar" }));
    const confirm = await screen.findByRole("alertdialog", { name: "¿Eliminar Fotos antiguas 1?" });
    expect(within(confirm).getByText(/todavía tiene fotos o videos/)).toBeInTheDocument();
    await user.click(within(confirm).getByRole("button", { name: "Eliminar baúl" }));
    expect(await screen.findByText(/Este baúl todavía tiene fotos o videos. Bórralos primero/)).toBeInTheDocument();
    expect(db.boxes).toHaveLength(1);
  });

  it("deletes an empty box", async () => {
    db.boxes = [makeBox(1)];
    const user = userEvent.setup();
    renderApp(PATH, admin());
    await user.click(await screen.findByRole("button", { name: "Eliminar" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Eliminar baúl" }));
    expect(await screen.findByText("Eliminaste Fotos antiguas 1.")).toBeInTheDocument();
    expect(await screen.findByText("Aún no hay baúles")).toBeInTheDocument();
  });
});
