import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { apiUrl, authenticatedState, errorBody, makeUser, tokenBody } from "../../test/auth";
import { LEGACY_DEMO_USER_KEY, removeLegacyDemoSession } from "../features/auth/legacy";
import { cancelOnlineRefreshRetry } from "../shared/api/reauth";
import { clearFragmentToken, readAndScrubFragmentToken } from "../shared/lib/fragmentToken";
import { loggedOut } from "../features/auth/authSlice";
import { bootstrapApp } from "./bootstrap";
import { makeStore } from "./store";

const server = setupServer();
const stops: Array<() => void> = [];

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
afterEach(() => {
  server.resetHandlers();
  cancelOnlineRefreshRetry();
  for (const stop of stops.splice(0)) stop();
});

const legacyDemoUser = JSON.stringify({ id: "demo-admin", role: "admin", email: "admin@cuencada.com" });

describe("removeLegacyDemoSession", () => {
  it("removes only the cuencada-demo-user key and reports it", () => {
    window.localStorage.setItem(LEGACY_DEMO_USER_KEY, legacyDemoUser);
    window.localStorage.setItem("otra-clave", "x");

    expect(removeLegacyDemoSession()).toBe(true);
    expect(window.localStorage.getItem(LEGACY_DEMO_USER_KEY)).toBeNull();
    expect(window.localStorage.getItem("otra-clave")).toBe("x");
  });

  it("returns false when there is nothing to remove", () => {
    expect(removeLegacyDemoSession()).toBe(false);
  });
});

describe("bootstrapApp", () => {
  it("removes the legacy demo key and restores the session through a silent refresh", async () => {
    window.localStorage.setItem(LEGACY_DEMO_USER_KEY, legacyDemoUser);
    const user = makeUser({ displayName: "Abuela Morales" });
    server.use(http.post(apiUrl("/auth/refresh"), () => HttpResponse.json(tokenBody("fresh", user))));
    const store = makeStore();

    stops.push(bootstrapApp(store));

    expect(window.localStorage.getItem(LEGACY_DEMO_USER_KEY)).toBeNull();
    expect(store.getState().auth.status).toBe("restoring");
    await vi.waitFor(() => expect(store.getState().auth.status).toBe("authenticated"));
    expect(store.getState().auth).toMatchObject({ accessToken: "fresh", user });
  });

  it("ends anonymous when there is no valid refresh cookie", async () => {
    server.use(
      http.post(apiUrl("/auth/refresh"), () => HttpResponse.json(errorBody("UNAUTHENTICATED"), { status: 401 }))
    );
    const store = makeStore();

    stops.push(bootstrapApp(store));

    await vi.waitFor(() => expect(store.getState().auth.status).toBe("anonymous"));
  });

  it("stays restoring and flags offline when the server is unreachable, then restores on the online event", async () => {
    server.use(http.post(apiUrl("/auth/refresh"), () => HttpResponse.error()));
    const store = makeStore();

    stops.push(bootstrapApp(store));

    await vi.waitFor(() => expect(store.getState().auth).toMatchObject({ status: "restoring", isOffline: true }));

    server.use(http.post(apiUrl("/auth/refresh"), () => HttpResponse.json(tokenBody("back-online"))));
    window.dispatchEvent(new Event("online"));

    await vi.waitFor(() =>
      expect(store.getState().auth).toMatchObject({ status: "authenticated", accessToken: "back-online", isOffline: false })
    );
  });

  it("scrubs a #t= token from the URL before the router starts and keeps it for its page", async () => {
    const token = "Zt7".repeat(12);
    window.history.replaceState(null, "", `/invitacion?x=1#t=${token}`);
    server.use(http.post(apiUrl("/auth/refresh"), () => HttpResponse.json(errorBody("UNAUTHENTICATED"), { status: 401 })));
    const store = makeStore();

    stops.push(bootstrapApp(store));

    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(token);
    expect(readAndScrubFragmentToken()).toBe(token);
    await vi.waitFor(() => expect(store.getState().auth.status).toBe("anonymous"));
    // The boot-time "not logged in" result must not wipe the stashed invite token.
    expect(readAndScrubFragmentToken()).toBe(token);
    clearFragmentToken();
    window.history.replaceState(null, "", "/");
  });

  it("forgets a stashed fragment token when an authenticated session logs out", () => {
    const token = "Qx9".repeat(12);
    window.history.replaceState(null, "", `/restablecer#t=${token}`);
    readAndScrubFragmentToken();
    const store = makeStore(authenticatedState());

    store.dispatch(loggedOut());

    expect(readAndScrubFragmentToken()).toBeNull();
    window.history.replaceState(null, "", "/");
  });

  it("never writes the token or user to web storage", async () => {
    server.use(http.post(apiUrl("/auth/refresh"), () => HttpResponse.json(tokenBody("secret-token"))));
    const store = makeStore();

    stops.push(bootstrapApp(store));
    await vi.waitFor(() => expect(store.getState().auth.status).toBe("authenticated"));

    const stored = JSON.stringify({ ...window.localStorage }) + JSON.stringify({ ...window.sessionStorage });
    expect(stored).not.toContain("secret-token");
    expect(stored).not.toContain("prima@example.com");
  });
});
