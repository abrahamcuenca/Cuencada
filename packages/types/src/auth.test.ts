import { describe, expect, it } from "vitest";
import {
  adminInviteCreateInputSchema,
  changePasswordInputSchema,
  displayNameSchema,
  hasVisibleNameChars,
  inviteAcceptInputSchema,
  loginInputSchema,
  magicLinkConsumeInputSchema,
  maskEmail,
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
    expect(emailSchema.parse("  Ana.Morales@Example.COM ")).toBe("ana.morales@example.com");
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

  it("requires admin invites to be delivered by email (no copy-link)", () => {
    const result = adminInviteCreateInputSchema.safeParse({ role: "admin", email: "a@b.mx", sendEmail: false });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.path[0] === "sendEmail")).toBe(true);
    expect(adminInviteCreateInputSchema.safeParse({ role: "admin", email: "a@b.mx" }).success).toBe(true);
  });

  it("caps open member invites at 20 uses and 14 days", () => {
    expect(adminInviteCreateInputSchema.safeParse({ sendEmail: false, maxUses: 20, expiresInDays: 14 }).success).toBe(true);
    expect(adminInviteCreateInputSchema.safeParse({ sendEmail: false, maxUses: 21 }).success).toBe(false);
    expect(adminInviteCreateInputSchema.safeParse({ sendEmail: false, expiresInDays: 15 }).success).toBe(false);
  });

  it("forces email-bound member invites to a single use", () => {
    const result = adminInviteCreateInputSchema.safeParse({ email: "tio@familia.mx", maxUses: 2 });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((issue) => issue.path[0] === "maxUses")).toBe(true);
    expect(adminInviteCreateInputSchema.safeParse({ email: "tio@familia.mx", sendEmail: false, maxUses: 1 }).success).toBe(
      true
    );
  });
});

describe("displayNameSchema invisible-only names", () => {
  it.each([
    ["Hangul filler", "\u3164"],
    ["word joiner", "\u2060\u2060"],
    ["soft hyphen", "\u00AD"],
    ["Hangul filler and spaces", "\u3164 \u3164"],
    ["braille blank", "\u2800"],
    ["combining grapheme joiner", "\u034F"]
  ])("rejects a name made only of %s", (_label, name) => {
    expect(displayNameSchema.safeParse(name).success).toBe(false);
  });

  it("accepts normal names, including accents and a soft hyphen inside a word", () => {
    expect(displayNameSchema.parse("José Morales")).toBe("José Morales");
    expect(displayNameSchema.safeParse("Ana\u00ADMaría").success).toBe(true);
  });

  it("hasVisibleNameChars is false only when nothing visible remains", () => {
    expect(hasVisibleNameChars("\u3164\u2060 ")).toBe(false);
    expect(hasVisibleNameChars("\u3164a")).toBe(true);
  });
});

describe("maskEmail", () => {
  it("keeps only the first characters and the TLD", () => {
    expect(maskEmail("tia.lupe@example.com")).toBe("t***@e***.com");
    expect(maskEmail("ab@gmail.com.mx")).toBe("a***@g***.mx");
  });

  it("never returns the full address, even for short ones", () => {
    expect(maskEmail("a@b.co")).toBe("a***@b***.co");
    expect(maskEmail("a@b.co")).not.toContain("a@b");
  });

  it("handles malformed input without throwing", () => {
    expect(maskEmail("nope")).toBe("***");
    expect(maskEmail("x@localhost")).toBe("x***@l***");
  });
});

describe("displayNameSchema via inviteAcceptInputSchema", () => {
  it("rejects RTL-override and invisible display names", () => {
    const base = { token: validToken, email: "a@b.mx", password: "contraseña-segura" };
    expect(inviteAcceptInputSchema.safeParse({ ...base, displayName: "\u202E" }).success).toBe(false);
    expect(inviteAcceptInputSchema.safeParse({ ...base, displayName: "Admin\u200B" }).success).toBe(false);
  });
});
