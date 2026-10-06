import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestApp, createTestConfig } from "../test/helpers/app.js";
import { buildApp } from "./app.js";

const created = vi.hoisted(() => ({ closes: [] as Array<ReturnType<typeof vi.fn>> }));

// Wrap createDatabase so each pool the app creates exposes a spied close().
vi.mock("./db/client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./db/client.js")>();
  return {
    ...original,
    createDatabase: (...args: Parameters<typeof original.createDatabase>) => {
      const db = original.createDatabase(...args);
      const realClose = db.close;
      const close = vi.fn(() => realClose());
      created.closes.push(close);
      return Object.assign(db, { close });
    }
  };
});

describe("app lifecycle", () => {
  beforeEach(() => {
    created.closes.length = 0;
  });

  it("closes the pool it created when buildApp fails partway", async () => {
    // Production without RESEND_API_KEY: the mailer cannot be created, after the pool was.
    const config = createTestConfig({ NODE_ENV: "production", LOG_LEVEL: "silent", RESEND_API_KEY: undefined });

    await expect(buildApp(config)).rejects.toThrow(/DevMailer/);

    expect(created.closes).toHaveLength(1);
    expect(created.closes[0]).toHaveBeenCalled();
  });

  it("closes the pool when a test fixture throws while registering routes", async () => {
    await expect(
      createTestApp({
        routes: () => {
          throw new Error("fixture boom");
        }
      })
    ).rejects.toThrow("fixture boom");

    expect(created.closes).toHaveLength(1);
    expect(created.closes[0]).toHaveBeenCalled();
  });

  it("closes the pool when ready() fails", async () => {
    await expect(
      createTestApp({
        routes: (app) => {
          void app.register(async () => {
            throw new Error("plugin boom");
          });
        }
      })
    ).rejects.toThrow("plugin boom");

    expect(created.closes[0]).toHaveBeenCalled();
  });

  it("closes the pool exactly through onClose on a normal shutdown", async () => {
    const app = await createTestApp();
    expect(created.closes[0]).not.toHaveBeenCalled();

    await app.close();

    expect(created.closes[0]).toHaveBeenCalledOnce();
  });
});
