import { WsCloseCode } from "@cuencada/types";
import { afterEach, describe, expect, it } from "vitest";
import { createTestApp } from "../../../test/helpers/app.js";
import { type ChatTestClient, connectMember, createChatMember } from "../../../test/helpers/chat.js";
import type { App } from "../../app.js";

let app: App | undefined;
const clients: ChatTestClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.ws.terminate();
  await app?.close();
  app = undefined;
});

describe("admin user actions close chat sockets", () => {
  it.each([
    ["disabling", "PATCH", "", { status: "disabled" }],
    ["revoking sessions", "POST", "/revoke-sessions", undefined],
    ["forcing a password reset", "POST", "/force-password-reset", undefined]
  ] as const)("closes the member's open socket when %s", async (_label, method, suffix, payload) => {
    app = await createTestApp();
    const admin = await createChatMember({ role: "admin" });
    const member = await createChatMember();
    const socket = await connectMember(app, member);
    clients.push(socket);

    const response = await app.inject({
      method,
      url: `/api/admin/users/${member.user.id}${suffix}`,
      ...(payload === undefined ? {} : { payload }),
      ...admin.auth
    });

    expect(response.statusCode).toBeLessThan(300);
    expect((await socket.closed).code).toBe(WsCloseCode.SessionRevoked);
  });
});
