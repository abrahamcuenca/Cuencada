import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp } from "../test/helpers/app.js";
import type { App } from "./app.js";
import { REDACTED, scrubUrl } from "./logging.js";

const BEARER = "eyJhbGciOiJIUzI1NiJ9.bearer-secret-value.sig";
const COOKIE = "__Secure-cuencada_rt=refresh-secret-value";
const TICKET = "ticket-secret-value-0123456789abcdefghijklmnop";

describe("log redaction", () => {
  const lines: string[] = [];
  let app: App;

  beforeAll(async () => {
    app = await createTestApp({
      logStream: { write: (line) => lines.push(line) },
      routes: (instance) => {
        instance.post("/t/log", { config: { auth: "public" } }, async (request) => {
          request.log.info(
            {
              token: "top-level-token-secret",
              password: "password-secret",
              body: { newPassword: "nested-password-secret", ticket: "nested-ticket-secret" },
              headers: request.headers
            },
            "fixture log"
          );
          return { ok: true };
        });
      }
    });
    await app.inject({
      method: "POST",
      url: "/t/log?ticket=query-ticket-secret&page=2",
      headers: { authorization: `Bearer ${BEARER}`, cookie: COOKIE },
      payload: { any: "thing" }
    });
    await app.inject({ method: "GET", url: `/api/chat/ws?ticket=${TICKET}` });
    await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${BEARER}` } });
  });

  afterAll(async () => {
    await app.close();
  });

  it("captured request logs", () => {
    expect(lines.some((line) => line.includes("incoming request"))).toBe(true);
    expect(lines.some((line) => line.includes("fixture log"))).toBe(true);
  });

  it("never writes tokens, cookies, tickets or passwords", () => {
    const output = lines.join("\n");
    for (const secret of [
      "bearer-secret-value",
      "refresh-secret-value",
      TICKET,
      "query-ticket-secret",
      "top-level-token-secret",
      "password-secret",
      "nested-password-secret",
      "nested-ticket-secret"
    ]) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain(REDACTED);
  });

  it("logs the chat WebSocket URL with the ticket scrubbed", () => {
    const urls = lines
      .map((line) => JSON.parse(line) as { req?: { url?: string } }) // pino writes one JSON object per line
      .map((entry) => entry.req?.url)
      .filter((url): url is string => url !== undefined);

    expect(urls).toContain(`/api/chat/ws?ticket=${REDACTED}`);
    expect(urls).toContain(`/t/log?ticket=${REDACTED}&page=2`);
  });
});

describe("scrubUrl", () => {
  it("leaves URLs without a query unchanged", () => {
    expect(scrubUrl("/api/cuencadas/2026")).toBe("/api/cuencadas/2026");
  });

  it("redacts sensitive parameters regardless of case and keeps the others", () => {
    expect(scrubUrl("/x?Ticket=a&token=b&t=c&year=2026")).toBe(
      `/x?Ticket=${REDACTED}&token=${REDACTED}&t=${REDACTED}&year=2026`
    );
  });

  it("redacts percent-encoded parameter names", () => {
    expect(scrubUrl("/x?%74icket=abc")).toBe(`/x?%74icket=${REDACTED}`);
  });

  it("redacts a pair whose name cannot be decoded", () => {
    expect(scrubUrl("/x?%E0%A4%A=abc&ok=1")).toBe(`/x?${REDACTED}&ok=1`);
  });

  it("handles empty and valueless parameters", () => {
    expect(scrubUrl("/x?&ticket&a=")).toBe(`/x?&ticket=${REDACTED}&a=`);
  });
});
