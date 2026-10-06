import argon2 from "argon2";
import { describe, expect, it } from "vitest";
import { hashPassword, needsRehash, verifyDummyPassword, verifyPassword } from "./passwords.js";

describe("hashPassword", () => {
  it("produces an argon2id hash with the OWASP parameters", async () => {
    const hash = await hashPassword("una-contraseña-larga");

    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });
});

describe("verifyPassword", () => {
  it("accepts the right password and rejects a wrong one", async () => {
    const hash = await hashPassword("una-contraseña-larga");

    await expect(verifyPassword(hash, "una-contraseña-larga")).resolves.toBe(true);
    await expect(verifyPassword(hash, "otra-contraseña")).resolves.toBe(false);
  });

  it("treats a malformed stored hash as a mismatch instead of throwing", async () => {
    await expect(verifyPassword("not-a-hash", "anything")).resolves.toBe(false);
  });
});

describe("needsRehash", () => {
  it("is false for current parameters and true for weaker ones or garbage", async () => {
    const current = await hashPassword("pw-current-params");
    const weak = await argon2.hash("pw-weak-params", { type: argon2.argon2id, memoryCost: 4096, timeCost: 2, parallelism: 1 });

    expect(needsRehash(current)).toBe(false);
    expect(needsRehash(weak)).toBe(true);
    expect(needsRehash("garbage")).toBe(true);
  });
});

describe("verifyDummyPassword", () => {
  it("always resolves false", async () => {
    await expect(verifyDummyPassword("cuencada-dummy-password-for-timing")).resolves.toBe(false);
    await expect(verifyDummyPassword("")).resolves.toBe(false);
  });
});
