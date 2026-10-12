import { describe, expect, it } from "vitest";
import { AuditAction, auditActionSchema } from "./admin.js";
import { ErrorCode, errorHttpStatus } from "./common.js";
import {
  formatRecoveryCode,
  isTwoFactorChallenge,
  loginResponseSchema,
  normalizeRecoveryCode,
  recoveryCodeSchema,
  totpCodeSchema,
  twoFactorDisableInputSchema,
  twoFactorVerifyInputSchema
} from "./twoFactor.js";

const TOKEN = "a".repeat(43);

describe("totpCodeSchema", () => {
  it("accepts six digits and drops spaces", () => {
    expect(totpCodeSchema.parse("123 456")).toBe("123456");
  });

  it("rejects letters, short and long codes", () => {
    for (const value of ["12345", "1234567", "12345a", ""]) {
      expect(totpCodeSchema.safeParse(value).success, value).toBe(false);
    }
  });
});

describe("recoveryCodeSchema", () => {
  it("normalizes case, dashes and spaces", () => {
    expect(recoveryCodeSchema.parse("ABCD-EFGH ijkl-mnop")).toBe("abcdefghijklmnop");
    expect(normalizeRecoveryCode(formatRecoveryCode("abcdefghijklmnop"))).toBe("abcdefghijklmnop");
  });

  it("rejects characters outside base32 and wrong lengths", () => {
    for (const value of ["abcd-efgh-ijkl-mno1", "abcd", "abcd-efgh-ijkl-mnop-q"]) {
      expect(recoveryCodeSchema.safeParse(value).success, value).toBe(false);
    }
  });
});

describe("twoFactorVerifyInputSchema", () => {
  it("requires exactly one of code and recoveryCode", () => {
    expect(twoFactorVerifyInputSchema.safeParse({ challengeToken: TOKEN }).success).toBe(false);
    expect(
      twoFactorVerifyInputSchema.safeParse({ challengeToken: TOKEN, code: "123456", recoveryCode: "abcdefghijklmnop" })
        .success
    ).toBe(false);
    expect(twoFactorVerifyInputSchema.parse({ challengeToken: TOKEN, code: "123456" }).trustDevice).toBe(false);
  });

  it("applies the same rule to disable", () => {
    expect(twoFactorDisableInputSchema.safeParse({ currentPassword: "x" }).success).toBe(false);
    expect(twoFactorDisableInputSchema.safeParse({ currentPassword: "x", recoveryCode: "abcdefghijklmnop" }).success).toBe(
      true
    );
  });
});

describe("loginResponseSchema", () => {
  it("parses the challenge branch and narrows it", () => {
    const parsed = loginResponseSchema.parse({
      twoFactorRequired: true,
      challengeToken: TOKEN,
      trustDeviceAllowed: false,
      expiresAt: "2026-10-11T10:00:00Z"
    });
    expect(isTwoFactorChallenge(parsed)).toBe(true);
  });
});

describe("WP-7 codes and actions", () => {
  it("maps the new error codes to their statuses", () => {
    expect(errorHttpStatus[ErrorCode.TWO_FACTOR_SETUP_REQUIRED]).toBe(403);
    expect(errorHttpStatus[ErrorCode.TWO_FACTOR_INVALID]).toBe(400);
  });

  it("accepts the 2fa audit actions", () => {
    for (const action of [AuditAction.TwoFactorVerified, AuditAction.TwoFactorFailed, AuditAction.UserTwoFactorReset]) {
      expect(auditActionSchema.safeParse(action).success, action).toBe(true);
    }
    expect(auditActionSchema.safeParse("auth.").success).toBe(false);
  });
});
