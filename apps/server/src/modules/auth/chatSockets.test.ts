import { WsCloseCode } from "@cuencada/types";
import { afterEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import { type FullLogin, linkToken, loginFull, withRefreshCookie } from "../../../test/helpers/auth.js";
import { type ChatTestClient, connectChat, frameOf, sleep } from "../../../test/helpers/chat.js";
import { createUser, type TestUser } from "../../../test/helpers/factories.js";
import { FakeMailer } from "../../../test/helpers/fakes.js";
import type { App } from "../../app.js";
import { mailQueue } from "./mailQueue.js";

const NEW_PASSWORD = "una-contraseña-nueva-y-larga";

let app: App | undefined;
const clients: ChatTestClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.ws.terminate();
  await app?.close();
  app = undefined;
});

/** Open a chat socket for a real login session and wait until it is registered. */
async function openSocket(server: App, user: TestUser, login: FullLogin): Promise<ChatTestClient> {
  const response = await server.inject({ method: "POST", url: "/api/chat/ticket", ...login.auth });
  expect(response.statusCode).toBe(201);
  const client = await connectChat(server, { ticket: response.json<{ ticket: string }>().ticket });
  clients.push(client);
  await client.waitFor(frameOf("presence", (frame) => frame.onlineUserIds.includes(user.id)));
  return client;
}

/** The session id behind a login (from the session list's `current` flag). */
async function sessionIdOf(server: App, login: FullLogin): Promise<string> {
  const response = await server.inject({ method: "GET", url: "/api/auth/sessions", ...login.auth });
  const current = response.json<Array<{ id: string; current: boolean }>>().find((item) => item.current);
  if (current === undefined) throw new Error("sessionIdOf: no current session");
  return current.id;
}

/** Resolve with the close code, or `null` if still open after a short wait. */
function closeCode(client: ChatTestClient): Promise<number | null> {
  return Promise.race([client.closed.then((info) => info.code), sleep(200).then(() => null)]);
}

describe("auth routes close chat sockets", () => {
  it("closes only the logged-out session's socket on logout", async () => {
    app = await createTestApp();
    const user = await createUser({ emailVerified: true });
    const phone = await loginFull(app, user);
    const laptop = await loginFull(app, user);
    const phoneSocket = await openSocket(app, user, phone);
    const laptopSocket = await openSocket(app, user, laptop);

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      ...withRefreshCookie(phone.refreshToken)
    });

    expect(response.statusCode).toBe(204);
    expect((await phoneSocket.closed).code).toBe(WsCloseCode.SessionRevoked);
    expect(await closeCode(laptopSocket)).toBeNull();
  });

  it("closes every socket of the user on logout-all", async () => {
    app = await createTestApp();
    const user = await createUser({ emailVerified: true });
    const phone = await loginFull(app, user);
    const laptop = await loginFull(app, user);
    const sockets = [await openSocket(app, user, phone), await openSocket(app, user, laptop)];

    const response = await app.inject({ method: "POST", url: "/api/auth/logout-all", ...laptop.auth });

    expect(response.statusCode).toBe(204);
    for (const socket of sockets) expect((await socket.closed).code).toBe(WsCloseCode.SessionRevoked);
  });

  it("closes the other sessions' sockets on revoke-others and one session's on revoke-one", async () => {
    app = await createTestApp();
    const user = await createUser({ emailVerified: true });
    const phone = await loginFull(app, user);
    const tablet = await loginFull(app, user);
    const laptop = await loginFull(app, user);
    const phoneSocket = await openSocket(app, user, phone);
    const tabletSocket = await openSocket(app, user, tablet);
    const laptopSocket = await openSocket(app, user, laptop);

    const phoneSessionId = await sessionIdOf(app, phone);
    const one = await app.inject({ method: "DELETE", url: `/api/auth/sessions/${phoneSessionId}`, ...laptop.auth });
    expect(one.statusCode).toBe(204);
    expect((await phoneSocket.closed).code).toBe(WsCloseCode.SessionRevoked);
    expect(await closeCode(tabletSocket)).toBeNull();

    const others = await app.inject({ method: "POST", url: "/api/auth/sessions/revoke-others", ...laptop.auth });
    expect(others.statusCode).toBe(204);
    expect((await tabletSocket.closed).code).toBe(WsCloseCode.SessionRevoked);
    expect(await closeCode(laptopSocket)).toBeNull();
  });

  it("closes every old socket on password change, and the new session can connect", async () => {
    app = await createTestApp();
    const user = await createUser({ emailVerified: true });
    const phone = await loginFull(app, user);
    const laptop = await loginFull(app, user);
    const sockets = [await openSocket(app, user, phone), await openSocket(app, user, laptop)];

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      payload: { currentPassword: user.password, newPassword: NEW_PASSWORD },
      ...laptop.auth
    });

    expect(response.statusCode).toBe(200);
    for (const socket of sockets) expect((await socket.closed).code).toBe(WsCloseCode.SessionRevoked);
    const accessToken = response.json<{ accessToken: string }>().accessToken;
    const fresh = await openSocket(app, user, {
      ...laptop,
      auth: { headers: { authorization: `Bearer ${accessToken}` } }
    });
    expect(await closeCode(fresh)).toBeNull();
  });

  it("closes every socket on password reset confirm", async () => {
    const mailer = new FakeMailer();
    app = await createTestApp({ mailer });
    const user = await createUser({ emailVerified: true });
    const login = await loginFull(app, user);
    const socket = await openSocket(app, user, login);
    await app.inject({ method: "POST", url: "/api/auth/password-reset/request", payload: { email: user.email } });
    await mailQueue(app).onIdle();

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/password-reset/confirm",
      payload: { token: linkToken(mailer.lastTo(user.email)), newPassword: NEW_PASSWORD }
    });

    expect(response.statusCode).toBe(204);
    expect((await socket.closed).code).toBe(WsCloseCode.SessionRevoked);
  });
});
