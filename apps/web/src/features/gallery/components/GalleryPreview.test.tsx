import { render, screen } from "@testing-library/react";
import { setupServer } from "msw/node";
import { MemoryRouter } from "react-router-dom";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authenticatedState, statusState } from "../../../../test/auth";
import { AppProviders } from "../../../app/providers";
import { makeStore, type RootState } from "../../../app/store";
import { type FakeGalleryDb, galleryHandlers, makeDb, makeMedia } from "../testUtils";
import { GalleryPreview } from "./GalleryPreview";

const server = setupServer();
let db: FakeGalleryDb;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  db = makeDb();
  server.use(...galleryHandlers(db));
});
afterEach(() => server.resetHandlers());

function renderPreview(state: Partial<RootState>): void {
  render(
    <AppProviders store={makeStore(state)}>
      <MemoryRouter>
        <GalleryPreview year={2026} />
      </MemoryRouter>
    </AppProviders>
  );
}

describe("GalleryPreview", () => {
  it("shows up to six thumbnails and links to the album", async () => {
    db.media = Array.from({ length: 8 }, (_, i) => makeMedia(i + 1));
    renderPreview(authenticatedState());

    expect(await screen.findByRole("link", { name: "Foto número 1 (abrir álbum)" })).toHaveAttribute("href", "/galeria/2026");
    expect(screen.getAllByRole("link", { name: /abrir álbum/ })).toHaveLength(6);
    expect(screen.getByRole("link", { name: /Ver álbum/ })).toHaveAttribute("href", "/galeria/2026");
    expect(db.log).toContain("GET /cuencadas/2026/media?limit=6");
  });

  it("invites the first upload when the year is empty", async () => {
    renderPreview(authenticatedState());

    expect(await screen.findByText("Aún no hay fotos de este año. ¡Sé el primero en subir!")).toBeInTheDocument();
  });

  it("renders nothing and calls no API for visitors", () => {
    renderPreview(statusState("anonymous"));

    expect(screen.queryByText(/Álbum vivo/)).not.toBeInTheDocument();
    expect(db.log).toHaveLength(0);
  });
});
