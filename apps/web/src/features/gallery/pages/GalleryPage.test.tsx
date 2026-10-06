import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { apiUrl, authenticatedState, errorBody, makeUser } from "../../../../test/auth";
import { renderApp as renderAppBase } from "../../../../test/renderApp";
import type { AppStore } from "../../../app/store";
import { env } from "../../../shared/lib/env";
import { loggedOut } from "../../auth/authSlice";
import { BUCKET_ORIGIN, type FakeGalleryDb, FakeXhr, galleryHandlers, makeDb, makeEdition, makeGate, makeMedia, SIGNED_PUT_URL, uuid } from "../testUtils";
import { pngOfSize, stubImagePipeline } from "../testing/imageFixtures";
import { getUploadManager } from "../upload/uploadManager";

const MB = 1024 * 1024;
const server = setupServer();
let db: FakeGalleryDb;
const stores: AppStore[] = [];

/** `renderApp` that remembers the store so its upload manager is reset after the test. */
function renderApp(...args: Parameters<typeof renderAppBase>): ReturnType<typeof renderAppBase> {
  const result = renderAppBase(...args);
  stores.push(result.store);
  return result;
}

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  db = makeDb();
  server.use(...galleryHandlers(db));
  FakeXhr.instances = [];
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
  env.mediaUploadOrigin = BUCKET_ORIGIN;
});
afterEach(() => {
  for (const store of stores.splice(0)) getUploadManager(store).reset();
  server.resetHandlers();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  env.mediaUploadOrigin = null;
});

function fileOf(name: string, type: string, size = 1000): File {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

function listRequests(year = 2026): string[] {
  // First-page requests only: the default-year probe uses `limit=1` and later pages add a cursor.
  return db.log.filter((line) => line === `GET /cuencadas/${year}/media?limit=30`);
}

async function waitForXhr(count: number): Promise<FakeXhr> {
  await waitFor(() => expect(FakeXhr.instances.length).toBeGreaterThanOrEqual(count));
  const xhr = FakeXhr.instances[count - 1];
  if (!xhr) throw new Error("missing XHR");
  return xhr;
}

/** Picks files and confirms the staging sheet. */
async function pickAndUpload(user: ReturnType<typeof userEvent.setup>, files: File[], caption?: string): Promise<void> {
  await screen.findByRole("heading", { name: /Álbum vivo 2026/ });
  await user.upload(screen.getByTestId("gallery-file-input"), files);
  const sheet = await screen.findByRole("dialog", { name: /Subir/ });
  if (caption !== undefined) await user.type(within(sheet).getByLabelText(/Descripción/), caption);
  await user.click(within(sheet).getByRole("button", { name: /^Subir/ }));
}

describe("GalleryPage grid", () => {
  it("renders lazy thumbnails with explicit dimensions", async () => {
    db.media = [makeMedia(1), makeMedia(2, { kind: "video", mimeType: "video/mp4" })];
    renderApp("/galeria/2026", authenticatedState());

    const tile = await screen.findByRole("button", { name: "Ver foto: Foto número 1" });
    const img = tile.querySelector("img");
    expect(img).toHaveAttribute("src", "https://bucket.example/thumb-1.webp?X-Amz-Signature=t1");
    expect(img).toHaveAttribute("loading", "lazy");
    expect(img).toHaveAttribute("decoding", "async");
    expect(img).toHaveAttribute("width", "400");
    expect(img).toHaveAttribute("height", "400");
    expect(screen.getByRole("button", { name: "Ver video: Foto número 2" })).toBeInTheDocument();
  });

  it("shows the empty state with an upload action when the year has no media", async () => {
    renderApp("/galeria/2026", authenticatedState());

    expect(await screen.findByRole("heading", { name: "Aún no hay fotos de este año. ¡Sé el primero en subir!" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Subir fotos y videos/ }).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/Las cámaras de acción y drones pueden guardar ubicación en el video\./)).toBeInTheDocument();
  });

  it("redirects /galeria to the newest edition that has media", async () => {
    db.media = [makeMedia(1, { year: 2025 })];
    const { router } = renderApp("/galeria", authenticatedState());

    await waitFor(() => expect(router.state.location.pathname).toBe("/galeria/2025"));
    expect(await screen.findByRole("heading", { name: "Álbum vivo 2025" })).toBeInTheDocument();
  });

  it("picks the default year from CuencadaSummary.hasMedia without probing each year", async () => {
    db.media = [makeMedia(1, { year: 2025 })];
    const { router } = renderApp("/galeria", authenticatedState());

    await waitFor(() => expect(router.state.location.pathname).toBe("/galeria/2025"));
    expect(db.log.filter((line) => line.includes("limit=1"))).toEqual([]);
    expect(db.log.filter((line) => line === "GET /cuencadas")).toHaveLength(1);
  });

  it("falls back to the newest started edition when no year has media", async () => {
    db.editions = [makeEdition(2027, "2099-09-13T12:00:00.000Z"), makeEdition(2026)];
    const { router } = renderApp("/galeria", authenticatedState());

    await waitFor(() => expect(router.state.location.pathname).toBe("/galeria/2026"));
  });

  it("switches years with the selector", async () => {
    const user = userEvent.setup();
    const { router } = renderApp("/galeria/2026", authenticatedState());

    await user.selectOptions(await screen.findByLabelText("Año del álbum"), "2025");
    expect(router.state.location.pathname).toBe("/galeria/2025");
  });

  it("loads the next page by cursor and appends it", async () => {
    db.media = Array.from({ length: 35 }, (_, i) => makeMedia(i + 1));
    const user = userEvent.setup();
    renderApp("/galeria/2026", authenticatedState());

    await screen.findByRole("button", { name: "Ver foto: Foto número 30" });
    expect(screen.queryByRole("button", { name: "Ver foto: Foto número 31" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cargar más" }));

    expect(await screen.findByRole("button", { name: "Ver foto: Foto número 35" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ver foto: Foto número 1" })).toBeInTheDocument();
    expect(db.log).toContain("GET /cuencadas/2026/media?limit=30&cursor=30");
    expect(screen.queryByRole("button", { name: "Cargar más" })).not.toBeInTheDocument();
  });

  it("opens the Lightbox with the display URL, caption and uploader line", async () => {
    db.media = [makeMedia(1), makeMedia(2)];
    const user = userEvent.setup();
    renderApp("/galeria/2026", authenticatedState());

    await user.click(await screen.findByRole("button", { name: "Ver foto: Foto número 2" }));

    const viewer = await screen.findByRole("dialog", { name: "Visor de fotos" });
    expect(within(viewer).getByRole("img", { name: "Foto número 2" })).toHaveAttribute("src", "https://bucket.example/display-2.webp?X-Amz-Signature=d2");
    expect(within(viewer).getByText("2 de 2")).toBeInTheDocument();
    expect(within(viewer).getByText(/^Subida por Rosa · 14 sept?\.?$/)).toBeInTheDocument();
  });

  it("plays videos with controls in the Lightbox", async () => {
    db.media = [makeMedia(1, { kind: "video", mimeType: "video/mp4", displayUrl: "https://bucket.example/v.mp4" })];
    const user = userEvent.setup();
    renderApp("/galeria/2026", authenticatedState());

    await user.click(await screen.findByRole("button", { name: /Ver video/ }));
    const viewer = await screen.findByRole("dialog", { name: "Visor de fotos" });
    const video = viewer.querySelector("video");
    expect(video).toHaveAttribute("src", "https://bucket.example/v.mp4");
    expect(video).toHaveAttribute("controls");
  });

  it("refetches the list once when a thumbnail URL has expired", async () => {
    db.media = [makeMedia(1)];
    renderApp("/galeria/2026", authenticatedState());

    const img = (await screen.findByRole("button", { name: "Ver foto: Foto número 1" })).querySelector("img");
    if (!img) throw new Error("no img");
    expect(listRequests()).toHaveLength(1);

    db.media = [makeMedia(1, { thumbUrl: "https://bucket.example/fresh.webp" })];
    fireEvent.error(img);
    await waitFor(() => expect(listRequests()).toHaveLength(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "Ver foto: Foto número 1" }).querySelector("img")).toHaveAttribute("src", "https://bucket.example/fresh.webp"));

    // A second failure right away (a genuinely broken file) does not loop.
    const fresh = screen.getByRole("button", { name: "Ver foto: Foto número 1" }).querySelector("img");
    if (!fresh) throw new Error("no img");
    fireEvent.error(fresh);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(listRequests()).toHaveLength(2);
  });

  it("refetches when the Lightbox image fails to load", async () => {
    db.media = [makeMedia(1)];
    const user = userEvent.setup();
    renderApp("/galeria/2026", authenticatedState());

    await user.click(await screen.findByRole("button", { name: "Ver foto: Foto número 1" }));
    const viewer = await screen.findByRole("dialog", { name: "Visor de fotos" });
    fireEvent.error(within(viewer).getByRole("img", { name: "Foto número 1" }));

    await waitFor(() => expect(listRequests()).toHaveLength(2));
  });
});

describe("GalleryPage access", () => {
  it("asks an unverified member to verify the email on 403 instead of offering a retry", async () => {
    server.use(http.get(apiUrl("/cuencadas/:year/media"), () => HttpResponse.json(errorBody("FORBIDDEN", "No."), { status: 403 })));
    renderApp("/galeria/2026", authenticatedState(makeUser({ emailVerified: false })));

    expect(await screen.findByRole("heading", { name: "Verifica tu correo para ver el álbum" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reintentar" })).not.toBeInTheDocument();
  });

  it("says access is closed for any other 403", async () => {
    server.use(http.get(apiUrl("/cuencadas/:year/media"), () => HttpResponse.json(errorBody("FORBIDDEN", "No."), { status: 403 })));
    renderApp("/galeria/2026", authenticatedState());

    expect(await screen.findByRole("heading", { name: "No tienes acceso al álbum" })).toBeInTheDocument();
  });
});

describe("GalleryPage processing", () => {
  it("polls only the first page every 5s while an item is processing and stops when none are", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    db.media = [makeMedia(1, { isMine: true, uploadStatus: "processing", thumbUrl: null, displayUrl: null }), ...Array.from({ length: 34 }, (_, i) => makeMedia(i + 2))];
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderApp("/galeria/2026", authenticatedState());

    expect(await screen.findByText("Procesando…")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cargar más" }));
    await screen.findByRole("button", { name: "Ver foto: Foto número 35" });
    // The infinite list's first page plus the poll's immediate first fetch.
    await waitFor(() => expect(listRequests()).toHaveLength(2));
    const nextPages = (): number => db.log.filter((line) => line.includes("cursor=")).length;
    expect(nextPages()).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    await waitFor(() => expect(listRequests()).toHaveLength(3));
    expect(nextPages()).toBe(1);

    const first = db.media[0];
    if (!first) throw new Error("fixture");
    db.media[0] = { ...first, uploadStatus: "ready", thumbUrl: "https://bucket.example/t.webp", displayUrl: "https://bucket.example/d.webp" };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    await waitFor(() => expect(listRequests()).toHaveLength(4));
    // The fresh first page is patched into the list: the tile is ready without reloading page 2.
    await waitFor(() => expect(screen.queryByText("Procesando…")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Ver foto: Foto número 35" })).toBeInTheDocument();
    expect(nextPages()).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(listRequests()).toHaveLength(4);
  });
});

describe("GalleryPage uploads", () => {
  it("rejects wrong types and oversize files client-side with Spanish reasons", async () => {
    const user = userEvent.setup({ applyAccept: false });
    renderApp("/galeria/2026", authenticatedState());
    await screen.findByRole("heading", { name: /Álbum vivo 2026/ });

    await user.upload(screen.getByTestId("gallery-file-input"), [
      fileOf("notas.pdf", "application/pdf"),
      fileOf("IMG_1.HEIC", "image/heic"),
      fileOf("enorme.jpg", "image/jpeg", 26 * MB),
      fileOf("largo.mp4", "video/mp4", 301 * MB)
    ]);

    const sheet = await screen.findByRole("dialog", { name: "No se puede subir" });
    expect(within(sheet).getByText("Solo se pueden subir fotos (JPG, PNG o WebP) y videos (MP4 o MOV).")).toBeInTheDocument();
    expect(within(sheet).getByText(/iPhone convierte automáticamente a JPG al subir desde el navegador/)).toBeInTheDocument();
    expect(within(sheet).getByText("Esta foto pesa más de 25 MB.")).toBeInTheDocument();
    expect(within(sheet).getByText(/Este video pesa más de 300 MB/)).toBeInTheDocument();
    await user.click(within(sheet).getByRole("button", { name: "Entendido" }));
    expect(db.log.some((line) => line.includes("/media/uploads"))).toBe(false);
    expect(FakeXhr.instances).toHaveLength(0);
  });

  it("uploads a 48 MP iPhone photo as is when the canvas can't be created (iOS area cap)", async () => {
    stubImagePipeline({ width: 8064, height: 6048 }, { canvasFails: true });
    const user = userEvent.setup();
    const file = pngOfSize(8064, 6048, "IMG_48MP.png");
    renderApp("/galeria/2026", authenticatedState());

    await pickAndUpload(user, [file]);

    const xhr = await waitForXhr(1);
    expect(db.bodies["POST uploads IMG_48MP.png"]).toMatchObject({ mimeType: "image/png", byteSize: file.size });
    expect(xhr.body).toBe(file);
  });

  it("downscales a photo above 40 MP to a ≤ 16 MP JPEG before the intent", async () => {
    const fake = stubImagePipeline({ width: 16320, height: 12240 }, 4321);
    const user = userEvent.setup();
    renderApp("/galeria/2026", authenticatedState());
    expect(await screen.findByText(/Reducimos fotos muy grandes para subirlas más rápido\./)).toBeInTheDocument();

    await pickAndUpload(user, [pngOfSize(16320, 12240, "IMG_200MP.png")]);

    const xhr = await waitForXhr(1);
    expect(db.bodies["POST uploads IMG_200MP.jpg"]).toEqual({ fileName: "IMG_200MP.jpg", mimeType: "image/jpeg", byteSize: 4321, caption: null });
    expect(xhr.body).toBeInstanceOf(File);
    expect((xhr.body as File).type).toBe("image/jpeg"); // The PUT body is the File the manager prepared.
    expect(fake.closed).toBe(1);
  });

  it("leaves a photo within 40 MP untouched", async () => {
    stubImagePipeline({ width: 6000, height: 4000 });
    const user = userEvent.setup();
    const file = pngOfSize(6000, 4000, "IMG_24MP.png");
    renderApp("/galeria/2026", authenticatedState());

    await pickAndUpload(user, [file]);

    const xhr = await waitForXhr(1);
    expect(db.bodies["POST uploads IMG_24MP.png"]).toMatchObject({ mimeType: "image/png", byteSize: file.size });
    expect(xhr.body).toBe(file);
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it("fails the row with a Spanish message when a huge photo can't be decoded, without an intent", async () => {
    stubImagePipeline("fail");
    const user = userEvent.setup();
    renderApp("/galeria/2026", authenticatedState());

    await pickAndUpload(user, [pngOfSize(16000, 12000, "rota.png")]);

    expect(await screen.findByText(/No pudimos leer esta foto/)).toBeInTheDocument();
    expect(db.log.some((line) => line.includes("/media/uploads"))).toBe(false);
  });

  it("creates an intent, PUTs only the signed headers with progress, then confirms", async () => {
    db.confirmStatus = "ready";
    const user = userEvent.setup();
    const file = fileOf("IMG_2041.jpg", "image/jpeg", 2 * MB);
    renderApp("/galeria/2026", authenticatedState());

    await pickAndUpload(user, [file], "La abuela en Izamal");

    const xhr = await waitForXhr(1);
    expect(db.bodies["POST uploads IMG_2041.jpg"]).toEqual({ fileName: "IMG_2041.jpg", mimeType: "image/jpeg", byteSize: 2 * MB, caption: "La abuela en Izamal" });
    expect(xhr.method).toBe("PUT");
    expect(xhr.url).toBe(SIGNED_PUT_URL);
    expect(xhr.headers).toEqual({ "Content-Type": "image/jpeg" });
    expect(xhr.withCredentials).toBe(false);
    expect(xhr.body).toBe(file);

    act(() => xhr.progress(MB, 2 * MB));
    expect(await screen.findByText("Subiendo 50%")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Progreso de IMG_2041.jpg" })).toHaveAttribute("value", "50");
    expect(db.log.some((line) => line.includes("/confirm"))).toBe(false);

    act(() => xhr.respond(200));
    expect(await screen.findByText("✅ Lista")).toBeInTheDocument();
    expect(db.log.filter((line) => line.endsWith("/confirm"))).toHaveLength(1);
    // The confirmed item goes to the top of the grid without reloading the list.
    expect(await screen.findByRole("list", { name: "Fotos y videos" })).toBeInTheDocument();
    expect(listRequests()).toHaveLength(1);
  });

  it("shows Procesando… after confirm until the item is ready", async () => {
    const user = userEvent.setup();
    renderApp("/galeria/2026", authenticatedState());
    await pickAndUpload(user, [fileOf("IMG_1.jpg", "image/jpeg")]);

    act(() => FakeXhr.instances[0]?.respond(200));
    const panel = await screen.findByRole("region", { name: /listas?/ });
    expect(await within(panel).findByText("Procesando…")).toBeInTheDocument();
  });

  it("retries a failed PUT with the same intent and never shows the signed URL", async () => {
    db.confirmStatus = "ready";
    const user = userEvent.setup();
    renderApp("/galeria/2026", authenticatedState());
    await pickAndUpload(user, [fileOf("IMG_1.jpg", "image/jpeg")]);

    act(() => FakeXhr.instances[0]?.respond(500));
    expect(await screen.findByText(/⚠️ No se pudo subir/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("bucket.example");
    expect(document.body.textContent).not.toContain("X-Amz-Signature=supersecret");

    await user.click(screen.getByRole("button", { name: "Reintentar" }));
    const retry = await waitForXhr(2);
    expect(db.log.filter((line) => line.includes("/media/uploads"))).toHaveLength(1);
    act(() => retry.respond(200));
    expect(await screen.findByText("✅ Lista")).toBeInTheDocument();
  });

  it("asks for a new intent when the bucket refuses the signature", async () => {
    const user = userEvent.setup();
    renderApp("/galeria/2026", authenticatedState());
    await pickAndUpload(user, [fileOf("IMG_1.jpg", "image/jpeg")]);

    act(() => FakeXhr.instances[0]?.respond(403));
    expect(await screen.findByText(/El permiso de subida venció/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Reintentar" }));
    await waitForXhr(2);
    expect(db.log.filter((line) => line.includes("/media/uploads"))).toHaveLength(2);
  });

  it("cancels during the PUT: aborts the XHR, never confirms and deletes the pending upload", async () => {
    const user = userEvent.setup();
    renderApp("/galeria/2026", authenticatedState());
    await pickAndUpload(user, [fileOf("IMG_9.jpg", "image/jpeg")]);
    const xhr = await waitForXhr(1);

    await user.click(screen.getByRole("button", { name: "Cancelar IMG_9.jpg" }));

    expect(xhr.aborted).toBe(true);
    expect(screen.queryByText("IMG_9.jpg", { exact: false })).not.toBeInTheDocument();
    await waitFor(() => expect(db.log).toContain(`DELETE /media/${uuid(1001)}`));
    expect(db.log.some((line) => line.includes("/confirm"))).toBe(false);
  });

  it("cancels while the intent is pending: no PUT and no confirm", async () => {
    const gate = makeGate();
    db.holdUploads = gate.promise;
    const user = userEvent.setup();
    renderApp("/galeria/2026", authenticatedState());
    await pickAndUpload(user, [fileOf("IMG_7.jpg", "image/jpeg")]);
    await screen.findByText("Preparando…");

    await user.click(screen.getByRole("button", { name: "Cancelar IMG_7.jpg" }));
    expect(screen.queryByText("IMG_7.jpg", { exact: false })).not.toBeInTheDocument();
    gate.release();

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(FakeXhr.instances).toHaveLength(0);
    expect(db.log.some((line) => line.includes("/confirm"))).toBe(false);
  });

  it("keeps a cancelled job's slot until its intent request has settled", async () => {
    const gate = makeGate();
    db.holdUploads = gate.promise;
    const user = userEvent.setup();
    const { store } = renderApp("/galeria/2026", authenticatedState());
    await pickAndUpload(user, [fileOf("a.jpg", "image/jpeg"), fileOf("b.jpg", "image/jpeg"), fileOf("c.jpg", "image/jpeg")]);
    await waitFor(() => expect(db.log.filter((line) => line.includes("/media/uploads"))).toHaveLength(2));

    await user.click(screen.getByRole("button", { name: "Cancelar a.jpg" }));
    // a.jpg's request is aborted (it settles as an abort), so c.jpg may start; never a fourth request.
    db.holdUploads = null;
    gate.release();
    await waitForXhr(2);
    expect(getUploadManager(store).getSnapshot().map((u) => u.fileName)).toEqual(["b.jpg", "c.jpg"]);
    expect(db.log.filter((line) => line.includes("/media/uploads"))).toHaveLength(3);
  });

  it("does not offer cancel while confirming", async () => {
    const gate = makeGate();
    db.holdConfirm = gate.promise;
    const user = userEvent.setup();
    renderApp("/galeria/2026", authenticatedState());
    await pickAndUpload(user, [fileOf("IMG_5.jpg", "image/jpeg")]);
    const xhr = await waitForXhr(1);
    expect(screen.getByRole("button", { name: "Cancelar IMG_5.jpg" })).toBeInTheDocument();

    act(() => xhr.respond(200));
    expect(await screen.findByText("Verificando…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancelar IMG_5.jpg" })).not.toBeInTheDocument();
    gate.release();
    expect(await screen.findByText("Procesando…", { selector: "p" })).toBeInTheDocument();
  });

  it("never starts a retried upload twice", async () => {
    db.confirmStatus = "ready";
    const user = userEvent.setup();
    renderApp("/galeria/2026", authenticatedState());
    await pickAndUpload(user, [fileOf("a.jpg", "image/jpeg"), fileOf("b.jpg", "image/jpeg")]);
    const [first, second] = [await waitForXhr(1), await waitForXhr(2)];

    act(() => first.respond(500));
    await user.click(await screen.findByRole("button", { name: "Reintentar" }));
    // b.jpg finishing runs the queue again while a.jpg's retry is starting.
    act(() => second.respond(200));
    const retry = await waitForXhr(3);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(FakeXhr.instances).toHaveLength(3);

    act(() => retry.respond(200));
    await waitFor(() => expect(screen.getAllByText("✅ Lista")).toHaveLength(2));
    expect(db.log.filter((line) => line.endsWith("/confirm"))).toHaveLength(2);
    expect(db.log.filter((line) => line.includes("/media/uploads"))).toHaveLength(2);
  });

  it("aborts on logout while the intent is pending: no PUT", async () => {
    const gate = makeGate();
    db.holdUploads = gate.promise;
    const user = userEvent.setup();
    const { store } = renderApp("/galeria/2026", authenticatedState());
    await pickAndUpload(user, [fileOf("IMG_3.jpg", "image/jpeg")]);
    await screen.findByText("Preparando…");

    act(() => {
      store.dispatch(loggedOut());
    });
    gate.release();

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(FakeXhr.instances).toHaveLength(0);
    expect(getUploadManager(store).getSnapshot()).toHaveLength(0);
  });

  it.each([
    ["an http: URL", "http://bucket.example/uploads/obj-1?X-Amz-Signature=s"],
    ["a malformed URL", "not a url"],
    ["a foreign https origin", "https://attacker.example/steal?X-Amz-Signature=s"],
    ["credentials in the URL", "https://user:pass@bucket.example/obj"]
  ])("refuses an intent with %s and never PUTs", async (_label, uploadUrl) => {
    db.uploadUrl = uploadUrl;
    const user = userEvent.setup();
    renderApp("/galeria/2026", authenticatedState());
    await pickAndUpload(user, [fileOf("IMG_1.jpg", "image/jpeg")]);

    expect(await screen.findByText(/No se pudo subir\. Algo salió mal/)).toBeInTheDocument();
    expect(FakeXhr.instances).toHaveLength(0);
    expect(document.body.textContent).not.toContain("attacker.example");
  });

  it("disables uploading, with Spanish copy and a dev hint, when no bucket origin is configured", async () => {
    env.mediaUploadOrigin = null;
    renderApp("/galeria/2026", authenticatedState());

    const button = await screen.findByRole("button", { name: /Subir fotos y videos/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(/Por ahora no se pueden subir fotos ni videos\. Avísale a un administrador\./);
    expect(screen.getByText(/falta VITE_MEDIA_UPLOAD_ORIGIN/)).toBeInTheDocument();
  });

  it("never asks for an upload intent when no bucket origin is configured (no orphan rows)", async () => {
    env.mediaUploadOrigin = null;
    const user = userEvent.setup();
    renderApp("/galeria/2026", authenticatedState());
    await pickAndUpload(user, [fileOf("IMG_1.jpg", "image/jpeg")]);

    expect(await screen.findByText(/⚠️ No se pudo subir/)).toBeInTheDocument();
    expect(db.log.some((line) => line.startsWith("POST /cuencadas/2026/media/uploads"))).toBe(false);
    expect(FakeXhr.instances).toHaveLength(0);
  });

  it("announces a failed file by name", async () => {
    const user = userEvent.setup();
    renderApp("/galeria/2026", authenticatedState());
    await pickAndUpload(user, [fileOf("IMG_2042.jpg", "image/jpeg")]);

    act(() => FakeXhr.instances[0]?.respond(500));
    const live = await screen.findByText("No se pudo subir IMG_2042.jpg.");
    expect(live).toHaveAttribute("aria-live", "polite");
  });

  it("resolves uploads for a year the user navigated away from", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { router } = renderApp("/galeria/2026", authenticatedState());
    await pickAndUpload(user, [fileOf("viaje.jpg", "image/jpeg")]);
    const xhr = await waitForXhr(1);
    act(() => xhr.respond(200));
    await screen.findByText("Procesando…", { selector: "p" });

    await act(async () => {
      await router.navigate("/galeria/2025");
    });
    await screen.findByRole("heading", { name: "Álbum vivo 2025" });
    const confirmed = db.media[0];
    if (!confirmed) throw new Error("fixture");
    db.media[0] = { ...confirmed, uploadStatus: "ready", thumbUrl: "https://bucket.example/t.webp", displayUrl: "https://bucket.example/d.webp" };

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(await screen.findByText("✅ Lista")).toBeInTheDocument();
  });

  it("runs at most two uploads at once", async () => {
    db.confirmStatus = "ready";
    const user = userEvent.setup();
    renderApp("/galeria/2026", authenticatedState());
    await pickAndUpload(user, [fileOf("a.jpg", "image/jpeg"), fileOf("b.jpg", "image/jpeg"), fileOf("c.jpg", "image/jpeg")]);

    const first = await waitForXhr(2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(FakeXhr.instances).toHaveLength(2);
    expect(screen.getByText("En espera…")).toBeInTheDocument();

    act(() => first.respond(200));
    await waitForXhr(3);
  });

  it("warns before leaving the page while an upload is in flight", async () => {
    const user = userEvent.setup();
    renderApp("/galeria/2026", authenticatedState());
    await pickAndUpload(user, [fileOf("a.jpg", "image/jpeg")]);
    const xhr = await waitForXhr(1);

    const during = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(during);
    expect(during.defaultPrevented).toBe(true);

    act(() => xhr.respond(200));
    await screen.findByText("Procesando…", { selector: "p" });
    const after = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it("keeps the upload list when switching years and clears it on logout", async () => {
    const user = userEvent.setup();
    const { store, router } = renderApp("/galeria/2026", authenticatedState());
    await pickAndUpload(user, [fileOf("viaje.jpg", "image/jpeg")]);
    const xhr = await waitForXhr(1);

    await act(async () => {
      await router.navigate("/galeria/2025");
    });
    expect(await screen.findByText("📷 viaje.jpg (2026)")).toBeInTheDocument();

    act(() => {
      store.dispatch(loggedOut());
    });
    expect(xhr.aborted).toBe(true);
    expect(getUploadManager(store).getSnapshot()).toHaveLength(0);
  });
});

describe("GalleryPage item actions", () => {
  it("lets the owner edit the caption and delete, but not report", async () => {
    db.media = [makeMedia(1, { isMine: true })];
    const user = userEvent.setup();
    renderApp("/galeria/2026", authenticatedState());

    await user.click(await screen.findByRole("button", { name: "Ver foto: Foto número 1" }));
    const viewer = await screen.findByRole("dialog", { name: "Visor de fotos" });
    expect(within(viewer).queryByRole("button", { name: "Reportar" })).not.toBeInTheDocument();

    await user.click(within(viewer).getByRole("button", { name: "Editar descripción" }));
    const edit = await screen.findByRole("dialog", { name: "Editar descripción" });
    const field = within(edit).getByLabelText(/Descripción/);
    await user.clear(field);
    await user.type(field, "  Cenote Ik Kil  ");
    await user.click(within(edit).getByRole("button", { name: "Guardar" }));
    expect(await screen.findByText("Descripción guardada.")).toBeInTheDocument();
    expect(db.bodies[`PATCH ${db.media[0]?.id}`]).toEqual({ caption: "Cenote Ik Kil" });
    // Optimistic and patched in place: no list reload.
    expect(await within(viewer).findByText("Cenote Ik Kil")).toBeInTheDocument();
    expect(listRequests()).toHaveLength(1);

    await user.click(within(viewer).getByRole("button", { name: "Eliminar" }));
    const confirm = await screen.findByRole("alertdialog", { name: "¿Eliminar esta foto?" });
    await user.click(within(confirm).getByRole("button", { name: "Eliminar" }));
    expect(await screen.findByText("Foto eliminada.")).toBeInTheDocument();
    expect(db.log.some((line) => line.startsWith("DELETE /media/"))).toBe(true);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Visor de fotos" })).not.toBeInTheDocument());
  });

  it("lets another member report but not edit or delete", async () => {
    db.media = [makeMedia(1, { isMine: false })];
    const user = userEvent.setup();
    renderApp("/galeria/2026", authenticatedState());

    await user.click(await screen.findByRole("button", { name: "Ver foto: Foto número 1" }));
    const viewer = await screen.findByRole("dialog", { name: "Visor de fotos" });
    expect(within(viewer).queryByRole("button", { name: "Editar descripción" })).not.toBeInTheDocument();
    expect(within(viewer).queryByRole("button", { name: "Eliminar" })).not.toBeInTheDocument();

    await user.click(within(viewer).getByRole("button", { name: "Reportar" }));
    const sheet = await screen.findByRole("dialog", { name: "¿Por qué quieres reportar esta foto?" });
    await user.click(within(sheet).getByRole("button", { name: "Enviar reporte" }));
    expect(within(sheet).getByText("Elige un motivo.")).toBeInTheDocument();

    await user.selectOptions(within(sheet).getByLabelText(/Motivo/), "privacy");
    await user.click(within(sheet).getByRole("button", { name: "Enviar reporte" }));
    expect(await screen.findByText("Gracias. Un administrador la revisará.")).toBeInTheDocument();
    expect(db.bodies[`REPORT ${db.media[0]?.id}`]).toEqual({ reason: "privacy", details: null });
  });

  it("lets an admin edit and delete someone else's item", async () => {
    db.media = [makeMedia(1, { isMine: false, canEdit: true, canDelete: true })];
    const user = userEvent.setup();
    renderApp("/galeria/2026", authenticatedState(makeUser({ role: "admin" })));

    await user.click(await screen.findByRole("button", { name: "Ver foto: Foto número 1" }));
    const viewer = await screen.findByRole("dialog", { name: "Visor de fotos" });
    expect(within(viewer).getByRole("button", { name: "Editar descripción" })).toBeInTheDocument();
    expect(within(viewer).getByRole("button", { name: "Eliminar" })).toBeInTheDocument();
  });
});
