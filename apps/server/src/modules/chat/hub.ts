/**
 * The chat hub: the in-memory registry of live sockets (`sessionId → sockets`),
 * fan-out, presence, the heartbeat, the periodic session re-check, the ticket
 * store and the per-user send/typing limits.
 *
 * **Single process only.** Fan-out reaches the sockets of this Node process.
 * Running more than one API process would need a shared bus (Postgres
 * `LISTEN/NOTIFY` on a `chat` channel carrying message ids, each process then
 * loading and fanning out locally) plus shared tickets and rate limits.
 *
 * Every connected member is implicitly subscribed to every visible room:
 * membership is uniform (any verified member may read the global room and
 * every published edition room), so "sockets subscribed to room R" is every
 * live socket, and each `send` re-checks that R is still visible.
 */
import { type WsServerMessage, WsCloseCode } from "@cuencada/types";
import type { FastifyBaseLogger } from "fastify";
import type { Database } from "../../db/client.js";
import type { Clock } from "../../lib/clock.js";
import { FRAME_RATE_LIMIT, SEND_RATE_LIMIT, SlidingWindowLimiter, Throttle, TYPING_THROTTLE_MS } from "./limits.js";
import { type ChatPrincipal, usableSessionIds } from "./repository.js";
import { TicketStore } from "./tickets.js";

/** How often connected sessions are re-validated against the database. */
export const SESSION_RECHECK_INTERVAL_MS = 5 * 60_000;
/** How often expired tickets and idle limiter keys are swept. */
export const SWEEP_INTERVAL_MS = 60_000;

/** Close reasons sent to clients (≤ 123 bytes, Spanish). */
export const CloseReason = {
  SessionEnded: "Tu sesión terminó. Vuelve a entrar.",
  ProtocolError: "Demasiados mensajes inválidos.",
  Backlog: "Demasiados mensajes pendientes.",
  Shutdown: "El servidor se está reiniciando."
} as const;

/** The transport side of one socket, as the hub sees it. */
export interface ChatConnection {
  readonly id: number;
  readonly principal: ChatPrincipal;
  /** Serialize and send a frame (no-op once closed). */
  send(frame: WsServerMessage): void;
  close(code: number, reason: string): void;
  /** Protocol-level ping; the heartbeat expects a pong before the next round. */
  ping(): void;
  terminate(): void;
  /** Set by a pong, cleared by each heartbeat round. */
  alive: boolean;
}

/** What the hub needs from the app. */
export interface ChatHubDeps {
  db: Database;
  clock: Clock;
  log: FastifyBaseLogger;
}

/** One hub per app instance. */
export class ChatHub {
  readonly tickets = new TicketStore();
  readonly sendLimiter = new SlidingWindowLimiter(SEND_RATE_LIMIT.max, SEND_RATE_LIMIT.windowMs);
  readonly frameLimiter = new SlidingWindowLimiter(FRAME_RATE_LIMIT.max, FRAME_RATE_LIMIT.windowMs);
  readonly typingThrottle = new Throttle(TYPING_THROTTLE_MS);

  private readonly bySession = new Map<string, Set<ChatConnection>>();
  private nextId = 1;
  private recheckRunning: Promise<number> | null = null;

  constructor(private readonly deps: ChatHubDeps) {}

  /** A fresh connection id. */
  allocateId(): number {
    const id = this.nextId;
    this.nextId += 1;
    return id;
  }

  /** Register a socket after its ticket and session checked out. */
  add(connection: ChatConnection): void {
    const set = this.bySession.get(connection.principal.sessionId) ?? new Set<ChatConnection>();
    const wasOnline = this.isUserOnline(connection.principal.userId);
    set.add(connection);
    this.bySession.set(connection.principal.sessionId, set);
    if (wasOnline) connection.send(this.presenceFrame());
    else this.broadcastPresence();
  }

  /** Forget a socket (on close). */
  remove(connection: ChatConnection): void {
    const set = this.bySession.get(connection.principal.sessionId);
    if (set === undefined || !set.delete(connection)) return;
    if (set.size === 0) this.bySession.delete(connection.principal.sessionId);
    if (!this.isUserOnline(connection.principal.userId)) this.broadcastPresence();
  }

  /** Every live connection. */
  connections(): ChatConnection[] {
    return [...this.bySession.values()].flatMap((set) => [...set]);
  }

  /**
   * Send a frame to every live connection, optionally filtered.
   *
   * @param frameFor - Return the frame for a connection, or `null` to skip it.
   */
  fanOut(frameFor: (connection: ChatConnection) => WsServerMessage | null): void {
    for (const connection of this.connections()) {
      const frame = frameFor(connection);
      if (frame !== null) connection.send(frame);
    }
  }

  /**
   * Close every socket of a session and burn its unused tickets.
   *
   * @returns How many sockets were closed.
   */
  closeSession(
    sessionId: string,
    code: number = WsCloseCode.SessionRevoked,
    reason: string = CloseReason.SessionEnded
  ): number {
    this.tickets.revokeSession(sessionId);
    const set = this.bySession.get(sessionId);
    if (set === undefined) return 0;
    const sockets = [...set];
    for (const connection of sockets) {
      this.remove(connection);
      connection.close(code, reason);
    }
    return sockets.length;
  }

  /**
   * Close every socket of a user and burn their unused tickets.
   *
   * @returns How many sockets were closed.
   */
  closeUser(
    userId: string,
    code: number = WsCloseCode.SessionRevoked,
    reason: string = CloseReason.SessionEnded
  ): number {
    this.tickets.revokeUser(userId);
    let closed = 0;
    for (const connection of this.connections()) {
      if (connection.principal.userId !== userId) continue;
      this.remove(connection);
      connection.close(code, reason);
      closed += 1;
    }
    return closed;
  }

  /**
   * Re-validate every connected session against the database and close the
   * sockets of sessions that were revoked or expired, or whose user was
   * disabled, unverified or must change their password. Runs every
   * {@link SESSION_RECHECK_INTERVAL_MS}; concurrent calls share one pass.
   *
   * @returns How many sockets were closed.
   */
  recheckSessions(): Promise<number> {
    this.recheckRunning ??= this.runRecheck().finally(() => {
      this.recheckRunning = null;
    });
    return this.recheckRunning;
  }

  private async runRecheck(): Promise<number> {
    const sessionIds = [...this.bySession.keys()];
    if (sessionIds.length === 0) return 0;
    const usable = await usableSessionIds(this.deps.db, sessionIds, this.deps.clock.now());
    let closed = 0;
    for (const sessionId of sessionIds) {
      if (!usable.has(sessionId)) closed += this.closeSession(sessionId);
    }
    if (closed > 0) this.deps.log.info({ closedSockets: closed }, "chat sockets closed after session re-check");
    return closed;
  }

  /**
   * One heartbeat round: terminate sockets that missed the previous ping,
   * then ping the rest. Runs every `WS_PING_INTERVAL_MS`.
   *
   * @returns How many dead sockets were terminated.
   */
  heartbeat(): number {
    let terminated = 0;
    for (const connection of this.connections()) {
      if (!connection.alive) {
        this.remove(connection);
        connection.terminate();
        terminated += 1;
        continue;
      }
      connection.alive = false;
      connection.ping();
    }
    return terminated;
  }

  /** Drop expired tickets and idle limiter state. */
  sweep(): void {
    const now = this.deps.clock.now();
    this.tickets.sweep(now);
    this.sendLimiter.sweep(now.getTime());
    this.frameLimiter.sweep(now.getTime());
    this.typingThrottle.sweep(now.getTime());
  }

  /** Close everything (app shutdown). */
  closeAll(): void {
    for (const connection of this.connections()) {
      this.remove(connection);
      connection.close(1001, CloseReason.Shutdown);
    }
  }

  private isUserOnline(userId: string): boolean {
    return this.connections().some((connection) => connection.principal.userId === userId);
  }

  private presenceFrame(): WsServerMessage {
    const online = new Set(this.connections().map((connection) => connection.principal.userId));
    return { type: "presence", onlineUserIds: [...online].slice(0, 5000) };
  }

  private broadcastPresence(): void {
    const frame = this.presenceFrame();
    this.fanOut(() => frame);
  }
}
