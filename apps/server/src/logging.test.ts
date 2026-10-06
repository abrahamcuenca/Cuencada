import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp } from "../test/helpers/app.js";
import type { App } from "./app.js";
import { users } from "./db/schema/index.js";
import { REDACTED, scrubForLog, scrubLogObject, scrubUrl, serializeError } from "./logging.js";

const BEARER = "eyJhbGciOiJIUzI1NiJ9.bearer-secret-value.sig";
const COOKIE = "__Secure-cuencada_rt=refresh-secret-value";
const TICKET = "ticket-secret-value-0123456789abcdefghijklmnop";
const DUP_EMAIL = "dup-probe@example.test";
const DUP_HASH = "$argon2id$v=19$m=19456,t=2,p=1$SECRETSALTVALUE$SECRETHASHVALUE";

describe("log redaction", () => {
  const lines: string[] = [];
  let app: App;
  let traffic: Promise<void> | undefined;

  beforeAll(async () => {
    app = await createTestApp({
      logStream: { write: (line) => lines.push(line) },
      routes: (instance) => {
        instance.post("/t/log", { config: { auth: "public" } }, async (request) => {
          request.log.info(
            {
              token: "top-level-token-secret",
              password: "password-secret",
              Token: "capitalized-token-secret",
              body: { newPassword: "nested-password-secret", ticket: "nested-ticket-secret" },
              deep: { a: { b: { c: { d: { PASSWORD: "deep-password-secret", ok: "visible-value" } } } } },
              headers: request.headers
            },
            "fixture log"
          );
          request.log.error({ err: Object.assign(new Error("with props"), { body: { creds: { apiKey: "err-prop-secret" } } }) }, "error with props");
          return { ok: true };
        });
        instance.post("/t/duplicate-user", { config: { auth: "public" } }, async () => {
          const row = { email: DUP_EMAIL, displayName: "Dup", passwordHash: DUP_HASH };
          await instance.db.insert(users).values(row);
          await instance.db.insert(users).values(row);
          return { ok: true };
        });
      }
    });
  });

  afterAll(async () => {
    await app.close();
  });

  /** Generate the logged traffic once, inside a test (not the hook) so it gets the test timeout. */
  function generateTraffic(): Promise<void> {
    traffic ??= (async () => {
      await app.inject({
        method: "POST",
        url: "/t/log?ticket=query-ticket-secret&page=2",
        headers: { authorization: `Bearer ${BEARER}`, cookie: COOKIE },
        payload: { any: "thing" }
      });
      await app.inject({ method: "GET", url: `/api/chat/ws?ticket=${TICKET}` });
      await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${BEARER}` } });
      const duplicate = await app.inject({ method: "POST", url: "/t/duplicate-user" });
      expect(duplicate.statusCode).toBe(500);
    })();
    return traffic;
  }

  it("captured request logs", async () => {
    await generateTraffic();

    expect(lines.some((line) => line.includes("incoming request"))).toBe(true);
    expect(lines.some((line) => line.includes("fixture log"))).toBe(true);
  });

  it("never writes tokens, cookies, tickets or passwords, at any depth or casing", async () => {
    await generateTraffic();

    const output = lines.join("\n");
    for (const secret of [
      "bearer-secret-value",
      "refresh-secret-value",
      TICKET,
      "query-ticket-secret",
      "top-level-token-secret",
      "capitalized-token-secret",
      "password-secret",
      "nested-password-secret",
      "nested-ticket-secret",
      "deep-password-secret",
      "err-prop-secret"
    ]) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain("visible-value");
    expect(output).toContain(REDACTED);
  });

  it("logs a failed DB query without its parameters (emails, password hashes)", async () => {
    await generateTraffic();

    const output = lines.join("\n");
    expect(output).not.toContain(DUP_EMAIL);
    expect(output).not.toContain("$argon2");
    expect(output).not.toContain("SECRETHASHVALUE");
    const failure = lines
      .map((line) => JSON.parse(line) as { msg?: string; err?: Record<string, unknown> }) // pino writes one JSON object per line
      .find((entry) => entry.msg === "request failed" && entry.err?.code === "23505");
    expect(failure?.err).toMatchObject({
      type: "DrizzleQueryError",
      code: "23505",
      constraint: "users_email_lower_unique",
      table: "users",
      message: expect.stringContaining('insert into "users"')
    });
  });

  it("logs the chat WebSocket URL with the ticket scrubbed", async () => {
    await generateTraffic();

    const urls = lines
      .map((line) => JSON.parse(line) as { req?: { url?: string } }) // pino writes one JSON object per line
      .map((entry) => entry.req?.url)
      .filter((url): url is string => url !== undefined);

    expect(urls).toContain(`/api/chat/ws?ticket=${REDACTED}`);
    expect(urls).toContain(`/t/log?ticket=${REDACTED}&page=${REDACTED}`);
  });
});

describe("scrubForLog / scrubLogObject", () => {
  it("redacts sensitive keys case-insensitively at any depth", () => {
    const nested: Record<string, unknown> = { leaf: { Authorization: "x", SessionTokenHash: "y", keep: 1 } };
    for (let level = 0; level < 10; level += 1) nested.inner = { ...nested };

    const scrubbed = JSON.stringify(scrubForLog({ Token: "a", PASSWORD: "b", list: [{ ticket: "c" }], nested }));

    expect(scrubbed).not.toMatch(/"(a|b|c|x|y)"/);
    expect(scrubbed).toContain('"keep":1');
  });

  it("handles cycles and non-plain objects without walking them", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;

    expect(scrubForLog({ cyclic, buffer: Buffer.from("secret") })).toEqual({
      cyclic: { name: "loop", self: "[Circular]" },
      buffer: "[Buffer]"
    });
  });

  it("leaves req/res/err for their serializers and redacts sensitive top-level keys", () => {
    const req = { raw: true };
    const result = scrubLogObject({ req, refreshToken: "z", other: { password: "p" } });

    expect(result.req).toBe(req);
    expect(result).toMatchObject({ refreshToken: REDACTED, other: { password: REDACTED } });
  });
});

describe("serializeError", () => {
  it("drops params, detail and the message's params line for a Drizzle query error", () => {
    const cause = Object.assign(new Error("duplicate key value violates unique constraint"), {
      name: "PostgresError",
      code: "23505",
      constraint_name: "users_email_lower_unique",
      table_name: "users",
      schema_name: "public",
      detail: `Key (lower(email))=(${DUP_EMAIL}) already exists.`
    });
    class DrizzleQueryError extends Error {
      readonly query = 'insert into "users" ("email") values ($1)';
      readonly params = [DUP_EMAIL];
      constructor() {
        super(`Failed query: insert into "users" ("email") values ($1)\nparams: ${DUP_EMAIL}`, { cause });
        this.name = "DrizzleQueryError";
      }
    }

    const serialized = serializeError(new DrizzleQueryError());

    expect(JSON.stringify(serialized)).not.toContain(DUP_EMAIL);
    expect(serialized).toMatchObject({
      type: "DrizzleQueryError",
      message: 'Failed query: insert into "users" ("email") values ($1)',
      code: "23505",
      constraint: "users_email_lower_unique",
      table: "users",
      schema: "public"
    });
  });

  it("keeps message, stack and scrubbed own properties of ordinary errors, including the cause", () => {
    const error = Object.assign(new Error("boom", { cause: new Error("inner") }), {
      statusCode: 502,
      Secret: "s",
      context: { refresh_token: "t" }
    });

    const serialized = serializeError(error);

    expect(serialized).toMatchObject({
      type: "Error",
      message: "boom",
      statusCode: 502,
      Secret: REDACTED,
      context: { refresh_token: REDACTED },
      cause: { message: "inner" }
    });
    expect(serialized.stack).toMatch(/^Error: boom\n\s+at /);
  });

  it("serializes thrown non-errors as scrubbed data", () => {
    expect(serializeError({ token: "x" })).toMatchObject({ value: { token: REDACTED } });
  });
});

describe("scrubUrl", () => {
  it("leaves URLs without a query unchanged", () => {
    expect(scrubUrl("/api/cuencadas/2026")).toBe("/api/cuencadas/2026");
  });

  it("keeps allowlisted enum, number and opaque-id parameters", () => {
    const url = "/x?limit=20&year=2026&status=active&role=admin&kind=photo&depth=2&scope=portal&entityType=user&action=user.update";
    expect(scrubUrl(url)).toBe(url);
    expect(scrubUrl("/api/chat/rooms/r1/messages?before=MTcwMDAwMDAwMDAwMF9hYmM&limit=50")).toBe(
      "/api/chat/rooms/r1/messages?before=MTcwMDAwMDAwMDAwMF9hYmM&limit=50"
    );
  });

  it("redacts every parameter that is not allowlisted, keeping its name", () => {
    expect(scrubUrl("/x?ticket=a&token=b&cursor=c&city=Monterrey&familyBranch=Rama%20Norte&page=2&year=2026")).toBe(
      `/x?ticket=${REDACTED}&token=${REDACTED}&cursor=${REDACTED}&city=${REDACTED}&familyBranch=${REDACTED}&page=${REDACTED}&year=2026`
    );
  });

  it("redacts free-text search terms (q, search), which may hold names", () => {
    expect(scrubUrl("/api/family/people?q=Ana")).toBe(`/api/family/people?q=${REDACTED}`);
    expect(scrubUrl("/api/directory?search=Ana%20Morales&limit=20")).toBe(`/api/directory?search=${REDACTED}&limit=20`);
  });

  it("redacts case variants of allowlisted names", () => {
    expect(scrubUrl("/x?Limit=5&LIMIT=6&Ticket=t")).toBe(`/x?Limit=${REDACTED}&LIMIT=${REDACTED}&Ticket=${REDACTED}`);
  });

  it("redacts array-style names, including arrays of allowlisted names", () => {
    expect(scrubUrl("/x?q[]=Ana&q[]=Luis&status[]=active")).toBe(
      `/x?q[]=${REDACTED}&q[]=${REDACTED}&status[]=${REDACTED}`
    );
    expect(scrubUrl("/x?q%5B%5D=Ana")).toBe(`/x?q%5B%5D=${REDACTED}`);
  });

  it("decodes percent-encoded names before matching, keeping the raw name", () => {
    expect(scrubUrl("/x?%71=Ana&%74icket=abc")).toBe(`/x?%71=${REDACTED}&%74icket=${REDACTED}`);
    expect(scrubUrl("/x?%6Cimit=5")).toBe("/x?%6Cimit=5");
  });

  it("handles every occurrence of a repeated parameter", () => {
    expect(scrubUrl("/x?q=Ana&limit=1&q=Luis&limit=2")).toBe(`/x?q=${REDACTED}&limit=1&q=${REDACTED}&limit=2`);
  });

  it("redacts allowlisted values that are not enum, number or id shaped", () => {
    expect(scrubUrl("/x?status=Ana%20Morales&kind=ana@example.com&role=a+b")).toBe(
      `/x?status=${REDACTED}&kind=${REDACTED}&role=${REDACTED}`
    );
    expect(scrubUrl(`/x?before=${"a".repeat(129)}`)).toBe(`/x?before=${REDACTED}`);
    expect(scrubUrl("/x?limit=%E0%A4%A")).toBe(`/x?limit=${REDACTED}`);
  });

  it("drops the whole pair when the name is undecodable or not a plain identifier", () => {
    expect(scrubUrl("/x?%E0%A4%A=abc&limit=1")).toBe(`/x?${REDACTED}&limit=1`);
    expect(scrubUrl("/x?Ana%20Morales=1&limit=1")).toBe(`/x?${REDACTED}&limit=1`);
    expect(scrubUrl("/x?ana%40example.com&limit=1")).toBe(`/x?${REDACTED}&limit=1`);
  });

  it("handles empty and valueless parameters", () => {
    expect(scrubUrl("/x?&ticket&limit&a=")).toBe(`/x?&ticket=${REDACTED}&limit&a=${REDACTED}`);
  });
});
