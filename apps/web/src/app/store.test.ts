import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { apiUrl, authenticatedState, makeUser } from "../../test/auth";
import { createTestServer } from "../../test/msw";
import { authApi } from "../features/auth/api";
import { credentialsReceived, tokenRefreshed } from "../features/auth/authSlice";
import { makeSession } from "../features/auth/testing/contractHandlers";
import { type AppStore, makeStore } from "./store";

const server = createTestServer(http.get(apiUrl("/auth/sessions"), () => HttpResponse.json([makeSession()])));
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const USER_A = makeUser({ id: "11111111-1111-4111-8111-111111111111" });
const USER_B = makeUser({ id: "22222222-2222-4222-8222-222222222222", email: "b@example.com" });

/** A store logged in as A with A's sessions in the RTK Query cache. */
async function storeWithCachedData(): Promise<AppStore> {
  const store = makeStore(authenticatedState(USER_A, "token-A"));
  const query = store.dispatch(authApi.endpoints.listSessions.initiate());
  await query;
  query.unsubscribe();
  expect(Object.keys(store.getState().api.queries)).not.toHaveLength(0);
  return store;
}

describe("store account-switch listener", () => {
  it.each([
    ["credentialsReceived", credentialsReceived],
    ["tokenRefreshed", tokenRefreshed]
  ])("clears the API cache and bumps the epoch when %s switches A → B", async (_name, action) => {
    const store = await storeWithCachedData();
    const epoch = store.getState().auth.sessionEpoch;

    store.dispatch(action({ accessToken: "token-B", user: USER_B }));

    expect(store.getState().api.queries).toEqual({});
    expect(store.getState().auth.sessionEpoch).toBe(epoch + 1);
    expect(store.getState().auth.user?.id).toBe(USER_B.id);
  });

  it("keeps the cache and the epoch when the same user gets new credentials", async () => {
    const store = await storeWithCachedData();
    const epoch = store.getState().auth.sessionEpoch;

    store.dispatch(credentialsReceived({ accessToken: "token-A2", user: { ...USER_A, mustChangePassword: false } }));

    expect(Object.keys(store.getState().api.queries)).not.toHaveLength(0);
    expect(store.getState().auth.sessionEpoch).toBe(epoch);
  });
});
