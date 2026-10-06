/**
 * Chat: one global room plus at most one room per Cuencada, messages with a
 * keyset index, and per-user read state.
 */
import { CHAT_BODY_MAX_LENGTH, ChatRoomKind } from "@cuencada/types";
import { sql } from "drizzle-orm";
import { check, index, pgTable, primaryKey, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { cuencadas } from "./cuencadas.js";
import { checkIn, createdAt, timestamptz, updatedAt } from "./helpers.js";

export const chatRooms = pgTable(
  "chat_rooms",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    kind: text("kind").$type<ChatRoomKind>().notNull(),
    cuencadaId: uuid("cuencada_id").references(() => cuencadas.id, { onDelete: "cascade" }),
    title: text("title"),
    createdAt: createdAt()
  },
  (table) => [
    uniqueIndex("chat_rooms_global_unique").on(table.kind).where(sql`kind = 'global'`),
    uniqueIndex("chat_rooms_cuencada_unique").on(table.cuencadaId).where(sql`kind = 'cuencada'`),
    checkIn("chat_rooms_kind_check", "kind", ChatRoomKind),
    check(
      "chat_rooms_kind_cuencada_check",
      sql`("kind" = 'global' and "cuencada_id" is null) or ("kind" = 'cuencada' and "cuencada_id" is not null)`
    )
  ]
);

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => chatRooms.id, { onDelete: "cascade" }),
    /** `null` once the sender's account is removed. */
    senderUserId: uuid("sender_user_id").references(() => users.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    /** Client-generated id for idempotent sends over the WebSocket. */
    clientMessageId: uuid("client_message_id"),
    deletedAt: timestamptz("deleted_at"),
    deletedByUserId: uuid("deleted_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt()
  },
  (table) => [
    // History pages: `where room_id = $1 and (created_at, id) < ($2, $3) order by created_at desc, id desc`.
    index("chat_messages_room_keyset_idx").on(table.roomId, table.createdAt.desc(), table.id.desc()),
    index("chat_messages_sender_user_id_idx").on(table.senderUserId),
    index("chat_messages_deleted_by_user_id_idx").on(table.deletedByUserId),
    uniqueIndex("chat_messages_sender_client_id_unique")
      .on(table.senderUserId, table.clientMessageId)
      .where(sql`client_message_id is not null`),
    check("chat_messages_body_length_check", sql.raw(`char_length("body") between 1 and ${CHAT_BODY_MAX_LENGTH}`))
  ]
);

/** Last message each user has read in each room (drives unread counts). */
export const chatReadStates = pgTable(
  "chat_read_states",
  {
    roomId: uuid("room_id")
      .notNull()
      .references(() => chatRooms.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    lastReadMessageId: uuid("last_read_message_id").references(() => chatMessages.id, { onDelete: "set null" }),
    lastReadAt: timestamptz("last_read_at").notNull().defaultNow(),
    updatedAt: updatedAt()
  },
  (table) => [
    primaryKey({ name: "chat_read_states_pkey", columns: [table.roomId, table.userId] }),
    index("chat_read_states_user_id_idx").on(table.userId),
    index("chat_read_states_last_read_message_id_idx").on(table.lastReadMessageId)
  ]
);
