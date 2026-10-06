import { opaqueTokenSchema } from "@cuencada/types";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import {
  ACCESS_TOKEN_AUDIENCE,
  ACCESS_TOKEN_ISSUER,
  accessTokenSettings,
  createOpaqueToken,
  hashToken,
  safeEqual,
  signAccessToken,
  verifyAccessToken
} from "./tokens.js";

const settings = accessTokenSettings({
  JWT_SECRET: "unit-test-secret-with-at-least-32-characters",
  ACCESS_TOKEN_TTL_SECONDS: 900
});
const claims = {
  userId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  role: "member",
  mustChangePassword: false
} as const;

describe("createOpaqueToken", () => {
  it("creates unique 256-bit base64url tokens accepted by the contract schema", () => {
    const first = createOpaqueToken();
    const second = createOpaqueToken();

    expect(first).toHaveLength(43);
    expect(first).not.toBe(second);
    expect(opaqueTokenSchema.safeParse(first).success).toBe(true);
  });
});

describe("hashToken", () => {
  it("returns a stable sha-256 hex digest that differs from the token", () => {
    const token = createOpaqueToken();

    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toContain(token);
  });
});

describe("safeEqual", () => {
  it("compares equal and unequal strings, including different lengths and empty strings", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
    expect(safeEqual("", "a")).toBe(false);
  });
});

describe("signAccessToken / verifyAccessToken", () => {
  it("round-trips the claims and reports the expiry", async () => {
    const now = new Date("2026-10-06T12:00:00Z");
    const signed = await signAccessToken(settings, claims, now);

    expect(signed.expiresAt.toISOString()).toBe("2026-10-06T12:15:00.000Z");
    await expect(verifyAccessToken(settings, signed.token, now)).resolves.toEqual({ ok: true, claims });
  });

  it("reports expired tokens as expired, at exactly exp", async () => {
    const now = new Date("2026-10-06T12:00:00Z");
    const signed = await signAccessToken(settings, claims, now);

    await expect(verifyAccessToken(settings, signed.token, signed.expiresAt)).resolves.toEqual({
      ok: false,
      reason: "expired"
    });
  });

  it("rejects a token signed with another secret", async () => {
    const other = accessTokenSettings({ JWT_SECRET: "another-secret-with-at-least-32-characters", ACCESS_TOKEN_TTL_SECONDS: 900 });
    const signed = await signAccessToken(other, claims);

    await expect(verifyAccessToken(settings, signed.token)).resolves.toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects garbage", async () => {
    await expect(verifyAccessToken(settings, "not-a-jwt")).resolves.toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects a token with the wrong issuer or audience", async () => {
    const forge = (issuer: string, audience: string) =>
      new SignJWT({ sid: claims.sessionId, role: "admin", mcp: false })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(claims.userId)
        .setIssuer(issuer)
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(settings.secret);

    await expect(verifyAccessToken(settings, await forge("evil", ACCESS_TOKEN_AUDIENCE))).resolves.toMatchObject({
      ok: false
    });
    await expect(verifyAccessToken(settings, await forge(ACCESS_TOKEN_ISSUER, "evil"))).resolves.toMatchObject({
      ok: false
    });
  });

  it("rejects a token missing the sid claim or with an unknown role", async () => {
    const base = () =>
      new SignJWT({ role: "member", mcp: false })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(claims.userId)
        .setIssuer(ACCESS_TOKEN_ISSUER)
        .setAudience(ACCESS_TOKEN_AUDIENCE)
        .setIssuedAt()
        .setExpirationTime("5m");
    const noSid = await base().sign(settings.secret);
    const badRole = await new SignJWT({ sid: claims.sessionId, role: "root", mcp: false })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(claims.userId)
      .setIssuer(ACCESS_TOKEN_ISSUER)
      .setAudience(ACCESS_TOKEN_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(settings.secret);

    await expect(verifyAccessToken(settings, noSid)).resolves.toEqual({ ok: false, reason: "invalid" });
    await expect(verifyAccessToken(settings, badRole)).resolves.toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects the unsigned alg=none form", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        sub: claims.userId,
        sid: claims.sessionId,
        role: "admin",
        mcp: false,
        iss: ACCESS_TOKEN_ISSUER,
        aud: ACCESS_TOKEN_AUDIENCE,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 300
      })
    ).toString("base64url");

    await expect(verifyAccessToken(settings, `${header}.${payload}.`)).resolves.toEqual({
      ok: false,
      reason: "invalid"
    });
  });
});
