/**
 * WP-6.2 "Fotos" tab on the person page: loads `GET /family/people/:id/photos`
 * only when chosen, reuses the gallery grid and lightbox. Fictional people only.
 */
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authenticatedState, makeUser } from "../../../../test/auth";
import { createTestServer } from "../../../../test/msw";
import { renderApp } from "../../../../test/renderApp";
import { type FakeGalleryDb, galleryHandlers, makeDb, makeMedia } from "../../gallery/testUtils";
import { type FamilyDb, familyHandlers, IDS, makeFamilyDb } from "../testing/fixtures";

const server = createTestServer();
let family: FamilyDb;
let gallery: FakeGalleryDb;
const me = makeUser({ personId: IDS.jose });

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  family = makeFamilyDb();
  gallery = makeDb();
  server.use(...familyHandlers(family), ...galleryHandlers(gallery));
});
afterEach(() => server.resetHandlers());

describe("Person page Fotos tab", { timeout: 20_000 }, () => {
  it("loads the person's photos only when the tab is chosen and opens them in the lightbox", async () => {
    gallery.personPhotos[IDS.jose] = [makeMedia(1, { caption: "José en la playa" })];
    gallery.media = gallery.personPhotos[IDS.jose] ?? [];
    const user = userEvent.setup();
    renderApp("/arbol", authenticatedState(me));

    await user.click(await screen.findByText("Detalles"));
    expect(gallery.log.some((line) => line.includes("/photos"))).toBe(false);
    await user.click(await screen.findByRole("tab", { name: "Fotos" }));
    await user.click(await screen.findByRole("button", { name: "Ver foto: José en la playa" }, { timeout: 5000 }));
    const viewer = await screen.findByRole("dialog", { name: "Visor de fotos" });
    expect(within(viewer).getByRole("img", { name: "José en la playa" })).toBeInTheDocument();
    expect(gallery.log).toContain(`GET /family/people/${IDS.jose}/photos?limit=30`);
  });

  it("says so when nobody is tagged yet", async () => {
    const user = userEvent.setup();
    renderApp("/arbol", authenticatedState(me));
    await user.click(await screen.findByText("Detalles"));
    await user.click(await screen.findByRole("tab", { name: "Fotos" }));
    expect(await screen.findByText(/Aún no hay fotos de/, {}, { timeout: 5000 })).toBeInTheDocument();
  });
});
