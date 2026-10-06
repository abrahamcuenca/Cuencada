/**
 * One chat WebSocket [SEC]: the upgrade checks (Origin, single-use ticket,
 * live session), then sequential handling of validated client frames.
 *
 * - Handshake: the ticket is burned on **any** upgrade attempt, then the
 *   Origin and the session are checked. Failures close with **1008** (policy
 *   violation) and a generic reason; the client fetches a new ticket (a 401
 *   there means log in again). At capacity, upgrades close with 1013.
 * - After registration the session is checked once more, so a revocation that
 *   raced the first check cannot leave a socket open.
 * - Backpressure: a socket whose send buffer passes
 *   {@link BUFFER_TERMINATE_BYTES} is terminated; above
 *   {@link BUFFER_SKIP_LOW_PRIORITY_BYTES} it gets no `typing`/`presence`.
 * - Frames are processed one at a time, in order. Frames that arrive while the
 *   session is still being loaded wait in the same queue.
 * - Invalid frames get an `error` frame; after {@link MAX_BAD_FRAMES} the
 *   socket closes with `WsCloseCode.ProtocolError`.
 * - Bodies and tickets are never logged.
 */
import {
  type ErrorCode,
  type WsClientMessage,
  WsCloseCode,
  type WsServerMessage,
  chatWsQuerySchema,
  idSchema,
  wsClientMessageSchema
} from "@cuencada/types";
import type { WebSocket } from "@fastify/websocket";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { allowedOrigins } from "../../config.js";
import { type ChatConnection, type ChatHub, CloseReason, WS_TRY_AGAIN_LATER } from "./hub.js";
import { toChatMessages } from "./mappers.js";
import { type ChatPrincipal, findVisibleRoom, insertMessageIdempotent, loadPrincipal, markRead } from "./repository.js";

/** WebSocket close code for a policy violation (bad Origin, ticket or session). */
export const WS_POLICY_VIOLATION = 1008;
/** Invalid frames tolerated before the socket is closed. */
export const MAX_BAD_FRAMES = 5;
/** Frames that may wait in the queue before the socket is closed. */
export const MAX_PENDING_FRAMES = 32;
/** A socket with more than this many unsent bytes is a slow reader and is terminated. */
export const BUFFER_TERMINATE_BYTES = 1024 * 1024;
/** Above this many unsent bytes, `typing` and `presence` frames are skipped. */
export const BUFFER_SKIP_LOW_PRIORITY_BYTES = 256 * 1024;

/** What {@link deliverFrame} did. */
export type DeliveryOutcome = "sent" | "skipped" | "terminated" | "closed";

/** The parts of a `ws` socket that {@link deliverFrame} uses. */
export type DeliverySocket = Pick<WebSocket, "readyState" | "OPEN" | "bufferedAmount" | "send" | "terminate">;

/**
 * Send one frame with backpressure: terminate a socket that stopped reading
 * (its unsent buffer is past {@link BUFFER_TERMINATE_BYTES}), and drop
 * low-priority frames (`typing`, `presence`) once it is past
 * {@link BUFFER_SKIP_LOW_PRIORITY_BYTES}. A close frame could not reach a reader
 * that is not reading, so the socket is terminated rather than closed; the
 * hub forgets it on the resulting `close` event.
 */
export function deliverFrame(socket: DeliverySocket, frame: WsServerMessage): DeliveryOutcome {
  if (socket.readyState !== socket.OPEN) return "closed";
  const buffered = socket.bufferedAmount;
  if (buffered > BUFFER_TERMINATE_BYTES) {
    socket.terminate();
    return "terminated";
  }
  if (buffered > BUFFER_SKIP_LOW_PRIORITY_BYTES && (frame.type === "typing" || frame.type === "presence")) {
    return "skipped";
  }
  socket.send(JSON.stringify(frame));
  return "sent";
}

/** Generic 1008 reason: never says which check failed. */
const REJECT_REASON = "No autorizado.";
const ROOM_NOT_FOUND = "La sala no existe.";
const MESSAGE_NOT_FOUND = "El mensaje no existe en esta sala.";

type RawFrame = Buffer | ArrayBuffer | Buffer[];

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * True when the upgrade's `Origin` is exactly one of the configured origins
 * (`CORS_ORIGIN`, plus `DEV_ALLOWED_ORIGINS`, which config forces empty in
 * production). A missing `Origin` is rejected: browsers always send one.
 */
export function isAllowedOrigin(app: FastifyInstance, origin: string | undefined): boolean {
  return origin !== undefined && allowedOrigins(app.config).includes(origin);
}

function frameText(data: RawFrame): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

/** Best-effort `clientMessageId` of an invalid frame, so the client can match the error. */
function clientMessageIdOf(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("clientMessageId" in value)) return null;
  const parsed = idSchema.safeParse(value.clientMessageId);
  return parsed.success ? parsed.data : null;
}

function errorFrame(code: ErrorCode, message: string, clientMessageId: string | null = null): WsServerMessage {
  return { type: "error", code, message, clientMessageId };
}

/** Wrap a `ws` socket as a hub connection. */
function wrap(socket: WebSocket, id: number, principal: ChatPrincipal, log: FastifyRequest["log"]): ChatConnection {
  return {
    id,
    principal,
    alive: true,
    send(frame) {
      if (deliverFrame(socket, frame) === "terminated") {
        log.warn({ connectionId: id }, "chat socket terminated: slow reader");
      }
    },
    close(code, reason) {
      if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) socket.close(code, reason);
    },
    ping() {
      if (socket.readyState === socket.OPEN) socket.ping();
    },
    terminate() {
      socket.terminate();
    }
  };
}

/**
 * Handle a new upgrade on `GET /api/chat/ws`.
 *
 * @param app - The chat plugin instance (`config`, `db`, `clock`, `log`, `storage`).
 * @param hub - This app's hub.
 * @param socket - The upgraded socket.
 * @param request - The upgrade request (its URL, with the ticket, is scrubbed in logs).
 */
export function openChatSocket(app: FastifyInstance, hub: ChatHub, socket: WebSocket, request: FastifyRequest): void {
  // Burn the ticket first, whatever happens next: a ticket gets exactly one attempt.
  const query = chatWsQuerySchema.safeParse(request.query);
  const grant = query.success ? hub.tickets.consume(query.data.ticket, app.clock.now()) : null;
  if (!isAllowedOrigin(app, firstHeader(request.headers.origin))) {
    request.log.info("chat socket rejected: origin");
    socket.close(WS_POLICY_VIOLATION, REJECT_REASON);
    return;
  }
  if (grant === null) {
    request.log.info("chat socket rejected: ticket");
    socket.close(WS_POLICY_VIOLATION, REJECT_REASON);
    return;
  }
  if (hub.isFull()) {
    request.log.warn({ sockets: hub.size }, "chat socket refused: at capacity");
    socket.close(WS_TRY_AGAIN_LATER, CloseReason.ServerBusy);
    return;
  }

  let connection: ChatConnection | null = null;
  let pending = 0;
  let badFrames = 0;
  let closed = false;

  const ready: Promise<ChatConnection | null> = loadPrincipal(app.db, {
    sessionId: grant.sessionId,
    userId: grant.userId,
    now: app.clock.now()
  }).then((principal) => {
    if (closed) return null;
    if (principal === null) {
      request.log.info("chat socket rejected: session");
      socket.close(WS_POLICY_VIOLATION, REJECT_REASON);
      return null;
    }
    if (hub.isFull()) {
      socket.close(WS_TRY_AGAIN_LATER, CloseReason.ServerBusy);
      return null;
    }
    const registered = wrap(socket, hub.allocateId(), principal, request.log);
    if (!hub.add(registered)) return null;
    connection = registered;
    // A revocation or disable may have committed between the first check and
    // registration without seeing this socket: check once more now that the
    // hub would see it.
    return loadPrincipal(app.db, { sessionId: grant.sessionId, userId: grant.userId, now: app.clock.now() }).then(
      (again) => {
        if (again !== null) return registered;
        hub.closeSession(grant.sessionId);
        return null;
      }
    );
  });
  let queue: Promise<unknown> = ready;

  const onBadFrame = (conn: ChatConnection, frame: WsServerMessage): void => {
    badFrames += 1;
    conn.send(frame);
    if (badFrames >= MAX_BAD_FRAMES) conn.close(WsCloseCode.ProtocolError, CloseReason.ProtocolError);
  };

  socket.on("message", (data: RawFrame, isBinary: boolean) => {
    pending += 1;
    if (pending > MAX_PENDING_FRAMES) {
      socket.close(WsCloseCode.RateLimited, CloseReason.Backlog);
      return;
    }
    queue = queue
      .then(async () => {
        const conn = await ready;
        // Also skip frames queued before a server-side close (e.g. a revoked session).
        if (conn === null || closed || socket.readyState !== socket.OPEN) return;
        await handleRawFrame({ app, hub, conn, onBadFrame }, data, isBinary);
      })
      .catch((error: unknown) => {
        request.log.error({ err: error }, "chat frame failed");
        connection?.send(errorFrame("INTERNAL", "No se pudo procesar el mensaje."));
      })
      .finally(() => {
        pending -= 1;
      });
  });
  socket.on("pong", () => {
    if (connection !== null) connection.alive = true;
  });
  socket.on("close", () => {
    closed = true;
    if (connection !== null) hub.remove(connection);
  });
  ready.catch((error: unknown) => {
    request.log.error({ err: error }, "chat socket setup failed");
    socket.close(1011, "Error interno.");
  });
}

/** Everything a frame handler needs. */
interface FrameContext {
  app: FastifyInstance;
  hub: ChatHub;
  conn: ChatConnection;
  onBadFrame: (conn: ChatConnection, frame: WsServerMessage) => void;
}

async function handleRawFrame(ctx: FrameContext, data: RawFrame, isBinary: boolean): Promise<void> {
  if (!ctx.hub.frameLimiter.take(ctx.conn.principal.userId, ctx.app.clock.now().getTime())) {
    ctx.conn.send(errorFrame("RATE_LIMITED", "Demasiados mensajes. Espera unos segundos."));
    return;
  }
  if (isBinary) {
    ctx.onBadFrame(ctx.conn, errorFrame("VALIDATION", "Solo se aceptan mensajes de texto."));
    return;
  }
  let value: unknown;
  try {
    value = JSON.parse(frameText(data));
  } catch {
    ctx.onBadFrame(ctx.conn, errorFrame("VALIDATION", "Mensaje mal formado."));
    return;
  }
  const parsed = wsClientMessageSchema.safeParse(value);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Mensaje inválido.";
    ctx.onBadFrame(ctx.conn, errorFrame("VALIDATION", message.slice(0, 500), clientMessageIdOf(value)));
    return;
  }
  await handleFrame(ctx, parsed.data);
}

async function handleFrame(ctx: FrameContext, frame: WsClientMessage): Promise<void> {
  switch (frame.type) {
    case "send":
      await handleSend(ctx, frame);
      return;
    case "typing":
      await handleTyping(ctx, frame);
      return;
    case "read":
      await handleRead(ctx, frame);
      return;
    case "ping":
      ctx.conn.send({ type: "pong", ts: frame.ts ?? null });
      return;
  }
}

async function handleSend(ctx: FrameContext, frame: Extract<WsClientMessage, { type: "send" }>): Promise<void> {
  const { app, hub, conn } = ctx;
  const { userId } = conn.principal;
  if (!hub.sendLimiter.take(userId, app.clock.now().getTime())) {
    conn.send(
      errorFrame("RATE_LIMITED", "Estás enviando mensajes muy rápido. Espera unos segundos.", frame.clientMessageId)
    );
    return;
  }
  const room = await findVisibleRoom(app.db, frame.roomId);
  if (room === null) {
    conn.send(errorFrame("NOT_FOUND", ROOM_NOT_FOUND, frame.clientMessageId));
    return;
  }
  const outcome = await insertMessageIdempotent(app.db, {
    roomId: room.id,
    senderUserId: userId,
    body: frame.body,
    clientMessageId: frame.clientMessageId
  });
  const [message] = await toChatMessages(app, [outcome.message]);
  if (message === undefined) return;
  if (!outcome.created) {
    // A retry: acknowledge to the sender only; everyone else already has it.
    conn.send({
      type: "message",
      message,
      clientMessageId: frame.clientMessageId
    });
    return;
  }
  hub.fanOut((target) => ({
    type: "message",
    message,
    clientMessageId: target === conn ? frame.clientMessageId : null
  }));
}

async function handleTyping(ctx: FrameContext, frame: Extract<WsClientMessage, { type: "typing" }>): Promise<void> {
  const { app, hub, conn } = ctx;
  const { userId, displayName } = conn.principal;
  if (!hub.typingThrottle.allow(`${userId}:${frame.roomId}`, app.clock.now().getTime())) return;
  if ((await findVisibleRoom(app.db, frame.roomId)) === null) {
    conn.send(errorFrame("NOT_FOUND", ROOM_NOT_FOUND));
    return;
  }
  hub.fanOut((target) =>
    target.principal.userId === userId ? null : { type: "typing", roomId: frame.roomId, userId, displayName }
  );
}

async function handleRead(ctx: FrameContext, frame: Extract<WsClientMessage, { type: "read" }>): Promise<void> {
  const { app, conn } = ctx;
  const room = await findVisibleRoom(app.db, frame.roomId);
  const found =
    room !== null &&
    (await markRead(app.db, {
      roomId: room.id,
      userId: conn.principal.userId,
      messageId: frame.messageId,
      now: app.clock.now()
    }));
  if (!found) conn.send(errorFrame("NOT_FOUND", room === null ? ROOM_NOT_FOUND : MESSAGE_NOT_FOUND));
}
