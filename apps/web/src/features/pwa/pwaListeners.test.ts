import { afterEach, describe, expect, it } from "vitest";
import { installPwaListeners, parseSourceMessage } from "./pwaListeners";
import { type BeforeInstallPromptEvent, getPwaState, resetPwaState } from "./pwaState";
import { SW_SOURCE_MESSAGE } from "./swRules";

let uninstall: (() => void) | null = null;

/** jsdom has no service worker container: give it an EventTarget. */
function stubServiceWorkerContainer(): EventTarget {
  const container = new EventTarget();
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: container });
  return container;
}

function sourceMessage(source: string, origin = window.location.origin): MessageEvent {
  return new MessageEvent("message", { data: { type: SW_SOURCE_MESSAGE, source }, origin });
}

afterEach(() => {
  uninstall?.();
  uninstall = null;
  Reflect.deleteProperty(navigator, "serviceWorker");
  resetPwaState();
});

describe("parseSourceMessage", () => {
  it("accepts only well-formed source messages", () => {
    expect(parseSourceMessage({ type: SW_SOURCE_MESSAGE, source: "cache" })).toBe("cache");
    expect(parseSourceMessage({ type: SW_SOURCE_MESSAGE, source: "network" })).toBe("network");
    expect(parseSourceMessage({ type: SW_SOURCE_MESSAGE, source: "evil" })).toBeNull();
    expect(parseSourceMessage({ type: "other", source: "cache" })).toBeNull();
    expect(parseSourceMessage("cache")).toBeNull();
    expect(parseSourceMessage(null)).toBeNull();
  });
});

describe("installPwaListeners", () => {
  it("records where the service worker answered a public read from", () => {
    const container = stubServiceWorkerContainer();
    uninstall = installPwaListeners();

    container.dispatchEvent(sourceMessage("cache"));
    expect(getPwaState().publicApiSource).toBe("cache");

    container.dispatchEvent(sourceMessage("network"));
    expect(getPwaState().publicApiSource).toBe("network");
  });

  it("ignores messages from another origin", () => {
    const container = stubServiceWorkerContainer();
    uninstall = installPwaListeners();

    container.dispatchEvent(sourceMessage("cache", "https://evil.example"));

    expect(getPwaState().publicApiSource).toBeNull();
  });

  it("defers the install prompt and forgets it once the app is installed", () => {
    uninstall = installPwaListeners();
    const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
      prompt: async () => undefined,
      userChoice: Promise.resolve({ outcome: "accepted" as const, platform: "web" })
    }) satisfies BeforeInstallPromptEvent;

    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(getPwaState().installPrompt).toBe(event);

    window.dispatchEvent(new Event("appinstalled"));
    expect(getPwaState().installPrompt).toBeNull();
  });
});
