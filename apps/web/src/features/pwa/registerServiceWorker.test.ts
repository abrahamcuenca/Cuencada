import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerServiceWorker, SW_URL } from "./registerServiceWorker";

type Listener = () => void;

/** Minimal Workbox stand-in: records listeners, lets the test fire them. */
function makeFakeWorkbox(registerResult: Promise<undefined> = Promise.resolve(undefined)) {
  const listeners = new Map<string, Listener[]>();
  return {
    listeners,
    fire(type: string): void {
      for (const listener of listeners.get(type) ?? []) listener();
    },
    addEventListener: vi.fn((type: string, listener: Listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    }),
    messageSkipWaiting: vi.fn(),
    register: vi.fn(() => registerResult),
    update: vi.fn(async () => undefined)
  };
}

describe("registerServiceWorker", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: {} });
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, "serviceWorker");
    vi.useRealTimers();
  });

  it("does nothing outside production builds", async () => {
    const createWorkbox = vi.fn();

    await registerServiceWorker({ onNeedRefresh: vi.fn(), onError: vi.fn() }, { enabled: false, createWorkbox });

    expect(createWorkbox).not.toHaveBeenCalled();
  });

  it("does nothing where service workers are unsupported", async () => {
    Reflect.deleteProperty(navigator, "serviceWorker");
    const createWorkbox = vi.fn();

    await registerServiceWorker({ onNeedRefresh: vi.fn(), onError: vi.fn() }, { enabled: true, createWorkbox });

    expect(createWorkbox).not.toHaveBeenCalled();
  });

  it("registers /sw.js and offers the update when a new worker is waiting, without activating it", async () => {
    const wb = makeFakeWorkbox();
    const onNeedRefresh = vi.fn();
    const reload = vi.fn();

    await registerServiceWorker({ onNeedRefresh, onError: vi.fn() }, { enabled: true, createWorkbox: async () => wb, reload });
    wb.fire("waiting");

    expect(wb.register).toHaveBeenCalledOnce();
    expect(onNeedRefresh).toHaveBeenCalledOnce();
    expect(wb.messageSkipWaiting).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("activates the waiting worker on apply and reloads exactly once when it takes control", async () => {
    const wb = makeFakeWorkbox();
    const reload = vi.fn();
    let apply: (() => Promise<void>) | undefined;
    const createWorkbox = vi.fn(async () => wb);

    await registerServiceWorker(
      {
        onNeedRefresh: (applyUpdate) => {
          apply = applyUpdate;
        },
        onError: vi.fn()
      },
      { enabled: true, createWorkbox, reload }
    );
    wb.fire("waiting");
    await apply?.();

    expect(createWorkbox).toHaveBeenCalledWith(SW_URL);
    expect(wb.messageSkipWaiting).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
    wb.fire("controlling");
    wb.fire("controlling");
    expect(reload).toHaveBeenCalledOnce();
  });

  it("reports a failed registration", async () => {
    const error = new Error("blocked");
    const wb = makeFakeWorkbox(Promise.reject(error));
    const onError = vi.fn();

    await registerServiceWorker({ onNeedRefresh: vi.fn(), onError }, { enabled: true, createWorkbox: async () => wb });

    expect(onError).toHaveBeenCalledWith(error);
  });

  it("checks for a new version hourly, only while online", async () => {
    vi.useFakeTimers();
    const wb = makeFakeWorkbox();
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);

    await registerServiceWorker({ onNeedRefresh: vi.fn(), onError: vi.fn() }, { enabled: true, createWorkbox: async () => wb });
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(wb.update).not.toHaveBeenCalled();

    online.mockReturnValue(true);
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(wb.update).toHaveBeenCalledOnce();
    online.mockRestore();
  });
});
