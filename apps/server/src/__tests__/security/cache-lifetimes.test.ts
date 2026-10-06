/**
 * WP-2.3 N1: photos and avatars stored in the bucket carry a `Cache-Control`
 * that is private and no longer than the presigned GET URL that hands them
 * out. Before, it was `max-age=31536000, immutable`, so family photos stayed
 * in a shared browser's disk cache for a year after logout.
 */
import { describe, expect, it } from "vitest";
import { DERIVATIVE_CACHE_CONTROL, VIEW_URL_SECONDS } from "../../modules/media/constants.js";
import { AVATAR_CACHE_CONTROL, AVATAR_URL_TTL_SECONDS } from "../../modules/profile/constants.js";

function maxAge(header: string): number {
  const match = /(?:^|,\s*)max-age=(\d+)/.exec(header);
  if (match?.[1] === undefined) throw new Error(`no max-age in ${header}`);
  return Number(match[1]);
}

describe("stored media cache lifetimes", () => {
  it.each([
    ["gallery derivatives", DERIVATIVE_CACHE_CONTROL, VIEW_URL_SECONDS],
    ["avatars", AVATAR_CACHE_CONTROL, AVATAR_URL_TTL_SECONDS]
  ])("%s are private, not immutable, and expire no later than their presigned URL", (_label, header, urlSeconds) => {
    expect(header).toMatch(/(^|,\s*)private(,|$)/);
    expect(header).not.toContain("immutable");
    expect(header).not.toContain("public");
    expect(maxAge(header)).toBeLessThanOrEqual(urlSeconds);
    expect(urlSeconds).toBeLessThanOrEqual(3600);
  });
});
