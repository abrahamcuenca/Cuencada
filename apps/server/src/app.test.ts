import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { AppConfig } from "./config.js";

const testConfig: AppConfig = {
  NODE_ENV: "test",
  HOST: "127.0.0.1",
  PORT: 3006,
  CORS_ORIGIN: "http://localhost:5173",
  DATABASE_URL: "postgresql://cuencada:cuencada@127.0.0.1:5432/cuencada_test",
  JWT_SECRET: "test-secret-at-least-sixteen-characters",
  SEED_ADMIN_EMAIL: "admin@cuencada.com",
  SEED_ADMIN_TEMP_PASSWORD: "Password123!",
  S3_ENDPOINT: "",
  S3_REGION: "us-southeast-1",
  S3_BUCKET: "",
  S3_ACCESS_KEY_ID: "",
  S3_SECRET_ACCESS_KEY: "",
  S3_PUBLIC_BASE_URL: ""
};

describe("buildApp", () => {
  it("returns health status for the API", async () => {
    const app = await buildApp(testConfig);
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, service: "cuencada-api" });

    await app.close();
  });
});
