/** WP-4.7: Home's "Completa tu perfil: foto y contacto" card. Fictional people only. */
import type { OwnProfile } from "@cuencada/types";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { apiUrl, authenticatedState, makeUser, statusState } from "../../../../test/auth";
import { createTestServer } from "../../../../test/msw";
import { renderApp } from "../../../../test/renderApp";
import { COMPLETE_PROFILE_TITLE } from "../../profile/components/CompleteProfileCard";
import { PROFILE_PROMPT_DISMISSED_PREFIX } from "../../profile/lib/completeness";
import { emptyContacts, makeProfile } from "../../profile/testUtils";

let profile: OwnProfile;
let profileRequests = 0;
const server = createTestServer(
  http.get(apiUrl("/profile/me"), () => {
    profileRequests += 1;
    return HttpResponse.json(profile);
  }),
  http.get(apiUrl("/cuencadas/2026/media"), () => HttpResponse.json({ items: [], nextCursor: null }))
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  const base = makeProfile();
  profile = { ...base, contacts: emptyContacts(base) };
  profileRequests = 0;
  window.localStorage.clear();
});
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});

const findCard = (): Promise<HTMLElement> => screen.findByRole("region", { name: COMPLETE_PROFILE_TITLE });

/** Waits for Home to settle (the highlights render with the home query). */
async function homeLoaded(): Promise<void> {
  await screen.findByRole("region", { name: "Todo en un solo lugar" });
}

describe("HomePage · Completa tu perfil", () => {
  it("invites a member with no photo and no contact to complete the profile", async () => {
    renderApp("/", authenticatedState());

    const card = within(await findCard());
    expect(card.getByRole("link", { name: "Completar perfil" })).toHaveAttribute("href", "/perfil");
  });

  it.each<[string, (base: OwnProfile) => OwnProfile]>([
    ["a phone", (base) => ({ ...base, phone: "+525550100101" })],
    ["a network", (base) => ({ ...base, contacts: { ...emptyContacts(base), instagram: "prima.ejemplo" } })],
    ["a profile photo", (base) => ({ ...base, avatarUrl: "https://fake-storage.test/avatars/prima.webp?sig=get" })]
  ])("stays hidden when the profile already has %s", async (_label, change) => {
    profile = change(profile);
    renderApp("/", authenticatedState());

    await homeLoaded();
    await vi.waitFor(() => expect(profileRequests).toBe(1));
    expect(screen.queryByRole("region", { name: COMPLETE_PROFILE_TITLE })).not.toBeInTheDocument();
  });

  it("does not even ask for the profile when /me already has an avatar", async () => {
    renderApp("/", authenticatedState(makeUser({ avatarUrl: "https://fake-storage.test/avatars/prima.webp?sig=get" })));

    await homeLoaded();
    expect(profileRequests).toBe(0);
    expect(screen.queryByRole("region", { name: COMPLETE_PROFILE_TITLE })).not.toBeInTheDocument();
  });

  it("is not shown to anonymous visitors", async () => {
    renderApp("/", statusState("anonymous"));

    await homeLoaded();
    expect(profileRequests).toBe(0);
    expect(screen.queryByRole("region", { name: COMPLETE_PROFILE_TITLE })).not.toBeInTheDocument();
  });

  it("closes for good for this user, remembered per user on this device", async () => {
    const user = makeUser();
    renderApp("/", authenticatedState(user));
    await userEvent.click(within(await findCard()).getByRole("button", { name: /Ocultar la sugerencia/ }));

    expect(screen.queryByRole("region", { name: COMPLETE_PROFILE_TITLE })).not.toBeInTheDocument();
    expect(window.localStorage.getItem(`${PROFILE_PROMPT_DISMISSED_PREFIX}${user.id}`)).toBe("1");
  });

  it("stays closed on the next visit for the user who closed it", async () => {
    const user = makeUser();
    window.localStorage.setItem(`${PROFILE_PROMPT_DISMISSED_PREFIX}${user.id}`, "1");
    renderApp("/", authenticatedState(user));

    await homeLoaded();
    expect(profileRequests).toBe(0);
    expect(screen.queryByRole("region", { name: COMPLETE_PROFILE_TITLE })).not.toBeInTheDocument();
  });

  it("still shows for another user on the same device", async () => {
    const other = makeUser({ id: "0b7e4c1a-2d3f-4a5b-8c6d-7e8f9a0b1c2d", displayName: "Tomás" });
    window.localStorage.setItem(`${PROFILE_PROMPT_DISMISSED_PREFIX}${makeUser().id}`, "1");
    profile = { ...profile, userId: other.id };
    renderApp("/", authenticatedState(other));

    expect(await findCard()).toBeInTheDocument();
  });

  it("still shows and closes for the visit when storage is blocked", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    renderApp("/", authenticatedState());

    await userEvent.click(within(await findCard()).getByRole("button", { name: /Ocultar la sugerencia/ }));
    expect(screen.queryByRole("region", { name: COMPLETE_PROFILE_TITLE })).not.toBeInTheDocument();
  });
});
