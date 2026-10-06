import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp } from "../test/helpers/app.js";
import { createUser, loginAs } from "../test/helpers/factories.js";

describe("buildApp", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await createTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns health status for the API", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, service: "cuencada-api" });
  });
});

describe("POST /api/auth/login", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await createTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns the user and an access token when the credentials are valid", async () => {
    const user = await createUser({ email: "Prima@Example.test", role: "admin", mustChangePassword: true });

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "prima@example.test", password: user.password }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ user: unknown; accessToken: unknown }>();
    expect(body.user).toEqual({
      id: user.id,
      email: "prima@example.test",
      displayName: user.displayName,
      role: "admin",
      mustChangePassword: true
    });
    expect(typeof body.accessToken).toBe("string");
  });

  it("returns 401 when the password is wrong", async () => {
    const user = await createUser();

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: user.email, password: "not-the-password" }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Correo o contraseña incorrectos." });
  });

  it("returns 401 when no user has that email", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "nadie@example.test", password: "whatever-password" }
    });

    expect(response.statusCode).toBe(401);
  });

  it("returns a 500 for a malformed body because there is no error handler yet", async () => {
    // Current behaviour: zod's parse() throws and Fastify's default handler
    // answers 500. WP-0.4 adds the zod -> 400 error handler; flip this then.
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "not-an-email" }
    });

    expect(response.statusCode).toBe(500);
  });

  it.todo("returns 400 for a malformed body (WP-0.4 error handler)");
});

describe("GET /api/me", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await createTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns the current user when called with the token from loginAs", async () => {
    const user = await createUser();
    const auth = await loginAs(app, user);

    const response = await app.inject({ method: "GET", url: "/api/me", ...auth });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ user: { id: string } }>().user.id).toBe(user.id);
  });

  it("returns 401 without a token", async () => {
    const response = await app.inject({ method: "GET", url: "/api/me" });

    expect(response.statusCode).toBe(401);
  });
});
