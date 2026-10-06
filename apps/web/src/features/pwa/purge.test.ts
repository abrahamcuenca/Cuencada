import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeStore } from "../../app/store";
import { authenticatedState, makeUser } from "../../../test/auth";
import { credentialsReceived, loggedOut, tokenRefreshed } from "../auth/authSlice";
import { purgeRuntimeCaches, watchSessionEpoch } from "./purge";
import { getPwaState, resetPwaState, updatePwaState } from "./pwaState";
import { startPwa } from "./startPwa";
import { PUBLIC_API_CACHE, SW_PURGE_MESSAGE } from "./swRules";

vi.mock("./registerServiceWorker", () => ({ registerServiceWorker: vi.fn(async () => undefined) }));

interface FakeServiceWorker {
  controllerPost: ReturnType<typeof vi.fn>;
  activePost: ReturnType<typeof vi.fn>;
}

function stubServiceWorker({ sameActive }: { sameActive: boolean }): FakeServiceWorker {
  const controller = { postMessage: vi.fn() };
  const active = sameActive ? controller : { postMessage: vi.fn() };
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      controller,
      getRegistration: vi.fn(async () => ({ active })),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }
  });
  return { controllerPost: controller.postMessage, activePost: active.postMessage };
}

let cacheDelete: ReturnType<typeof vi.fn>;

beforeEach(() => {
  cacheDelete = vi.fn(async () => true);
  vi.stubGlobal("caches", { delete: cacheDelete });
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "serviceWorker");
  resetPwaState();
});

describe("purgeRuntimeCaches", () => {
  it("deletes the runtime cache from the page and asks the controlling worker to do the same", async () => {
    const sw = stubServiceWorker({ sameActive: true });

    await purgeRuntimeCaches();

    expect(cacheDelete).toHaveBeenCalledWith(PUBLIC_API_CACHE);
    expect(sw.controllerPost).toHaveBeenCalledOnce();
    expect(sw.controllerPost).toHaveBeenCalledWith({ type: SW_PURGE_MESSAGE });
  });

  it("also tells an active worker that does not control the tab yet", async () => {
    const sw = stubServiceWorker({ sameActive: false });

    await purgeRuntimeCaches();

    expect(sw.controllerPost).toHaveBeenCalledWith({ type: SW_PURGE_MESSAGE });
    expect(sw.activePost).toHaveBeenCalledWith({ type: SW_PURGE_MESSAGE });
  });

  it("still deletes the caches where service workers are unsupported", async () => {
    await purgeRuntimeCaches();

    expect(cacheDelete).toHaveBeenCalledWith(PUBLIC_API_CACHE);
  });
});

describe("watchSessionEpoch", () => {
  it("fires on logout and on an account switch, not on a same-user refresh", () => {
    const user = makeUser({ id: "11111111-1111-4111-8111-111111111111" });
    const store = makeStore(authenticatedState(user));
    const onChange = vi.fn();
    const stop = watchSessionEpoch(store, onChange);

    store.dispatch(tokenRefreshed({ accessToken: "token-2", user }));
    expect(onChange).not.toHaveBeenCalled();

    store.dispatch(credentialsReceived({ accessToken: "token-3", user: makeUser({ id: "22222222-2222-4222-8222-222222222222" }) }));
    expect(onChange).toHaveBeenCalledTimes(1);

    store.dispatch(loggedOut());
    expect(onChange).toHaveBeenCalledTimes(2);

    stop();
    store.dispatch(loggedOut());
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});

describe("startPwa logout purge", () => {
  it("purges the runtime caches and forgets the offline source when the user logs out", async () => {
    const sw = stubServiceWorker({ sameActive: true });
    const store = makeStore(authenticatedState());
    const stop = startPwa(store);
    updatePwaState({ publicApiSource: "cache" });

    store.dispatch(loggedOut());

    await vi.waitFor(() => expect(cacheDelete).toHaveBeenCalledWith(PUBLIC_API_CACHE));
    expect(sw.controllerPost).toHaveBeenCalledWith({ type: SW_PURGE_MESSAGE });
    expect(getPwaState().publicApiSource).toBeNull();
    stop();
  });

  it("stops watching after cleanup", () => {
    const store = makeStore(authenticatedState());
    startPwa(store)();

    store.dispatch(loggedOut());

    expect(cacheDelete).not.toHaveBeenCalled();
  });
});
