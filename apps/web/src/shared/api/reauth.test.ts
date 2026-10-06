import { CSRF_HEADER, type ErrorCode } from "@cuencada/types";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { apiUrl, authenticatedState, errorBody, makeUser, tokenBody } from "../../../test/auth";
import { type AppStore, makeStore } from "../../app/store";
import { loggedOut } from "../../features/auth/authSlice";
import { baseApi } from "./baseApi";
import { cancelOnlineRefreshRetry, REFRESH_LOCK_NAME } from "./reauth";

interface PingResponse {
  ok: boolean;
}

const testApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    ping: build.mutation<PingResponse, number>({ query: (n) => ({ url: `/test/ping?n=${n}`, method: "POST" }) }),
    member: build.query<PingResponse, void>({ query: () => "/test/member" })
  })
});

/** Mutable fake server state, reset before each test. */
const fake = {
  validToken: "token-2",
  pingCalls: 0,
  refreshCalls: 0,
  refreshCsrfHeaders: [] as Array<string | null>,
  /** Responses the refresh endpoint returns in order; the last one repeats. */
  refreshPlan: [] as Array<{ status: number; code?: ErrorCode }>,
  /** When set, /test/ping always fails with this error. */
  pingFailure: null as { status: number; code: ErrorCode } | null
};

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

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  Object.assign(fake, {
    validToken: "token-2",
    pingCalls: 0,
    refreshCalls: 0,
    refreshCsrfHeaders: [],
    refreshPlan: [{ status: 200 }],
    pingFailure: null
  });
  store = makeStore(authenticatedState(makeUser(), "token-1-expired"));
});
afterEach(() => {
  server.resetHandlers();
  cancelOnlineRefreshRetry();
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

  it("logs out when the refresh loses REFRESH_RACE twice", async () => {
    fake.refreshPlan = [{ status: 409, code: "REFRESH_RACE" }];

    const result = await store.dispatch(testApi.endpoints.ping.initiate(1));

    expect(result).not.toHaveProperty("data");
    expect(fake.refreshCalls).toBe(2);
    expect(store.getState().auth.status).toBe("anonymous");
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

  it("logs out when the refresh response does not match the contract", async () => {
    server.use(http.post(apiUrl("/auth/refresh"), () => HttpResponse.json({ accessToken: "x" })));

    await store.dispatch(testApi.endpoints.ping.initiate(1));

    expect(store.getState().auth.status).toBe("anonymous");
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
