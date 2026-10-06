import { describe, expect, it } from "vitest";
import { decideScroll, isNearBottom, type ListEdges, NEAR_BOTTOM_PX } from "./scroll";
import { chatPaneGeometry } from "./useChatViewport";

const edges = (firstId: string | null, lastId: string | null, count: number): ListEdges => ({ firstId, lastId, count });

describe("isNearBottom", () => {
  it("is true at the bottom and within the threshold, false further up", () => {
    expect(isNearBottom({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 })).toBe(true);
    expect(isNearBottom({ scrollTop: 600 - NEAR_BOTTOM_PX, scrollHeight: 1000, clientHeight: 400 })).toBe(true);
    expect(isNearBottom({ scrollTop: 600 - NEAR_BOTTOM_PX - 1, scrollHeight: 1000, clientHeight: 400 })).toBe(false);
  });
});

describe("decideScroll", () => {
  it("jumps to the bottom on the first render", () => {
    expect(decideScroll({ previous: edges(null, null, 0), next: edges("a", "c", 3), wasNearBottom: false, newestIsMine: false })).toBe("bottom");
  });

  it("follows new messages only when the reader was near the bottom", () => {
    const previous = edges("a", "c", 3);
    const next = edges("a", "d", 4);
    expect(decideScroll({ previous, next, wasNearBottom: true, newestIsMine: false })).toBe("bottom");
    expect(decideScroll({ previous, next, wasNearBottom: false, newestIsMine: false })).toBe("pill");
  });

  it("always follows my own new message", () => {
    expect(decideScroll({ previous: edges("a", "c", 3), next: edges("a", "me", 4), wasNearBottom: false, newestIsMine: true })).toBe("bottom");
  });

  it("preserves the position when older messages are prepended", () => {
    expect(decideScroll({ previous: edges("c", "f", 4), next: edges("a", "f", 6), wasNearBottom: false, newestIsMine: false })).toBe("preserve");
  });

  it("does nothing for in-place changes (tombstones) or an empty list", () => {
    expect(decideScroll({ previous: edges("a", "c", 3), next: edges("a", "c", 3), wasNearBottom: false, newestIsMine: false })).toBe("none");
    expect(decideScroll({ previous: edges("a", "c", 3), next: edges(null, null, 0), wasNearBottom: true, newestIsMine: false })).toBe("none");
  });
});

describe("chatPaneGeometry", () => {
  it("fills the space under the app bar when there is no keyboard", () => {
    expect(chatPaneGeometry({ markerTop: 72, viewportTop: 0, viewportHeight: 800, windowHeight: 800 })).toEqual({
      top: 72,
      height: 728,
      keyboardOpen: false
    });
  });

  it("ends at the top of the keyboard (smaller visual viewport)", () => {
    expect(chatPaneGeometry({ markerTop: 72, viewportTop: 0, viewportHeight: 420, windowHeight: 800 })).toEqual({
      top: 72,
      height: 348,
      keyboardOpen: true
    });
  });

  it("follows a visual viewport that iOS scrolled down", () => {
    expect(chatPaneGeometry({ markerTop: 72, viewportTop: 150, viewportHeight: 420, windowHeight: 800 })).toEqual({
      top: 150,
      height: 420,
      keyboardOpen: true
    });
  });
});
