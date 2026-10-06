import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppProviders } from "../../app/providers";
import { makeStore } from "../../app/store";
import { authenticatedState } from "../../../test/auth";
import { refreshDeferredOffline } from "../auth/authSlice";
import { OFFLINE_CACHED_TEXT, PwaStatus, SLOW_CACHED_TEXT, UPDATE_AVAILABLE_TEXT, UPDATE_CONFIRM_TEXT } from "./PwaStatus";
import { resetPwaState, updatePwaState } from "./pwaState";
import type { ServiceWorkerCallbacks } from "./registerServiceWorker";

// Registration runs once per page (module flag in startPwa), so keep the callbacks it received.
const registration = vi.hoisted(() => ({ calls: 0, callbacks: null as ServiceWorkerCallbacks | null }));
vi.mock("./registerServiceWorker", () => ({
  registerServiceWorker: async (callbacks: ServiceWorkerCallbacks) => {
    registration.calls += 1;
    registration.callbacks = callbacks;
  }
}));

function renderStatus(): ReturnType<typeof makeStore> {
  const store = makeStore(authenticatedState());
  render(
    <AppProviders store={store}>
      <PwaStatus />
    </AppProviders>
  );
  return store;
}

/** The callbacks PwaStatus handed to the (mocked) registration. Registration happens once per page. */
function registeredCallbacks(): ServiceWorkerCallbacks {
  if (registration.callbacks === null) throw new Error("registerServiceWorker was not called");
  return registration.callbacks;
}

beforeEach(() => {
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  act(() => resetPwaState());
});

describe("PwaStatus", () => {
  it("renders nothing until there is an update or a cached answer, and registers the worker once", () => {
    renderStatus();
    renderStatus();

    expect(registration.calls).toBe(1);
    expect(screen.queryByText(UPDATE_AVAILABLE_TEXT)).not.toBeInTheDocument();
    expect(screen.queryByText(OFFLINE_CACHED_TEXT)).not.toBeInTheDocument();
    expect(screen.queryByText(SLOW_CACHED_TEXT)).not.toBeInTheDocument();
  });

  it("asks before reloading and applies the update only after confirmation", async () => {
    const user = userEvent.setup();
    const applyUpdate = vi.fn(async () => undefined);
    renderStatus();

    act(() => registeredCallbacks().onNeedRefresh(applyUpdate));
    expect(await screen.findByText(UPDATE_AVAILABLE_TEXT)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Actualizar" }));
    expect(screen.getByText(UPDATE_CONFIRM_TEXT)).toBeInTheDocument();
    expect(applyUpdate).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.getByText(UPDATE_AVAILABLE_TEXT)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Actualizar" }));
    await user.click(screen.getByRole("button", { name: "Recargar ahora" }));
    expect(applyUpdate).toHaveBeenCalledOnce();
  });

  it("hides the prompt on Más tarde without applying it", async () => {
    const user = userEvent.setup();
    const applyUpdate = vi.fn(async () => undefined);
    renderStatus();
    act(() => updatePwaState({ applyUpdate }));

    await user.click(await screen.findByRole("button", { name: "Más tarde" }));

    expect(screen.queryByText(UPDATE_AVAILABLE_TEXT)).not.toBeInTheDocument();
    expect(applyUpdate).not.toHaveBeenCalled();
  });

  it("shows the offline notice when the public programa came from the cache while offline", async () => {
    const store = renderStatus();
    act(() => {
      store.dispatch(refreshDeferredOffline());
      updatePwaState({ publicApiSource: "cache" });
    });

    expect(await screen.findByText(OFFLINE_CACHED_TEXT)).toBeInTheDocument();

    act(() => updatePwaState({ publicApiSource: "network" }));
    expect(screen.queryByText(OFFLINE_CACHED_TEXT)).not.toBeInTheDocument();
  });

  it("says the connection is slow when the cache answered while online", async () => {
    renderStatus();
    act(() => updatePwaState({ publicApiSource: "cache" }));

    expect(await screen.findByText(SLOW_CACHED_TEXT)).toBeInTheDocument();
  });
});
