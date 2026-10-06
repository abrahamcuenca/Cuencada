import { CHAT_UNREAD_COUNT_MAX } from "@cuencada/types";
import { describe, expect, it } from "vitest";
import { UNREAD_COUNT_MAX } from "./limits";

describe("chat limits", () => {
  it("mirror the contract constants", () => {
    expect(UNREAD_COUNT_MAX).toBe(CHAT_UNREAD_COUNT_MAX);
  });
});
