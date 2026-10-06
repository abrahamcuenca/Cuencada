/**
 * Authorization matrix (WP-2.3) [SEC]: every route × every principal, with
 * minimal valid requests against real Postgres through `inject()`.
 *
 * Principals: anonymous, verified member, unverified member, member pending a
 * password change, disabled user (token issued before the disable), revoked
 * session, admin, plus "other member" IDOR probes on owner-scoped resources.
 * Cookie routes are also checked without the CSRF header and with a foreign
 * Origin. The WebSocket upgrade is checked for anonymous, unverified and
 * revoked callers.
 */
import type { InjectOptions } from "fastify";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../../app.js";
import { sessions, users } from "../../db/schema/index.js";
import { WS_POLICY_VIOLATION } from "../../modules/chat/socket.js";
import { createTestApp } from "../../../test/helpers/app.js";
import { connectChat, createChatMember, frameOf, insertGlobalRoom, issueTicket } from "../../../test/helpers/chat.js";
import { getTestDb } from "../../../test/helpers/db.js";
import { FakeMailer, FakeStorage } from "../../../test/helpers/fakes.js";
import {
  type BuiltRequest,
  createActor,
  type Expectation,
  expectationFor,
  type MatrixContext,
  PRINCIPALS,
  Principal,
  ROUTE_MATRIX,
  type RouteSpec,
  routeKey
} from "./routeMatrix.js";

let app: App;
const storage = new FakeStorage();
const mailer = new FakeMailer();
let ipCounter = 0;

/** A unique client IP per request, so the per-IP limits never interfere. */
function nextIp(): string {
  ipCounter += 1;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
}

beforeAll(async () => {
  app = await createTestApp({ storage, mailer });
});

afterAll(async () => {
  await app.jobs.onIdle();
  await app.close();
});

/** Build the context for one principal of one route. */
async function contextFor(principal: Principal, years: { next: number }): Promise<MatrixContext> {
  return {
    app,
    storage,
    mailer,
    principal,
    actor: await createActor(principal === Principal.Anonymous ? Principal.Member : principal),
    other: await createActor(Principal.Member),
    nextYear: () => {
      years.next += 1;
      return years.next;
    },
    nextIp
  };
}

/** Send a built request as the context's actor. */
async function send(spec: RouteSpec, ctx: MatrixContext, built: BuiltRequest, withAuth: boolean) {
  const headers: Record<string, string> = { ...built.headers };
  if (withAuth && built.noBearer !== true) Object.assign(headers, ctx.actor.auth.headers);
  const options: InjectOptions = {
    // Matrix methods are the registered HTTP methods (checked by the inventory test).
    method: spec.method as NonNullable<InjectOptions["method"]>,
    url: built.url,
    headers,
    remoteAddress: nextIp()
  };
  if (built.payload !== undefined) options.payload = built.payload as NonNullable<InjectOptions["payload"]>; // JSON-serializable fixture body
  if (built.cookies !== undefined) options.cookies = built.cookies;
  return app.inject(options);
}

interface Outcome {
  status: number;
  code: string | undefined;
}

function errorCode(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
      const error: unknown = parsed.error;
      if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") return error.code;
    }
  } catch {
    // Not JSON (CSV, empty 204): no code.
  }
  return undefined;
}

function matches(expected: Expectation, outcome: Outcome): boolean {
  if (expected === "2xx") return outcome.status >= 200 && outcome.status < 300;
  if (outcome.status !== expected.status) return false;
  return expected.code === undefined || expected.code === outcome.code;
}

function describeExpectation(expected: Expectation): string {
  return expected === "2xx" ? "2xx" : `${expected.status}${expected.code === undefined ? "" : ` ${expected.code}`}`;
}

const httpRoutes = ROUTE_MATRIX.filter((spec) => spec.websocket !== true);

describe("authorization matrix", () => {
  it.each(httpRoutes.map((spec) => [routeKey(spec), spec] as const))("%s", async (_key, spec) => {
    const years = { next: 2100 };
    const failures: string[] = [];
    for (const principal of PRINCIPALS) {
      const ctx = await contextFor(principal, years);
      const built = await spec.build(ctx);
      const response = await send(spec, ctx, built, principal !== Principal.Anonymous);
      const outcome = { status: response.statusCode, code: errorCode(response.body) };
      const expected = expectationFor(spec, principal);
      if (!matches(expected, outcome)) {
        failures.push(
          `${principal}: expected ${describeExpectation(expected)}, got ${outcome.status} ${outcome.code ?? ""} ${response.body.slice(0, 200)}`
        );
      }
    }
    if (spec.idor !== undefined) {
      const ctx = await contextFor(Principal.Member, years);
      const response = await send(spec, ctx, await spec.idor.build(ctx), true);
      const outcome = { status: response.statusCode, code: errorCode(response.body) };
      if (!matches(spec.idor.expect, outcome)) {
        failures.push(`other member (IDOR): expected ${describeExpectation(spec.idor.expect)}, got ${outcome.status} ${outcome.code ?? ""}`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe("cookie routes require the CSRF header and an exact allowed Origin", () => {
  const cookieRoutes = httpRoutes.filter((spec) => spec.auth === "cookie");

  it.each(cookieRoutes.map((spec) => [routeKey(spec), spec] as const))("%s", async (_key, spec) => {
    const variants: Array<Record<string, string>> = [
      {},
      { origin: "http://localhost:5173" },
      { "x-cuencada-csrf": "1" },
      { "x-cuencada-csrf": "1", origin: "https://evil.example" },
      { "x-cuencada-csrf": "0", origin: "http://localhost:5173" },
      { "x-cuencada-csrf": "1", origin: "http://localhost:5173.evil.example" }
    ];
    for (const headers of variants) {
      const ctx = await contextFor(Principal.Member, { next: 2100 });
      const built = await spec.build(ctx);
      const response = await send(spec, ctx, { ...built, headers }, false);
      expect({ headers, status: response.statusCode, code: errorCode(response.body) }).toEqual({
        headers,
        status: 403,
        code: "CSRF_FAILED"
      });
    }
  });
});

describe("chat WebSocket upgrade", () => {
  it("closes with 1008 for an anonymous upgrade (no ticket, or a made-up one)", async () => {
    for (const options of [{}, { ticket: "A".repeat(43) }]) {
      const client = await connectChat(app, options);
      expect((await client.closed).code).toBe(WS_POLICY_VIOLATION);
    }
  });

  it("refuses a ticket to an unverified member, and a ticket whose holder became unverified", async () => {
    const unverified = await createChatMember({ emailVerified: false });
    const denied = await app.inject({ method: "POST", url: "/api/chat/ticket", remoteAddress: nextIp(), ...unverified.auth });
    expect(denied.statusCode).toBe(403);

    const member = await createChatMember();
    const { ticket } = await issueTicket(app, member);
    await getTestDb().update(users).set({ emailVerifiedAt: null }).where(eq(users.id, member.user.id));
    const client = await connectChat(app, { ticket });
    expect((await client.closed).code).toBe(WS_POLICY_VIOLATION);
  });

  it("closes with 1008 when the ticket's session was revoked before the upgrade", async () => {
    const member = await createChatMember();
    const { ticket } = await issueTicket(app, member);
    await getTestDb().update(sessions).set({ revokedAt: new Date(), revokedReason: "logout" }).where(eq(sessions.id, member.sessionId));
    const client = await connectChat(app, { ticket });
    expect((await client.closed).code).toBe(WS_POLICY_VIOLATION);
  });

  it("accepts a verified member's fresh ticket from the allowed Origin (control)", async () => {
    await insertGlobalRoom();
    const member = await createChatMember();
    const { ticket } = await issueTicket(app, member);
    const client = await connectChat(app, { ticket });
    await client.waitFor(frameOf("presence"));
    client.ws.terminate();
  });

  it("does not serve the WebSocket route as plain HTTP", async () => {
    const response = await app.inject({ method: "GET", url: "/api/chat/ws", remoteAddress: nextIp() });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });
});
