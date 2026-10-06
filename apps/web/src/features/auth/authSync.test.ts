import { CSRF_HEADER } from "@cuencada/types";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { apiUrl, authenticatedState } from "../../../test/auth";
import { makeStore } from "../../app/store";
import { AUTH_CHANNEL_NAME, startAuthSync } from "./authSync";
import { logout } from "./session";

const server = setupServer();
const cleanups: Array<() => void> = [];

/** A second "tab": a raw channel on the same name. */
function otherTab(): { channel: BroadcastChannel; received: unknown[] } {
  const channel = new BroadcastChannel(AUTH_CHANNEL_NAME);
  const received: unknown[] = [];
  channel.onmessage = (event: MessageEvent<unknown>) => {
    received.push(event.data);
  };
  cleanups.push(() => channel.close());
  return { channel, received };
}

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
afterEach(() => {
  server.resetHandlers();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("startAuthSync", () => {
  it("logs this tab out when another tab broadcasts a logout", async () => {
    const store = makeStore(authenticatedState());
    cleanups.push(startAuthSync(store.dispatch));

    otherTab().channel.postMessage({ type: "logout" });

    await vi.waitFor(() => expect(store.getState().auth.status).toBe("anonymous"));
    expect(store.getState().auth.accessToken).toBeNull();
  });

  it("ignores messages that are not a well-formed logout", async () => {
    const store = makeStore(authenticatedState());
    cleanups.push(startAuthSync(store.dispatch));
    const { channel } = otherTab();

    for (const message of ["logout", { type: "login" }, null, { kind: "logout" }]) channel.postMessage(message);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(store.getState().auth.status).toBe("authenticated");
  });

  it("stops reacting after the returned cleanup runs", async () => {
    const store = makeStore(authenticatedState());
    startAuthSync(store.dispatch)();

    otherTab().channel.postMessage({ type: "logout" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(store.getState().auth.status).toBe("authenticated");
  });
});

describe("logout", () => {
  it("calls /auth/logout with the CSRF header, clears the session and tells other tabs", async () => {
    const csrf: Array<string | null> = [];
    server.use(
      http.post(apiUrl("/auth/logout"), ({ request }) => {
        csrf.push(request.headers.get(CSRF_HEADER));
        return new HttpResponse(null, { status: 204 });
      })
    );
    const store = makeStore(authenticatedState());
    cleanups.push(startAuthSync(store.dispatch));
    const tab = otherTab();

    const result = await store.dispatch(logout());

    expect(result).toEqual({ serverConfirmed: true });
    expect(csrf).toEqual(["1"]);
    expect(store.getState().auth).toMatchObject({ status: "anonymous", accessToken: null, user: null });
    await vi.waitFor(() => expect(tab.received).toEqual([{ type: "logout" }]));
  });

  it("clears the local session even when the server cannot be reached", async () => {
    server.use(http.post(apiUrl("/auth/logout"), () => HttpResponse.error()));
    const store = makeStore(authenticatedState());

    const result = await store.dispatch(logout());

    expect(result).toEqual({ serverConfirmed: false });
    expect(store.getState().auth.status).toBe("anonymous");
  });
});
