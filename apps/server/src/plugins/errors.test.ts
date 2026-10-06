import { API_ERROR_DETAILS_MAX } from "@cuencada/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createTestApp } from "../../test/helpers/app.js";
import type { App } from "../app.js";
import { AppError } from "../lib/errors.js";
import { capErrorDetails, resolveError } from "./errors.js";

interface ErrorBody {
  error: { code: string; message: string; details?: Array<{ path: string; message: string }> };
}

const SECRET_DETAIL = "db password hunter2 at /srv/cuencada/secret.ts";

async function registerFixtures(app: App): Promise<void> {
  const publicConfig = { auth: "public" } as const;

  app.get("/t/boom", { config: publicConfig }, async () => {
    throw new Error(SECRET_DETAIL);
  });
  app.post(
    "/t/numbers",
    { config: publicConfig, schema: { body: z.object({ values: z.array(z.number()) }) } },
    async () => ({ ok: true })
  );
  app.get("/t/conflict", { config: publicConfig }, async () => {
    throw new AppError("CONFLICT", "Ese año ya existe.", { details: [{ path: "year", message: "Duplicado." }] });
  });
  app.get("/t/parse", { config: publicConfig }, async () => {
    z.object({ year: z.number() }).parse({ year: "nope" });
    return { ok: true };
  });
  app.get(
    "/t/bad-response",
    { config: publicConfig, schema: { response: { 200: z.object({ id: z.uuid() }) } } },
    async () => ({ id: "not-a-uuid" }) as unknown as { id: string } // deliberately violates the schema
  );
  app.post("/t/small", { config: publicConfig, bodyLimit: 16 }, async () => ({ ok: true }));
}

describe("global error handler", () => {
  let app: App;

  beforeAll(async () => {
    app = await createTestApp({ routes: registerFixtures });
  });

  afterAll(async () => {
    await app.close();
  });

  it("answers 500 INTERNAL with a generic message and no stack or internal message", async () => {
    const response = await app.inject({ method: "GET", url: "/t/boom" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: "INTERNAL", message: "Ocurrió un error inesperado. Intenta de nuevo más tarde." }
    });
    expect(response.body).not.toContain("hunter2");
    expect(response.body).not.toContain("secret.ts");
  });

  it("answers 400 VALIDATION with details capped at the contract maximum", async () => {
    const values = Array.from({ length: 150 }, (_, index) => `x${index}`);

    const response = await app.inject({ method: "POST", url: "/t/numbers", payload: { values } });

    expect(response.statusCode).toBe(400);
    const body = response.json<ErrorBody>();
    expect(body.error.code).toBe("VALIDATION");
    expect(body.error.details).toHaveLength(API_ERROR_DETAILS_MAX);
    expect(body.error.details?.[0]?.path).toBe("values.0");
    // zod defaults are Spanish (z.config(z.locales.es()) at boot).
    expect(body.error.details?.[0]?.message).toMatch(/esperaba/);
    expect(body.error.details?.at(-1)).toEqual({ path: "", message: "Y 51 problemas más." });
  });

  it("maps an AppError to its status, Spanish message and details", async () => {
    const response = await app.inject({ method: "GET", url: "/t/conflict" });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: { code: "CONFLICT", message: "Ese año ya existe.", details: [{ path: "year", message: "Duplicado." }] }
    });
  });

  it("maps a ZodError thrown inside a handler to 400 VALIDATION", async () => {
    const response = await app.inject({ method: "GET", url: "/t/parse" });

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.details?.[0]?.path).toBe("year");
  });

  it("answers 500 INTERNAL when a response does not match its schema", async () => {
    const response = await app.inject({ method: "GET", url: "/t/bad-response" });

    expect(response.statusCode).toBe(500);
    expect(response.json<ErrorBody>().error.code).toBe("INTERNAL");
    expect(response.body).not.toContain("not-a-uuid");
  });

  it("answers 413 PAYLOAD_TOO_LARGE when the body exceeds the route limit", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/t/small",
      payload: { text: "a".repeat(100) }
    });

    expect(response.statusCode).toBe(413);
    expect(response.json<ErrorBody>().error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("answers 404 NOT_FOUND for unknown routes and methods", async () => {
    const response = await app.inject({ method: "DELETE", url: "/t/boom" });

    expect(response.statusCode).toBe(404);
    expect(response.json<ErrorBody>().error.code).toBe("NOT_FOUND");
  });
});

describe("capErrorDetails", () => {
  it("returns the list unchanged when it is within the cap", () => {
    const details = [{ path: "a", message: "m" }];

    expect(capErrorDetails(details)).toEqual(details);
  });

  it("keeps exactly the maximum when the list is exactly at the cap", () => {
    const details = Array.from({ length: API_ERROR_DETAILS_MAX }, (_, index) => ({ path: `p${index}`, message: "m" }));

    expect(capErrorDetails(details)).toEqual(details);
  });

  it("truncates long paths and messages to the contract bounds", () => {
    const [detail] = capErrorDetails([{ path: "p".repeat(300), message: "m".repeat(600) }]);

    expect(detail?.path).toHaveLength(200);
    expect(detail?.message).toHaveLength(500);
  });
});

describe("resolveError", () => {
  it("treats a non-Fastify error carrying a 4xx statusCode as internal", () => {
    const error = Object.assign(new Error("upstream said 400"), { statusCode: 400 });

    expect(resolveError(error).code).toBe("INTERNAL");
  });

  it("treats thrown non-errors as internal", () => {
    expect(resolveError("a string").status).toBe(500);
    expect(resolveError(null).code).toBe("INTERNAL");
  });
});
