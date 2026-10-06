/**
 * Append-only audit log. Every admin mutation writes one row in the same
 * transaction. Rows survive the actor's deletion (`actor_user_id` → null).
 */
import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { createdAt } from "./helpers.js";

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    /** An `AuditEntityType` for new rows; free text (no CHECK), matching the contract, so legacy rows stay valid. */
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    /** Redacted context; never tokens, passwords or message bodies. */
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    ip: text("ip"),
    createdAt: createdAt()
  },
  (table) => [
    index("audit_logs_created_at_idx").on(table.createdAt.desc(), table.id.desc()),
    index("audit_logs_actor_created_at_idx").on(table.actorUserId, table.createdAt.desc()),
    index("audit_logs_entity_idx").on(table.entityType, table.entityId),
    index("audit_logs_action_idx").on(table.action),
    check("audit_logs_metadata_object_check", sql`jsonb_typeof("metadata") = 'object'`)
  ]
);
