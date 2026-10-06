import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INSTALL_DISMISSED_KEY, isIosDevice } from "./install";
import { IOS_INSTALL_HINT, InstallAppCard } from "./InstallAppCard";
import { type BeforeInstallPromptEvent, getPwaState, resetPwaState, updatePwaState } from "./pwaState";

const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/129.0 Mobile Safari/537.36";
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";

function fakePrompt(outcome: "accepted" | "dismissed"): BeforeInstallPromptEvent {
  const event = new Event("beforeinstallprompt");
  return Object.assign(event, {
    prompt: vi.fn(async () => undefined),
    userChoice: Promise.resolve({ outcome, platform: "web" })
  });
}

function useUserAgent(userAgent: string): void {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
}

afterEach(() => {
  vi.restoreAllMocks();
  act(() => resetPwaState());
});

describe("InstallAppCard", () => {
  it("renders nothing on a browser that offers no install prompt and is not iOS", () => {
    useUserAgent(ANDROID_UA);
    const { container } = render(<InstallAppCard />);

    expect(container).toBeEmptyDOMElement();
  });

  it("opens the deferred install prompt on Instalar", async () => {
    useUserAgent(ANDROID_UA);
    const prompt = fakePrompt("accepted");
    updatePwaState({ installPrompt: prompt });
    const user = userEvent.setup();
    render(<InstallAppCard />);

    await user.click(screen.getByRole("button", { name: "Instalar" }));

    expect(prompt.prompt).toHaveBeenCalledOnce();
    expect(getPwaState().installPrompt).toBeNull();
    expect(window.localStorage.getItem(INSTALL_DISMISSED_KEY)).toBeNull();
  });

  it("remembers a dismissed native prompt so the card does not come back", async () => {
    useUserAgent(ANDROID_UA);
    updatePwaState({ installPrompt: fakePrompt("dismissed") });
    const user = userEvent.setup();
    render(<InstallAppCard />);

    await user.click(screen.getByRole("button", { name: "Instalar" }));

    await vi.waitFor(() => expect(window.localStorage.getItem(INSTALL_DISMISSED_KEY)).toBe("1"));
  });

  it("shows the Compartir → Agregar a inicio hint on iOS", () => {
    useUserAgent(IPHONE_UA);
    render(<InstallAppCard />);

    expect(screen.getByRole("heading", { name: "Instalar app" })).toBeInTheDocument();
    expect(screen.getByText(IOS_INSTALL_HINT)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Instalar" })).not.toBeInTheDocument();
  });

  it("closes for good: the dismissal is stored and honoured on the next visit", async () => {
    useUserAgent(IPHONE_UA);
    const user = userEvent.setup();
    const first = render(<InstallAppCard />);

    await user.click(screen.getByRole("button", { name: "Ocultar la sugerencia de instalar" }));

    expect(screen.queryByRole("heading", { name: "Instalar app" })).not.toBeInTheDocument();
    expect(window.localStorage.getItem(INSTALL_DISMISSED_KEY)).toBe("1");
    first.unmount();
    render(<InstallAppCard />);
    expect(screen.queryByRole("heading", { name: "Instalar app" })).not.toBeInTheDocument();
  });

  it("is hidden when the app already runs installed", () => {
    useUserAgent(IPHONE_UA);
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList); // Only `.matches` is read.
    const { container } = render(<InstallAppCard />);

    expect(container).toBeEmptyDOMElement();
  });
});

describe("isIosDevice", () => {
  it("detects iPhone and iPadOS (Mac UA with touch), not Android or desktop Mac", () => {
    expect(isIosDevice({ userAgent: IPHONE_UA, platform: "iPhone", maxTouchPoints: 5 })).toBe(true);
    expect(isIosDevice({ userAgent: "Mozilla/5.0 (Macintosh)", platform: "MacIntel", maxTouchPoints: 5 })).toBe(true);
    expect(isIosDevice({ userAgent: "Mozilla/5.0 (Macintosh)", platform: "MacIntel", maxTouchPoints: 0 })).toBe(false);
    expect(isIosDevice({ userAgent: ANDROID_UA, platform: "Linux armv8l", maxTouchPoints: 5 })).toBe(false);
  });
});
