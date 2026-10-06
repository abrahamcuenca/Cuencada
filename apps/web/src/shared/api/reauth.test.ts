import { CSRF_HEADER, type ErrorCode } from "@cuencada/types";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { apiUrl, authenticatedState, errorBody, makeUser, tokenBody } from "../../../test/auth";
import { type AppStore, makeStore } from "../../app/store";
import { loggedOut } from "../../features/auth/authSlice";
import { baseApi } from "./baseApi";
import { AUTH_CHANNEL_NAME, startAuthSync } from "../../features/auth/authSync";
import { cancelOnlineLogoutRetry, logout } from "../../features/auth/session";
import { isAbortError } from "./errors";
import { cancelOnlineRefreshRetry, REFRESH_LOCK_NAME, REFRESH_RACE_GRACE_WAIT_MS, refreshAccessToken } from "./reauth";

interface PingResponse {
  ok: boolean;
}

const testApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    ping: build.mutation<PingResponse, number>({ query: (n) => ({ url: `/test/ping?n=${n}`, method: "POST" }) }),
    member: build.query<PingResponse, void>({ query: () => "/test/member" })
  })
});

interface FakeServerState {
  validToken: string;
  pingCalls: number;
  refreshCalls: number;
  refreshCsrfHeaders: Array<string | null>;
  /** Responses the refresh endpoint returns in order; the last one repeats. */
  refreshPlan: Array<{ status: number; code?: ErrorCode }>;
  /** When set, /test/ping always fails with this error. */
  pingFailure: { status: number; code: ErrorCode } | null;
}

function freshFake(): FakeServerState {
  return {
    validToken: "token-2",
    pingCalls: 0,
    refreshCalls: 0,
    refreshCsrfHeaders: [],
    refreshPlan: [{ status: 200 }],
    pingFailure: null
  };
}

/** Mutable fake server state, reset before each test. */
const fake: FakeServerState = freshFake();

/** A promise plus its resolver, to hold a fake response until the test releases it. */
function gate(): { wait: Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

const server = setupServer(
  http.post(apiUrl("/test/ping"), ({ request }) => {
    fake.pingCalls += 1;
    if (fake.pingFailure) return HttpResponse.json(errorBody(fake.pingFailure.code), { status: fake.pingFailure.status });
    if (request.headers.get("authorization") === `Bearer ${fake.validToken}`) return HttpResponse.json({ ok: true });
    return HttpResponse.json(errorBody("TOKEN_EXPIRED"), { status: 401 });
  }),
  http.get(apiUrl("/test/member"), () => HttpResponse.json({ ok: true })),
  http.post(apiUrl("/auth/refresh"), async ({ request }) => {
    fake.refreshCalls += 1;
    fake.refreshCsrfHeaders.push(request.headers.get(CSRF_HEADER));
    const step = fake.refreshPlan[Math.min(fake.refreshCalls - 1, fake.refreshPlan.length - 1)] ?? { status: 200 };
    // Let concurrent callers pile up behind the in-flight refresh.
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (step.status === 200) return HttpResponse.json(tokenBody(fake.validToken));
    return HttpResponse.json(errorBody(step.code ?? "UNAUTHENTICATED"), { status: step.status });
  })
);

let store: AppStore;
const cleanups: Array<() => void> = [];

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  Object.assign(fake, freshFake());
  store = makeStore(authenticatedState(makeUser(), "token-1-expired"));
});
afterEach(() => {
  server.resetHandlers();
  cancelOnlineRefreshRetry();
  cancelOnlineLogoutRetry();
  for (const cleanup of cleanups.splice(0)) cleanup();
  Reflect.deleteProperty(navigator, "locks");
});

describe("baseQueryWithReauth", () => {
  it("refreshes with the CSRF header on TOKEN_EXPIRED, then retries the original request once", async () => {
    const result = await store.dispatch(testApi.endpoints.ping.initiate(1));

    expect(result).toEqual({ data: { ok: true } });
    expect(fake.refreshCalls).toBe(1);
    expect(fake.refreshCsrfHeaders).toEqual(["1"]);
    expect(fake.pingCalls).toBe(2);
    expect(store.getState().auth).toMatchObject({ accessToken: "token-2", status: "authenticated" });
  });

  it("shares one refresh between concurrent requests that all get TOKEN_EXPIRED", async () => {
    const results = await Promise.all([1, 2, 3, 4].map((n) => store.dispatch(testApi.endpoints.ping.initiate(n))));

    expect(results.every((result) => "data" in result && result.data?.ok === true)).toBe(true);
    expect(fake.refreshCalls).toBe(1);
    expect(fake.pingCalls).toBe(8);
  });

  it("serializes the refresh through the cuencada-refresh Web Lock when the API exists", async () => {
    const request = vi.fn((_name: string, _options: unknown, callback: () => Promise<unknown>) => callback());
    Object.defineProperty(navigator, "locks", { value: { request }, configurable: true });

    await Promise.all([1, 2].map((n) => store.dispatch(testApi.endpoints.ping.initiate(n))));

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(REFRESH_LOCK_NAME, { mode: "exclusive" }, expect.any(Function));
  });

  it("retries the refresh once after a 409 REFRESH_RACE and then succeeds", async () => {
    fake.refreshPlan = [{ status: 409, code: "REFRESH_RACE" }, { status: 200 }];

    const result = await store.dispatch(testApi.endpoints.ping.initiate(1));

    expect(result).toEqual({ data: { ok: true } });
    expect(fake.refreshCalls).toBe(2);
    expect(store.getState().auth.status).toBe("authenticated");
  });

  it("after a second REFRESH_RACE waits past the 10 s grace window, retries once and succeeds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout"] });
    try {
      fake.refreshPlan = [{ status: 409, code: "REFRESH_RACE" }, { status: 409, code: "REFRESH_RACE" }, { status: 200 }];

      const pending = store.dispatch(testApi.endpoints.ping.initiate(1));
      await vi.waitFor(() => expect(fake.refreshCalls).toBe(2));
      // Still inside the grace window: no third attempt yet, and the session is kept.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fake.refreshCalls).toBe(2);
      expect(store.getState().auth.status).toBe("authenticated");

      await vi.advanceTimersByTimeAsync(REFRESH_RACE_GRACE_WAIT_MS - 10_000 + 100);
      const result = await pending;

      expect(result).toEqual({ data: { ok: true } });
      expect(fake.refreshCalls).toBe(3);
      expect(store.getState().auth.status).toBe("authenticated");
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs out when the refresh loses REFRESH_RACE three times", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout"] });
    try {
      fake.refreshPlan = [{ status: 409, code: "REFRESH_RACE" }];

      const pending = store.dispatch(testApi.endpoints.ping.initiate(1));
      await vi.waitFor(() => expect(fake.refreshCalls).toBe(2));
      await vi.advanceTimersByTimeAsync(REFRESH_RACE_GRACE_WAIT_MS + 100);
      const result = await pending;

      expect(result).not.toHaveProperty("data");
      expect(fake.refreshCalls).toBe(3);
      expect(store.getState().auth.status).toBe("anonymous");
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops the grace-window retry when the user logs out while waiting", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout"] });
    try {
      fake.refreshPlan = [{ status: 409, code: "REFRESH_RACE" }];

      const pending = store.dispatch(testApi.endpoints.ping.initiate(1));
      await vi.waitFor(() => expect(fake.refreshCalls).toBe(2));
      // Let the second 409 land, so the 11 s pause is running.
      await vi.advanceTimersByTimeAsync(200);
      const started = Date.now();
      store.dispatch(loggedOut());
      // The logout ends the pause at once (the clock only moves with real time here, and the
      // test would time out long before the 11 s pause ended on its own).
      await pending;

      expect(Date.now() - started).toBeLessThan(2_000);
      expect(fake.refreshCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never lets a new session join a refresh that started before a logout", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout"] });
    try {
      fake.refreshPlan = [{ status: 409, code: "REFRESH_RACE" }, { status: 409, code: "REFRESH_RACE" }, { status: 200 }];
      const stale = refreshAccessToken(store);
      await vi.waitFor(() => expect(fake.refreshCalls).toBe(2));
      store.dispatch(loggedOut());

      // A new login in the same tab refreshes on its own instead of reusing the stale promise.
      fake.refreshPlan = [{ status: 200 }];
      fake.refreshCalls = 0;
      const fresh = refreshAccessToken(store);
      expect(fresh).not.toBe(stale);
      expect(await fresh).toBe(true);
      expect(await stale).toBe(false);
      expect(store.getState().auth.status).toBe("authenticated");
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs out without retrying when the refresh is rejected", async () => {
    fake.refreshPlan = [{ status: 401, code: "UNAUTHENTICATED" }];

    const result = await store.dispatch(testApi.endpoints.ping.initiate(1));

    // loggedOut resets the API cache, which aborts the in-flight request; either way it carries no data.
    expect(result).not.toHaveProperty("data");
    expect(fake.pingCalls).toBe(1);
    expect(store.getState().auth).toMatchObject({ accessToken: null, user: null, status: "anonymous" });
  });

  it("keeps the session and flags offline when the refresh gets no response, then refreshes on the online event", async () => {
    server.use(http.post(apiUrl("/auth/refresh"), () => HttpResponse.error()));
    const user = store.getState().auth.user;

    const result = await store.dispatch(testApi.endpoints.ping.initiate(1));

    expect(result).toHaveProperty("error.status", 401);
    expect(store.getState().auth).toMatchObject({ status: "authenticated", user, isOffline: true });

    server.resetHandlers();
    window.dispatchEvent(new Event("online"));

    await vi.waitFor(() => expect(store.getState().auth).toMatchObject({ accessToken: "token-2", isOffline: false }));
    expect(fake.refreshCalls).toBe(1);
  });

  it("keeps the session when the refresh answers 5xx", async () => {
    fake.refreshPlan = [{ status: 503, code: "SERVICE_UNAVAILABLE" }];

    await store.dispatch(testApi.endpoints.ping.initiate(1));

    expect(store.getState().auth).toMatchObject({ status: "authenticated", accessToken: "token-1-expired", isOffline: true });
  });

  it("logs out when the retry on the online event is rejected with 401", async () => {
    server.use(http.post(apiUrl("/auth/refresh"), () => HttpResponse.error()));
    await store.dispatch(testApi.endpoints.ping.initiate(1));
    server.resetHandlers();
    fake.refreshPlan = [{ status: 401, code: "UNAUTHENTICATED" }];

    window.dispatchEvent(new Event("online"));

    await vi.waitFor(() => expect(store.getState().auth.status).toBe("anonymous"));
  });

  it("does not refresh on the online event after the user logged out while offline", async () => {
    server.use(http.post(apiUrl("/auth/refresh"), () => HttpResponse.error()));
    await store.dispatch(testApi.endpoints.ping.initiate(1));
    server.resetHandlers();

    store.dispatch(loggedOut());
    window.dispatchEvent(new Event("online"));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fake.refreshCalls).toBe(0);
    expect(store.getState().auth.status).toBe("anonymous");
  });

  it("treats a 200 that fails the contract as unreachable and keeps the session", async () => {
    server.use(http.post(apiUrl("/auth/refresh"), () => HttpResponse.json({ accessToken: "x" })));

    await store.dispatch(testApi.endpoints.ping.initiate(1));

    expect(store.getState().auth).toMatchObject({ status: "authenticated", isOffline: true });
  });

  it("treats a captive-portal HTML page as unreachable instead of logging out", async () => {
    server.use(
      http.post(apiUrl("/auth/refresh"), () => HttpResponse.html("<html><body>Wi-Fi del hotel</body></html>"))
    );

    await store.dispatch(testApi.endpoints.ping.initiate(1));

    expect(store.getState().auth).toMatchObject({ status: "authenticated", isOffline: true });
  });

  it("does not refresh again when the retried request still answers TOKEN_EXPIRED", async () => {
    fake.validToken = "never-accepted";
    server.use(http.post(apiUrl("/auth/refresh"), () => HttpResponse.json(tokenBody("token-2"))));

    const result = await store.dispatch(testApi.endpoints.ping.initiate(1));

    expect(result).toHaveProperty("error.status", 401);
    expect(fake.pingCalls).toBe(2);
  });

  it("flags passwordChangeRequired on 403 PASSWORD_CHANGE_REQUIRED without refreshing", async () => {
    fake.pingFailure = { status: 403, code: "PASSWORD_CHANGE_REQUIRED" };

    const result = await store.dispatch(testApi.endpoints.ping.initiate(1));

    expect(result).toHaveProperty("error.status", 403);
    expect(fake.refreshCalls).toBe(0);
    expect(store.getState().auth).toMatchObject({ passwordChangeRequired: true, status: "authenticated" });
  });

  it("logs out on 401 UNAUTHENTICATED (revoked session) without refreshing", async () => {
    fake.pingFailure = { status: 401, code: "UNAUTHENTICATED" };

    await store.dispatch(testApi.endpoints.ping.initiate(1));

    expect(fake.refreshCalls).toBe(0);
    expect(store.getState().auth.status).toBe("anonymous");
  });

  it("clears cached member data when the session is logged out", async () => {
    await store.dispatch(testApi.endpoints.member.initiate());
    expect(testApi.endpoints.member.select()(store.getState()).data).toEqual({ ok: true });

    fake.refreshPlan = [{ status: 401, code: "UNAUTHENTICATED" }];
    await store.dispatch(testApi.endpoints.ping.initiate(1));

    expect(testApi.endpoints.member.select()(store.getState()).data).toBeUndefined();
  });
});

describe("refresh vs logout", () => {
  it("discards a refresh that resolves after logout() in the same tab", async () => {
    const held = gate();
    server.use(
      http.post(apiUrl("/auth/refresh"), async () => {
        fake.refreshCalls += 1;
        await held.wait;
        return HttpResponse.json(tokenBody("revived"));
      }),
      http.post(apiUrl("/auth/logout"), () => new HttpResponse(null, { status: 204 }))
    );

    const pending = store.dispatch(testApi.endpoints.ping.initiate(1));
    await vi.waitFor(() => expect(fake.refreshCalls).toBe(1));
    const loggingOut = store.dispatch(logout());
    held.release();
    await Promise.all([pending, loggingOut]);

    expect(store.getState().auth).toMatchObject({ status: "anonymous", accessToken: null, user: null });
  });

  it("discards a refresh that resolves after a logout broadcast from another tab", async () => {
    const held = gate();
    server.use(
      http.post(apiUrl("/auth/refresh"), async () => {
        fake.refreshCalls += 1;
        await held.wait;
        return HttpResponse.json(tokenBody("revived"));
      })
    );
    cleanups.push(startAuthSync(store.dispatch));
    const otherTab = new BroadcastChannel(AUTH_CHANNEL_NAME);
    cleanups.push(() => otherTab.close());

    const pending = store.dispatch(testApi.endpoints.ping.initiate(1));
    await vi.waitFor(() => expect(fake.refreshCalls).toBe(1));
    otherTab.postMessage({ type: "logout" });
    await vi.waitFor(() => expect(store.getState().auth.status).toBe("anonymous"));
    held.release();
    await pending;

    expect(store.getState().auth).toMatchObject({ status: "anonymous", accessToken: null });
  });

  it("sends the logout request under the cuencada-refresh Web Lock", async () => {
    const names: string[] = [];
    const request = vi.fn((name: string, _options: unknown, callback: () => Promise<unknown>) => {
      names.push(name);
      return callback();
    });
    Object.defineProperty(navigator, "locks", { value: { request }, configurable: true });
    server.use(http.post(apiUrl("/auth/logout"), () => new HttpResponse(null, { status: 204 })));

    await store.dispatch(logout());

    expect(names).toEqual([REFRESH_LOCK_NAME]);
  });
});

describe("isAbortError", () => {
  it("identifies a pending mutation aborted by loggedOut", async () => {
    const held = gate();
    server.use(
      http.post(apiUrl("/test/ping"), async () => {
        await held.wait;
        return HttpResponse.json({ ok: true });
      })
    );
    store = makeStore(authenticatedState(makeUser(), "token-2"));

    const pending = store.dispatch(testApi.endpoints.ping.initiate(1)).unwrap();
    store.dispatch(loggedOut());
    held.release();

    const error: unknown = await pending.then(
      () => null,
      (reason: unknown) => reason
    );
    expect(isAbortError(error)).toBe(true);
    expect(isAbortError({ status: 401, data: null })).toBe(false);
  });
});
