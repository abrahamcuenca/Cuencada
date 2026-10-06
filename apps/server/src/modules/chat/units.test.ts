import { randomUUID } from "node:crypto";
import { CHAT_PREVIEW_MAX_LENGTH } from "@cuencada/types";
import { describe, expect, it } from "vitest";
import { hashToken } from "../../lib/tokens.js";
import { decodeChatCursor, encodeChatCursor } from "./cursor.js";
import { SlidingWindowLimiter, Throttle } from "./limits.js";
import { previewOf, roomTitle } from "./mappers.js";
import { MAX_OUTSTANDING_TICKETS, TicketStore } from "./tickets.js";

const NOW = new Date("2026-10-06T12:00:00Z");
const later = (ms: number): Date => new Date(NOW.getTime() + ms);

describe("TicketStore", () => {
  it("issues a 256-bit ticket that is consumed once and stored only as a hash", () => {
    const store = new TicketStore();
    const { ticket, expiresAt } = store.issue("u1", "s1", NOW);
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(expiresAt).toEqual(later(30_000));
    // Internal map is keyed by the hash, never the raw ticket.
    const keys = [...(store as unknown as { grants: Map<string, unknown> }).grants.keys()];
    expect(keys).toEqual([hashToken(ticket)]);
    expect(store.consume(ticket, NOW)).toEqual({
      userId: "u1",
      sessionId: "s1",
      expiresAt
    });
    expect(store.consume(ticket, NOW)).toBeNull();
  });

  it("rejects an expired ticket and burns it anyway", () => {
    const store = new TicketStore();
    const { ticket } = store.issue("u1", "s1", NOW);
    expect(store.consume(ticket, later(30_000))).toBeNull();
    expect(store.size).toBe(0);
  });

  it("revokes by session and user, and sweeps expired tickets", () => {
    const store = new TicketStore();
    const a = store.issue("u1", "s1", NOW).ticket;
    const b = store.issue("u1", "s2", NOW).ticket;
    const c = store.issue("u2", "s3", NOW).ticket;
    store.revokeSession("s1");
    expect(store.consume(a, NOW)).toBeNull();
    store.revokeUser("u1");
    expect(store.consume(b, NOW)).toBeNull();
    expect(store.sweep(later(29_999))).toBe(0);
    expect(store.sweep(later(30_000))).toBe(1);
    expect(store.consume(c, NOW)).toBeNull();
  });

  it("evicts the oldest tickets past the cap", () => {
    const store = new TicketStore();
    const first = store.issue("u", "s", NOW).ticket;
    for (let i = 1; i < MAX_OUTSTANDING_TICKETS; i += 1) store.issue("u", "s", NOW);
    expect(store.size).toBe(MAX_OUTSTANDING_TICKETS);
    store.issue("u", "s", NOW);
    expect(store.size).toBe(MAX_OUTSTANDING_TICKETS);
    expect(store.consume(first, NOW)).toBeNull();
  });
});

describe("SlidingWindowLimiter", () => {
  it("allows max hits per window per key and frees slots as they age out", () => {
    const limiter = new SlidingWindowLimiter(2, 1000);
    expect(limiter.take("a", 0)).toBe(true);
    expect(limiter.take("a", 500)).toBe(true);
    expect(limiter.take("a", 999)).toBe(false);
    expect(limiter.take("b", 999)).toBe(true);
    expect(limiter.take("a", 1000)).toBe(true);
    limiter.sweep(5000);
    expect(limiter.take("a", 5000)).toBe(true);
  });
});

describe("Throttle", () => {
  it("lets one event per key through per interval", () => {
    const throttle = new Throttle(100);
    expect(throttle.allow("k", 0)).toBe(true);
    expect(throttle.allow("k", 99)).toBe(false);
    expect(throttle.allow("other", 99)).toBe(true);
    expect(throttle.allow("k", 100)).toBe(true);
  });
});

describe("chat cursor", () => {
  it("round-trips microsecond timestamps and ids", () => {
    const cursor = { micros: "1790000000123456", id: randomUUID() };
    expect(decodeChatCursor(encodeChatCursor(cursor))).toEqual(cursor);
  });

  it("rejects cursors it did not produce", () => {
    const id = randomUUID();
    for (const raw of [
      Buffer.from(`1790000000123456:${id}`).toString("base64url"),
      Buffer.from(`c1:-1:${id}`).toString("base64url"),
      Buffer.from(`c1:1:${id}:x`).toString("base64url"),
      Buffer.from("c1:1:nope").toString("base64url"),
      Buffer.from(`c1:999999999999999999:${id}`).toString("base64url")
    ]) {
      expect(() => decodeChatCursor(raw), raw).toThrow("Cursor inválido.");
    }
  });
});

describe("previewOf", () => {
  it("collapses whitespace and keeps short bodies whole", () => {
    expect(previewOf("  hola\n\n  familia ")).toBe("hola familia");
  });

  it("truncates on a code-point boundary within the limit", () => {
    const preview = previewOf("😀".repeat(200));
    expect(preview.length).toBeLessThanOrEqual(CHAT_PREVIEW_MAX_LENGTH);
    expect(preview.endsWith("😀…")).toBe(true);
  });
});

describe("roomTitle", () => {
  it("falls back to a default title", () => {
    expect(roomTitle({ kind: "global", year: null, title: null })).toBe("Chat familiar");
    expect(roomTitle({ kind: "cuencada", year: 2026, title: " " })).toBe("Cuencada 2026");
    expect(roomTitle({ kind: "cuencada", year: 2026, title: "Mérida" })).toBe("Mérida");
  });
});
