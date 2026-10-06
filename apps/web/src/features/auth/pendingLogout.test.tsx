import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { apiUrl, authenticatedState, errorBody, makeUser } from "../../../test/auth";
import { renderApp } from "../../../test/renderApp";
import { bootstrapApp } from "../../app/bootstrap";
import { LOGOUT_PENDING_NOTICE } from "../../app/AppLayout";
import { makeStore } from "../../app/store";
import { cancelOnlineRefreshRetry } from "../../shared/api/reauth";
import { credentialsReceived } from "./authSlice";
import { hasPendingLogout, markPendingLogout, PENDING_LOGOUT_KEY } from "./pendingLogout";
import { cancelOnlineLogoutRetry, logout } from "./session";

const server = setupServer();
const stops: Array<() => void> = [];
let logoutCalls = 0;
let refreshCalls = 0;

/** Answers `/auth/logout` and counts calls; also fails the test loudly if a refresh is attempted. */
function serve(logoutAnswer: () => Response): void {
  server.use(
    http.post(apiUrl("/auth/logout"), () => {
      logoutCalls += 1;
      return logoutAnswer();
    }),
    http.post(apiUrl("/auth/refresh"), () => {
      refreshCalls += 1;
      return HttpResponse.json(errorBody("UNAUTHENTICATED"), { status: 401 });
    })
  );
}

const ok = (): Response => new HttpResponse(null, { status: 204 });
const offline = (): Response => HttpResponse.error();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
afterEach(() => {
  server.resetHandlers();
  cancelOnlineLogoutRetry();
  cancelOnlineRefreshRetry();
  for (const stop of stops.splice(0)) stop();
  logoutCalls = 0;
  refreshCalls = 0;
});

describe("logout", () => {
  it("clears the pending marker when the server confirms", async () => {
    serve(ok);
    const store = makeStore(authenticatedState());

    const result = await store.dispatch(logout());

    expect(result).toEqual({ serverConfirmed: true });
    expect(hasPendingLogout()).toBe(false);
    expect(store.getState().auth.logoutPending).toBe(false);
  });

  it("treats a 401 from /auth/logout as confirmed because the session is already dead", async () => {
    serve(() => HttpResponse.json(errorBody("UNAUTHENTICATED"), { status: 401 }));
    const store = makeStore(authenticatedState());

    expect(await store.dispatch(logout())).toEqual({ serverConfirmed: true });
    expect(hasPendingLogout()).toBe(false);
  });

  it("keeps a non-secret marker and flags the notice when the server cannot be reached", async () => {
    serve(offline);
    const store = makeStore(authenticatedState(makeUser(), "secret-access-token"));

    const result = await store.dispatch(logout());

    expect(result).toEqual({ serverConfirmed: false });
    expect(store.getState().auth).toMatchObject({ status: "anonymous", logoutPending: true });
    const stored = window.localStorage.getItem(PENDING_LOGOUT_KEY);
    expect(stored).not.toBeNull();
    expect(stored).not.toContain("secret-access-token");
    expect(stored).not.toContain("prima@example.com");
  });

  it("keeps the marker on a 5xx answer", async () => {
    serve(() => HttpResponse.json(errorBody("SERVICE_UNAVAILABLE"), { status: 503 }));
    const store = makeStore(authenticatedState());

    expect(await store.dispatch(logout())).toEqual({ serverConfirmed: false });
    expect(hasPendingLogout()).toBe(true);
  });

  it("retries the logout on the online event and clears the marker once confirmed", async () => {
    serve(offline);
    const store = makeStore(authenticatedState());
    await store.dispatch(logout());

    serve(ok);
    window.dispatchEvent(new Event("online"));

    await vi.waitFor(() => expect(store.getState().auth.logoutPending).toBe(false));
    expect(hasPendingLogout()).toBe(false);
    expect(logoutCalls).toBe(2);
  });

  it("drops the marker when the user logs in again on this device", () => {
    markPendingLogout();
    const store = makeStore();

    store.dispatch(credentialsReceived({ accessToken: "t", user: makeUser() }));

    expect(hasPendingLogout()).toBe(false);
  });
});

describe("boot with an unconfirmed logout", () => {
  it("finishes the logout instead of refreshing and stays anonymous", async () => {
    markPendingLogout();
    serve(ok);
    const store = makeStore();

    stops.push(bootstrapApp(store));

    await vi.waitFor(() => expect(hasPendingLogout()).toBe(false));
    expect(logoutCalls).toBe(1);
    expect(refreshCalls).toBe(0);
    expect(store.getState().auth).toMatchObject({ status: "anonymous", logoutPending: false });
  });

  it("stays anonymous, never refreshes and retries on online when still offline", async () => {
    markPendingLogout();
    serve(offline);
    const store = makeStore();

    stops.push(bootstrapApp(store));
    await vi.waitFor(() => expect(store.getState().auth.logoutPending).toBe(true));
    expect(store.getState().auth.status).toBe("anonymous");

    serve(ok);
    window.dispatchEvent(new Event("online"));

    await vi.waitFor(() => expect(hasPendingLogout()).toBe(false));
    expect(refreshCalls).toBe(0);
  });
});

describe("logout pending notice", () => {
  it("shows the notice in the layout while the server has not confirmed", async () => {
    renderApp("/", { auth: { ...authenticatedState().auth, status: "anonymous", accessToken: null, user: null, logoutPending: true } });

    expect(await screen.findByText(LOGOUT_PENDING_NOTICE)).toBeInTheDocument();
  });
});
