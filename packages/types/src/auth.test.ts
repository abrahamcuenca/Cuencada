import { describe, expect, it } from "vitest";
import {
  adminInviteCreateInputSchema,
  changePasswordInputSchema,
  inviteAcceptInputSchema,
  loginInputSchema,
  magicLinkConsumeInputSchema,
  passwordSchema
} from "./auth.js";
import { emailSchema } from "./common.js";

const validToken = "a".repeat(43);

describe("passwordSchema", () => {
  it("accepts exactly 12 characters", () => {
    expect(passwordSchema.safeParse("abcdefghijkl").success).toBe(true);
  });

  it("rejects 11 characters with a Spanish message", () => {
    const result = passwordSchema.safeParse("abcdefghijk");
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("al menos 12");
  });

  it("accepts exactly 128 characters and rejects 129", () => {
    expect(passwordSchema.safeParse("x".repeat(128)).success).toBe(true);
    expect(passwordSchema.safeParse("x".repeat(129)).success).toBe(false);
  });

  it("rejects a password made only of whitespace", () => {
    expect(passwordSchema.safeParse(" ".repeat(16)).success).toBe(false);
  });

  it("does not trim surrounding spaces", () => {
    expect(passwordSchema.parse("  long enough pw  ")).toBe("  long enough pw  ");
  });
});

describe("changePasswordInputSchema", () => {
  it("rejects a new password equal to the current one", () => {
    const result = changePasswordInputSchema.safeParse({
      currentPassword: "same-password-123",
      newPassword: "same-password-123"
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["newPassword"]);
  });

  it("accepts a short current password but enforces policy on the new one", () => {
    expect(changePasswordInputSchema.safeParse({ currentPassword: "Temp1!", newPassword: "a-much-better-one" }).success).toBe(true);
    expect(changePasswordInputSchema.safeParse({ currentPassword: "Temp1!", newPassword: "short" }).success).toBe(false);
  });
});

describe("emailSchema", () => {
  it("trims and lowercases before validating", () => {
    expect(emailSchema.parse("  Ana.Cuenca@Example.COM ")).toBe("ana.cuenca@example.com");
  });

  it("rejects malformed addresses", () => {
    expect(emailSchema.safeParse("not-an-email").success).toBe(false);
    expect(emailSchema.safeParse("").success).toBe(false);
  });

  it("rejects addresses longer than 254 characters", () => {
    const local = "a".repeat(64);
    const domain = `${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.com`;
    expect(emailSchema.safeParse(`${local}@${domain}`).success).toBe(false);
  });

  it("normalizes the email in login input", () => {
    expect(loginInputSchema.parse({ email: "ADMIN@Cuencada.com", password: "x" }).email).toBe("admin@cuencada.com");
  });
});

describe("token inputs", () => {
  it("accepts a base64url token in the body", () => {
    expect(magicLinkConsumeInputSchema.safeParse({ token: validToken }).success).toBe(true);
  });

  it("rejects tokens with non-base64url characters or too short", () => {
    expect(magicLinkConsumeInputSchema.safeParse({ token: `${validToken}/` }).success).toBe(false);
    expect(magicLinkConsumeInputSchema.safeParse({ token: "abc" }).success).toBe(false);
  });

  it("applies password policy and email normalization on invite accept", () => {
    const parsed = inviteAcceptInputSchema.parse({
      token: validToken,
      email: " Prima@Familia.MX ",
      displayName: "  Prima Lupita ",
      password: "contraseña-segura"
    });
    expect(parsed.email).toBe("prima@familia.mx");
    expect(parsed.displayName).toBe("Prima Lupita");
  });
});

describe("adminInviteCreateInputSchema", () => {
  it("applies defaults for a member invite bound to an email", () => {
    expect(adminInviteCreateInputSchema.parse({ email: "tio@familia.mx" })).toEqual({
      email: "tio@familia.mx",
      role: "member",
      maxUses: 1,
      expiresInDays: 7,
      personId: null,
      sendEmail: true,
      note: null
    });
  });

  it("requires an email when sendEmail is true", () => {
    expect(adminInviteCreateInputSchema.safeParse({}).success).toBe(false);
    expect(adminInviteCreateInputSchema.safeParse({ sendEmail: false, maxUses: 10 }).success).toBe(true);
  });

  it("rejects open or multi-use admin invites", () => {
    expect(adminInviteCreateInputSchema.safeParse({ role: "admin", sendEmail: false }).success).toBe(false);
    expect(adminInviteCreateInputSchema.safeParse({ role: "admin", email: "a@b.mx", maxUses: 2 }).success).toBe(false);
  });
});
