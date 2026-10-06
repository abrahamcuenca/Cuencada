import { AuditAction } from "@cuencada/types";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { getTestDb } from "../../test/helpers/db.js";
import { createUser } from "../../test/helpers/factories.js";
import { auditLogs } from "../db/schema/index.js";
import { recordAudit, scrubAuditMetadata } from "./audit.js";

describe("scrubAuditMetadata", () => {
  it("redacts sensitive keys at any depth and keeps the rest", () => {
    const scrubbed = scrubAuditMetadata({
      year: 2026,
      password: "p",
      nested: { refreshToken: "t", tokenHash: "h", ok: true, list: [{ ticket: "x", name: "Ana" }] },
      apiKey: "k",
      when: new Date("2026-10-06T00:00:00Z")
    });

    expect(scrubbed).toEqual({
      year: 2026,
      password: "[REDACTED]",
      nested: { refreshToken: "[REDACTED]", tokenHash: "[REDACTED]", ok: true, list: [{ ticket: "[REDACTED]", name: "Ana" }] },
      apiKey: "[REDACTED]",
      when: "2026-10-06T00:00:00.000Z"
    });
  });

  it("drops non-JSON values and bounds depth and string length", () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: "deep" } } } } } } };
    const scrubbed = scrubAuditMetadata({ fn: () => 1, big: 10n, long: "x".repeat(2000), deep });

    expect(scrubbed).not.toHaveProperty("fn");
    expect(scrubbed).not.toHaveProperty("big");
    expect(String(scrubbed.long)).toHaveLength(1001);
    expect(JSON.stringify(scrubbed.deep)).toContain("[TRUNCATED]");
  });

  it("returns an empty object for empty metadata", () => {
    expect(scrubAuditMetadata({})).toEqual({});
  });
});

describe("recordAudit", () => {
  it("writes a row inside a transaction with scrubbed metadata", async () => {
    const db = getTestDb();
    const actor = await createUser({ role: "admin" });

    const id = await db.transaction((tx) =>
      recordAudit(tx, {
        actorUserId: actor.id,
        action: AuditAction.UserDisabled,
        entityType: "user",
        entityId: actor.id,
        metadata: { reason: "prueba", password: "nunca" },
        ip: "203.0.113.7"
      })
    );

    const [row] = await db.select().from(auditLogs).where(eq(auditLogs.id, id));
    expect(row).toMatchObject({
      actorUserId: actor.id,
      action: "user.disabled",
      entityType: "user",
      entityId: actor.id,
      metadata: { reason: "prueba", password: "[REDACTED]" },
      ip: "203.0.113.7"
    });
  });

  it("is rolled back with its transaction", async () => {
    const db = getTestDb();

    await expect(
      db.transaction(async (tx) => {
        await recordAudit(tx, { actorUserId: null, action: "media.moderated", entityType: "media", entityId: null });
        throw new Error("rollback");
      })
    ).rejects.toThrow("rollback");

    expect(await db.$count(auditLogs)).toBe(0);
  });

  it("accepts a track-specific dotted action and rejects malformed ones", async () => {
    const db = getTestDb();

    await expect(
      recordAudit(db, { actorUserId: null, action: "rsvp.updated", entityType: "rsvp", entityId: null })
    ).resolves.toEqual(expect.any(String));
    const error = await recordAudit(db, {
      actorUserId: null,
      action: "Not An Action",
      entityType: "rsvp",
      entityId: null
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ZodError);
  });
});
