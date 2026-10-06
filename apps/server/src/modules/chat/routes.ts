/**
 * Chat REST routes (T7). Every route is `auth: "user"` with
 * `requireVerifiedEmail: true`: chat content is member-only PII.
 *
 * - `GET /chat/rooms`: visible rooms with unread counts and a preview.
 * - `GET /chat/rooms/:id/messages?before=&limit=`: keyset history (tombstones for deleted messages).
 * - `POST /chat/rooms/:id/read`: monotonic read marker.
 * - `DELETE /chat/messages/:id`: soft delete by the sender or an admin (admin deletes of others' messages are audited); broadcasts `message_deleted`.
 * - `POST /chat/ticket`: single-use WebSocket ticket (10/min per user).
 *
 * There is deliberately **no** room deletion: an edition room's existence is
 * part of T2's "was ever published" history, so rooms are never deleted.
 */
import {
  AuditAction,
  AuditEntityType,
  apiErrorSchema,
  type ChatHistoryPage,
  type ChatRoom,
  type ChatTicketResponse,
  chatHistoryPageSchema,
  chatHistoryQuerySchema,
  chatRoomSchema,
  chatTicketResponseSchema,
  idParamSchema,
  markReadInputSchema,
  roomIdParamSchema
} from "@cuencada/types";
import type { RateLimitOptions } from "@fastify/rate-limit";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { recordAudit } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { ipKey, type RateLimitWindow } from "../../lib/rateLimit.js";
import { authUser } from "../../plugins/auth.js";
import { encodeChatCursor } from "./cursor.js";
import type { ChatHub } from "./hub.js";
import { toChatMessages, toChatRooms } from "./mappers.js";
import {
  findMessage,
  findVisibleRoom,
  historyPage,
  lastMessagesFor,
  listVisibleRooms,
  markRead,
  softDeleteMessage
} from "./repository.js";

/** WebSocket path returned with each ticket. */
export const CHAT_WS_PATH = "/api/chat/ws";
/** Ticket issuance per user. */
export const TICKET_RATE_LIMIT: RateLimitWindow = {
  max: 10,
  timeWindow: "1 minute"
};

const ROOM_NOT_FOUND = "La sala no existe.";
const MESSAGE_NOT_FOUND = "El mensaje no existe.";

const errorResponses = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  429: apiErrorSchema
} as const;

/**
 * Per-user limit. Runs in `preHandler`, after the auth guard set `request.user`.
 *
 * @param prefix - Counter namespace, unique per route.
 */
function rateLimitByUser(prefix: string, window: RateLimitWindow): RateLimitOptions {
  return {
    ...window,
    hook: "preHandler",
    keyGenerator: (request) => `${prefix}:${request.user === null ? ipKey(request) : `user:${request.user.id}`}`
  };
}

/** Options for {@link chatRoutes}. */
export interface ChatRoutesOptions {
  hub: ChatHub;
}

/** Chat REST routes under `/api`. */
const chatRoutes: FastifyPluginAsyncZod<ChatRoutesOptions> = async (app, { hub }) => {
  const member = { auth: "user", requireVerifiedEmail: true } as const;

  /** `GET /api/chat/rooms`: visible rooms, most recent activity first. */
  app.get(
    "/chat/rooms",
    {
      config: member,
      schema: { response: { 200: z.array(chatRoomSchema), ...errorResponses } }
    },
    async (request): Promise<ChatRoom[]> => {
      const user = authUser(request);
      const rooms = await listVisibleRooms(app.db, user.id);
      const last = await lastMessagesFor(
        app.db,
        rooms.map((room) => room.id)
      );
      return toChatRooms(rooms, last);
    }
  );

  /** `GET /api/chat/rooms/:id/messages`: one keyset page, oldest → newest. */
  app.get(
    "/chat/rooms/:id/messages",
    {
      config: member,
      schema: {
        params: roomIdParamSchema,
        querystring: chatHistoryQuerySchema,
        response: { 200: chatHistoryPageSchema, ...errorResponses }
      }
    },
    async (request): Promise<ChatHistoryPage> => {
      authUser(request);
      const room = await findVisibleRoom(app.db, request.params.id);
      if (room === null) throw new AppError("NOT_FOUND", ROOM_NOT_FOUND);
      const page = await historyPage(app.db, room.id, request.query.before, request.query.limit);
      return {
        messages: await toChatMessages(app, page.records),
        nextBefore:
          page.oldest === null
            ? null
            : encodeChatCursor({
                micros: page.oldest.cursorMicros,
                id: page.oldest.id
              })
      };
    }
  );

  /** `POST /api/chat/rooms/:id/read`: move the read marker forward (never back). */
  app.post(
    "/chat/rooms/:id/read",
    {
      config: member,
      schema: {
        params: roomIdParamSchema,
        body: markReadInputSchema,
        response: { 204: z.null(), ...errorResponses }
      }
    },
    async (request, reply) => {
      const user = authUser(request);
      const room = await findVisibleRoom(app.db, request.params.id);
      if (room === null) throw new AppError("NOT_FOUND", ROOM_NOT_FOUND);
      const found = await markRead(app.db, {
        roomId: room.id,
        userId: user.id,
        messageId: request.body.messageId,
        now: app.clock.now()
      });
      if (!found) throw new AppError("NOT_FOUND", MESSAGE_NOT_FOUND);
      return reply.code(204).send(null);
    }
  );

  /**
   * `DELETE /api/chat/messages/:id`: the sender, or an admin, soft-deletes a
   * message in a visible room (404 otherwise, including another member's
   * message). An admin deleting someone else's message is audited (no body).
   * Deleting an already deleted message is a no-op 204.
   */
  app.delete(
    "/chat/messages/:id",
    {
      config: member,
      schema: {
        params: idParamSchema,
        response: { 204: z.null(), ...errorResponses }
      }
    },
    async (request, reply) => {
      const user = authUser(request);
      const message = await findMessage(app.db, request.params.id);
      const own = message !== null && message.senderUserId === user.id;
      // 404 for unknown messages, messages in hidden rooms, and other members'
      // messages (non-admins): the answer never confirms that a message exists.
      if (
        message === null ||
        (!own && user.role !== "admin") ||
        (await findVisibleRoom(app.db, message.roomId)) === null
      ) {
        throw new AppError("NOT_FOUND", MESSAGE_NOT_FOUND);
      }
      if (message.deletedAt !== null) return reply.code(204).send(null);

      const roomId = await app.db.transaction(async (tx) => {
        const deletedRoomId = await softDeleteMessage(tx, {
          messageId: message.id,
          actorUserId: user.id,
          now: app.clock.now()
        });
        if (deletedRoomId !== null && !own) {
          await recordAudit(tx, {
            actorUserId: user.id,
            action: AuditAction.ChatMessageDeleted,
            entityType: AuditEntityType.ChatMessage,
            entityId: message.id,
            metadata: {
              roomId: deletedRoomId,
              senderUserId: message.senderUserId
            },
            ip: request.ip
          });
        }
        return deletedRoomId;
      });
      if (roomId !== null) {
        hub.fanOut(() => ({
          type: "message_deleted",
          roomId,
          messageId: message.id
        }));
      }
      return reply.code(204).send(null);
    }
  );

  /**
   * `POST /api/chat/ticket`: a single-use, 30-second ticket for
   * `GET /api/chat/ws?ticket=`, bound to the caller's session. Only its hash is
   * kept. 10 per minute per user.
   */
  app.post(
    "/chat/ticket",
    {
      config: {
        ...member,
        rateLimit: rateLimitByUser("chat-ticket", TICKET_RATE_LIMIT)
      },
      schema: {
        response: { 201: chatTicketResponseSchema, ...errorResponses }
      }
    },
    async (request, reply) => {
      const user = authUser(request);
      const issued = hub.tickets.issue(user.id, user.sessionId, app.clock.now());
      const body: ChatTicketResponse = {
        ticket: issued.ticket,
        expiresAt: issued.expiresAt.toISOString(),
        wsPath: CHAT_WS_PATH
      };
      return reply.code(201).header("cache-control", "no-store").send(body);
    }
  );
};

export default chatRoutes;
