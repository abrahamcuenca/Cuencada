/**
 * Audit log writer. Every admin mutation and every sensitive account event
 * calls {@link recordAudit} inside the same transaction as the change.
 */
import { type AuditAction, type AuditEntityType, auditActionSchema } from "@cuencada/types";
import type { Database } from "../db/client.js";
import { auditLogs } from "../db/schema/index.js";

/** A Drizzle transaction handle from `db.transaction(async (tx) => …)`. */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Either the root client or an open transaction. */
export type DbOrTx = Database | Transaction;

/** One audit entry. */
export interface AuditEntry {
  /** Acting user, or `null` for system actions. */
  actorUserId: string | null;
  /** A well-known {@link AuditAction} or another `entity.verb_past` string. */
  action: AuditAction | (string & Record<never, never>);
  entityType: AuditEntityType;
  entityId: string | null;
  /** Context; sensitive keys are redacted before storage. */
  metadata?: Record<string, unknown>;
  /** Client IP (`request.ip`). */
  ip?: string | null;
}

const REDACTED = "[REDACTED]";
const MAX_DEPTH = 6;
const MAX_STRING_LENGTH = 1000;
const MAX_ARRAY_LENGTH = 100;

/** Keys whose values never belong in an audit log. */
const SENSITIVE_KEY = /pass(word)?|secret|token|ticket|hash|authorization|cookie|api[-_]?key|credential/i;

function scrubValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…` : value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY_LENGTH).map((item) => scrubValue(item, depth + 1));
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = SENSITIVE_KEY.test(key) ? REDACTED : scrubValue(item, depth + 1);
    }
    return result;
  }
  // functions, symbols, bigint, undefined: not JSON; drop them.
  return undefined;
}

/**
 * Deep-copy metadata into a JSON-safe object with sensitive keys
 * (`password`, `token`, `ticket`, `secret`, `hash`, …) replaced by `[REDACTED]`,
 * long strings truncated and depth bounded.
 *
 * @param metadata - Arbitrary context.
 */
export function scrubAuditMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const scrubbed = scrubValue(metadata, 0);
  if (typeof scrubbed !== "object" || scrubbed === null || Array.isArray(scrubbed)) return {};
  return JSON.parse(JSON.stringify(scrubbed)) as Record<string, unknown>; // round-trip of a plain object built above
}

/**
 * Append an audit log row.
 *
 * @param db - The transaction performing the change (preferred) or the root client.
 * @param entry - Who did what to which entity.
 * @returns The new audit row id.
 * @throws Error when `action` is not a dotted lowercase `entity.verb` string.
 */
export async function recordAudit(db: DbOrTx, entry: AuditEntry): Promise<string> {
  const action = auditActionSchema.parse(entry.action);
  const [row] = await db
    .insert(auditLogs)
    .values({
      actorUserId: entry.actorUserId,
      action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      metadata: scrubAuditMetadata(entry.metadata ?? {}),
      ip: entry.ip ?? null
    })
    .returning({ id: auditLogs.id });
  if (!row) throw new Error("recordAudit: insert returned no row");
  return row.id;
}
