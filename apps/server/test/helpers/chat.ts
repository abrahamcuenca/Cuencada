/**
 * Test fixtures for the chat module (T7): rooms, messages with explicit
 * timestamps, members with sessions, tickets, and a WebSocket test client
 * over Fastify's `injectWS` that records every frame and the close event.
 */
import { randomUUID } from "node:crypto";
import {
  type ChatTicketResponse,
  chatTicketResponseSchema,
  type WsServerMessage,
  wsServerMessageSchema
} from "@cuencada/types";
import type { WebSocket } from "@fastify/websocket";
import type { App } from "../../src/app.js";
import { chatMessages, chatRooms } from "../../src/db/schema/index.js";
import { getTestDb } from "./db.js";
import {
  type AuthInjectOptions,
  bearerFor,
  type CreateUserOptions,
  createSession,
  createUser,
  type TestUser
} from "./factories.js";

/** The allowed test origin (`APP_BASE_URL`/`CORS_ORIGIN` in `createTestConfig`). */
export const TEST_ORIGIN = "http://localhost:5173";

type RoomRow = typeof chatRooms.$inferSelect;
type MessageRow = typeof chatMessages.$inferSelect;

/** Insert the global room. */
export async function insertGlobalRoom(title: string | null = "Chat familiar"): Promise<RoomRow> {
  const [row] = await getTestDb().insert(chatRooms).values({ kind: "global", cuencadaId: null, title }).returning();
  if (row === undefined) throw new Error("insertGlobalRoom: no row");
  return row;
}

/** Insert an edition room. */
export async function insertEditionRoom(cuencadaId: string, year: number): Promise<RoomRow> {
  const [row] = await getTestDb()
    .insert(chatRooms)
    .values({ kind: "cuencada", cuencadaId, title: `Cuencada ${year}` })
    .returning();
  if (row === undefined) throw new Error("insertEditionRoom: no row");
  return row;
}

/** Insert a message directly (explicit `createdAt` for ordering tests). */
export async function insertMessage(
  values: Partial<typeof chatMessages.$inferInsert> & {
    roomId: string;
    senderUserId: string | null;
  }
): Promise<MessageRow> {
  const [row] = await getTestDb()
    .insert(chatMessages)
    .values({ body: `mensaje ${randomUUID()}`, ...values })
    .returning();
  if (row === undefined) throw new Error("insertMessage: no row");
  return row;
}

/** A user with a live session and bearer headers. */
export interface ChatMember {
  user: TestUser;
  sessionId: string;
  auth: AuthInjectOptions;
}

/** Create a verified member (unless overridden) with a session. */
export async function createChatMember(options: CreateUserOptions = {}): Promise<ChatMember> {
  const user = await createUser({ emailVerified: true, ...options });
  const session = await createSession(user.id);
  return { user, sessionId: session.id, auth: await bearerFor(user, session) };
}

/** Issue a ticket through the real route. */
export async function issueTicket(app: App, member: ChatMember): Promise<ChatTicketResponse> {
  const response = await app.inject({
    method: "POST",
    url: "/api/chat/ticket",
    ...member.auth
  });
  if (response.statusCode !== 201) throw new Error(`issueTicket: ${response.statusCode} ${response.body}`);
  return chatTicketResponseSchema.parse(response.json());
}

/** How a socket ended. */
export interface CloseInfo {
  code: number;
  reason: string;
}

/** A recording WebSocket client. */
export interface ChatTestClient {
  ws: WebSocket;
  frames: WsServerMessage[];
  closed: Promise<CloseInfo>;
  /** Send a JSON frame (or a raw string). */
  send(frame: unknown): void;
  /** Wait for the first recorded frame (past or future) matching `predicate`. */
  waitFor<TFrame extends WsServerMessage>(
    predicate: (frame: WsServerMessage) => frame is TFrame,
    timeoutMs?: number
  ): Promise<TFrame>;
  /** Frames of one type received so far. */
  ofType<TType extends WsServerMessage["type"]>(type: TType): Extract<WsServerMessage, { type: TType }>[];
}

/** Type guard factory for {@link ChatTestClient.waitFor}. */
export function frameOf<TType extends WsServerMessage["type"]>(
  type: TType,
  extra: (frame: Extract<WsServerMessage, { type: TType }>) => boolean = () => true
): (frame: WsServerMessage) => frame is Extract<WsServerMessage, { type: TType }> {
  return (frame): frame is Extract<WsServerMessage, { type: TType }> =>
    // The discriminant check makes the narrowing safe.
    frame.type === type && extra(frame as Extract<WsServerMessage, { type: TType }>);
}

/**
 * Open `/api/chat/ws` through `injectWS`.
 *
 * @param options.ticket - Query ticket (omitted → no query string).
 * @param options.origin - `Origin` header; `null` omits it. Defaults to the allowed test origin.
 */
export async function connectChat(
  app: App,
  options: { ticket?: string; origin?: string | null } = {}
): Promise<ChatTestClient> {
  const frames: WsServerMessage[] = [];
  const waiters: Array<() => void> = [];
  let closeInfo: CloseInfo | null = null;
  let resolveClosed: (info: CloseInfo) => void = () => undefined;
  const closed = new Promise<CloseInfo>((resolve) => {
    resolveClosed = resolve;
  });
  const origin = options.origin === undefined ? TEST_ORIGIN : options.origin;
  const path =
    options.ticket === undefined ? "/api/chat/ws" : `/api/chat/ws?ticket=${encodeURIComponent(options.ticket)}`;
  const ws = await app.injectWS(
    path,
    { headers: origin === null ? {} : { origin } },
    {
      onInit: (socket) => {
        socket.on("message", (data: Buffer) => {
          frames.push(wsServerMessageSchema.parse(JSON.parse(data.toString("utf8"))));
          for (const wake of waiters.splice(0)) wake();
        });
        socket.on("close", (code: number, reason: Buffer) => {
          closeInfo = { code, reason: reason.toString("utf8") };
          resolveClosed(closeInfo);
          for (const wake of waiters.splice(0)) wake();
        });
      }
    }
  );

  const client: ChatTestClient = {
    ws,
    frames,
    closed,
    send(frame) {
      ws.send(typeof frame === "string" ? frame : JSON.stringify(frame));
    },
    async waitFor(predicate, timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = frames.find(predicate);
        if (found !== undefined) return found;
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error(
            `waitFor: no matching frame; got ${JSON.stringify(frames.map((f) => f.type))}, closed: ${JSON.stringify(closeInfo)}`
          );
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, remaining);
          waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
    ofType(type) {
      return frames.filter(frameOf(type));
    }
  };
  return client;
}

/** Connect a member end to end (ticket + socket) and wait until the hub registered it. */
export async function connectMember(app: App, member: ChatMember): Promise<ChatTestClient> {
  const { ticket } = await issueTicket(app, member);
  const client = await connectChat(app, { ticket });
  await client.waitFor(frameOf("presence", (frame) => frame.onlineUserIds.includes(member.user.id)));
  return client;
}

/** Resolve after `ms` (to prove that something did *not* arrive). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
