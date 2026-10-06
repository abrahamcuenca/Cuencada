import { describe, expect, it } from "vitest";
import { assertDrizzleCommandAllowed, dangerousDrizzleCommand, isLoopbackDatabaseUrl } from "./drizzle-guard.js";

const BIN = ["/usr/bin/node", "/repo/node_modules/drizzle-kit/bin.cjs"];
const LOCAL = "postgresql://dev:pw@127.0.0.1:5432/cuencada";
const REMOTE = "postgresql://app:pw@db.example.com:5432/cuencada";

describe("isLoopbackDatabaseUrl", () => {
  it("accepts localhost, 127.0.0.0/8 and ::1", () => {
    expect(isLoopbackDatabaseUrl("postgresql://u:p@localhost/db")).toBe(true);
    expect(isLoopbackDatabaseUrl("postgresql://u:p@LOCALHOST:5432/db")).toBe(true);
    expect(isLoopbackDatabaseUrl("postgresql://u:p@127.0.0.1:5432/db")).toBe(true);
    expect(isLoopbackDatabaseUrl("postgresql://u:p@127.10.0.2/db")).toBe(true);
    expect(isLoopbackDatabaseUrl("postgresql://u:p@[::1]:5432/db")).toBe(true);
  });

  it("rejects remote hosts, look-alikes and unparseable URLs", () => {
    expect(isLoopbackDatabaseUrl(REMOTE)).toBe(false);
    expect(isLoopbackDatabaseUrl("postgresql://u:p@127.0.0.1.example.com/db")).toBe(false);
    expect(isLoopbackDatabaseUrl("postgresql://u:p@localhost.example.com/db")).toBe(false);
    expect(isLoopbackDatabaseUrl("postgresql://u:p@10.0.0.5/db")).toBe(false);
    expect(isLoopbackDatabaseUrl("")).toBe(false);
    expect(isLoopbackDatabaseUrl("not a url")).toBe(false);
  });
});

describe("dangerousDrizzleCommand", () => {
  it("finds push and drop as the command and ignores other commands", () => {
    expect(dangerousDrizzleCommand([...BIN, "push", "--force"])).toBe("push");
    expect(dangerousDrizzleCommand([...BIN, "drop"])).toBe("drop");
    expect(dangerousDrizzleCommand([...BIN, "--verbose", "push"])).toBe("push");
    expect(dangerousDrizzleCommand([...BIN, "generate"])).toBeUndefined();
    expect(dangerousDrizzleCommand([...BIN, "migrate"])).toBeUndefined();
    expect(dangerousDrizzleCommand([...BIN])).toBeUndefined();
  });

  it("only matches the command, not a later argument", () => {
    expect(dangerousDrizzleCommand([...BIN, "generate", "--name", "push"])).toBeUndefined();
    expect(dangerousDrizzleCommand([...BIN, "check", "drop"])).toBeUndefined();
  });
});

describe("assertDrizzleCommandAllowed", () => {
  it("allows non-destructive commands without any opt-in", () => {
    expect(() => assertDrizzleCommandAllowed([...BIN, "generate"], {}, REMOTE)).not.toThrow();
  });

  it("throws on push without ALLOW_DRIZZLE_PUSH=1, even on loopback", () => {
    expect(() => assertDrizzleCommandAllowed([...BIN, "push"], {}, LOCAL)).toThrow(/drizzle-kit push is disabled/);
    expect(() => assertDrizzleCommandAllowed([...BIN, "push"], { ALLOW_DRIZZLE_PUSH: "true" }, LOCAL)).toThrow();
  });

  it("throws on push or drop against a remote database even with the opt-in", () => {
    expect(() => assertDrizzleCommandAllowed([...BIN, "push"], { ALLOW_DRIZZLE_PUSH: "1" }, REMOTE)).toThrow();
    expect(() => assertDrizzleCommandAllowed([...BIN, "drop"], { ALLOW_DRIZZLE_PUSH: "1" }, REMOTE)).toThrow(
      /drizzle-kit drop is disabled/
    );
  });

  it("never puts the database URL (with its password) in the error", () => {
    expect(() => assertDrizzleCommandAllowed([...BIN, "push"], {}, REMOTE)).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("db.example.com") })
    );
  });

  it("allows push with the opt-in against a loopback database", () => {
    expect(() => assertDrizzleCommandAllowed([...BIN, "push"], { ALLOW_DRIZZLE_PUSH: "1" }, LOCAL)).not.toThrow();
  });
});
