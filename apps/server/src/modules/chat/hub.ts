/**
 * The chat hub: the in-memory registry of live sockets (`sessionId → sockets`,
 * `userId → sockets`), connection caps, fan-out, presence, the heartbeat, the
 * periodic session re-check, the ticket store and the per-user limits.
 *
 * **Single process only.** Fan-out reaches the sockets of this Node process.
 * Running more than one API process would need a shared bus (Postgres
 * `LISTEN/NOTIFY` on a `chat` channel carrying message ids, each process then
 * loading and fanning out locally) plus shared tickets, limits and caps.
 *
 * Every connected member is implicitly subscribed to every visible room:
 * membership is uniform (any verified member may read the global room and
 * every published edition room), so "sockets subscribed to room R" is every
 * live socket, and each `send` re-checks that R is still visible.
 *
 * **Caps [SEC]:** at most {@link MAX_SOCKETS_PER_SESSION} sockets per session
 * and {@link MAX_SOCKETS_PER_USER} per user (a new socket closes the oldest
 * over the cap), and {@link MAX_SOCKETS_TOTAL} overall (new upgrades are
 * refused with 1013). Slow readers are handled per send (see `socket.ts`).
 *
 * **Presence** lists only members listed in the directory; each member also
 * sees themselves.
 */
import { type WsServerMessage, WsCloseCode } from "@cuencada/types";
import type { FastifyBaseLogger } from "fastify";
import type { Database } from "../../db/client.js";
import type { Clock } from "../../lib/clock.js";
import { FRAME_RATE_LIMIT, SEND_RATE_LIMIT, SlidingWindowLimiter, Throttle, TYPING_THROTTLE_MS } from "./limits.js";
import { type ChatPrincipal, usableSessions } from "./repository.js";
import { TicketStore } from "./tickets.js";

/** How often connected sessions are re-validated against the database. */
export const SESSION_RECHECK_INTERVAL_MS = 5 * 60_000;
/** How often expired tickets and idle limiter keys are swept. */
export const SWEEP_INTERVAL_MS = 60_000;
/** Sockets one session may keep open; a new one closes the oldest. */
export const MAX_SOCKETS_PER_SESSION = 3;
/** Sockets one user may keep open across sessions; a new one closes the oldest. */
export const MAX_SOCKETS_PER_USER = 8;
/** Soft cap on sockets in this process; new upgrades past it are refused with 1013. */
export const MAX_SOCKETS_TOTAL = 2000;
/** Close code for a refused upgrade when the server is at capacity ("try again later"). */
export const WS_TRY_AGAIN_LATER = 1013;
/**
 * How long a closed session is remembered, so a socket whose handshake passed
 * the DB check just before the revocation cannot register afterwards. (User
 * level changes are covered by the post-registration DB re-check in `socket.ts`.)
 */
export const REVOKED_MEMORY_MS = 60_000;
/** Close code for a socket evicted by a newer one (normal closure: do not reconnect). */
export const WS_NORMAL_CLOSURE = 1000;

/** Close reasons sent to clients (≤ 123 bytes, Spanish). */
export const CloseReason = {
  SessionEnded: "Tu sesión terminó. Vuelve a entrar.",
  ProtocolError: "Demasiados mensajes inválidos.",
  Backlog: "Demasiados mensajes pendientes.",
  TooManyConnections: "Demasiadas conexiones abiertas.",
  ServerBusy: "El chat está lleno. Intenta de nuevo en un momento.",
  SlowReader: "Conexión demasiado lenta.",
  Shutdown: "El servidor se está reiniciando."
} as const;

/** The transport side of one socket, as the hub sees it. */
export interface ChatConnection {
  /** Increasing per hub: a smaller id is an older socket. */
  readonly id: number;
  readonly principal: ChatPrincipal;
  /** Serialize and send a frame (no-op once closed; applies backpressure). */
  send(frame: WsServerMessage): void;
  close(code: number, reason: string): void;
  /** Protocol-level ping; the heartbeat expects a pong before the next round. */
  ping(): void;
  terminate(): void;
  /** Set by a pong, cleared by each heartbeat round. */
  alive: boolean;
}

/** Connection caps (mutable so tests can lower them). */
export interface ChatCaps {
  perSession: number;
  perUser: number;
  total: number;
}

/** What the hub needs from the app. */
export interface ChatHubDeps {
  db: Database;
  clock: Clock;
  log: FastifyBaseLogger;
}

/**
 * Test seams. Production never sets them; tests use them to force races
 * deterministically.
 */
export interface ChatHubHooks {
  /**
   * Awaited in `openChatSocket` right after a socket is registered and before
   * the post-registration DB re-check (e.g. to revoke the session there).
   */
  afterRegister?: (connection: ChatConnection) => Promise<void>;
}

function addTo(map: Map<string, Set<ChatConnection>>, key: string, connection: ChatConnection): Set<ChatConnection> {
  const set = map.get(key) ?? new Set<ChatConnection>();
  set.add(connection);
  map.set(key, set);
  return set;
}

function removeFrom(map: Map<string, Set<ChatConnection>>, key: string, connection: ChatConnection): boolean {
  const set = map.get(key);
  if (set === undefined || !set.delete(connection)) return false;
  if (set.size === 0) map.delete(key);
  return true;
}

/** One hub per app instance. */
export class ChatHub {
  readonly tickets = new TicketStore();
  readonly sendLimiter = new SlidingWindowLimiter(SEND_RATE_LIMIT.max, SEND_RATE_LIMIT.windowMs);
  readonly frameLimiter = new SlidingWindowLimiter(FRAME_RATE_LIMIT.max, FRAME_RATE_LIMIT.windowMs);
  readonly typingThrottle = new Throttle(TYPING_THROTTLE_MS);
  readonly caps: ChatCaps = {
    perSession: MAX_SOCKETS_PER_SESSION,
    perUser: MAX_SOCKETS_PER_USER,
    total: MAX_SOCKETS_TOTAL
  };

  private readonly bySession = new Map<string, Set<ChatConnection>>();
  private readonly byUser = new Map<string, Set<ChatConnection>>();
  private total = 0;
  private nextId = 1;
  private recheckRunning: Promise<number> | null = null;
  /** Session ids closed recently → forget-after time (ms). */
  private readonly revokedSessions = new Map<string, number>();
  /** Test seams ({@link ChatHubHooks}); empty in production. */
  readonly hooks: ChatHubHooks = {};

  constructor(private readonly deps: ChatHubDeps) {}

  /** A fresh connection id (increasing). */
  allocateId(): number {
    const id = this.nextId;
    this.nextId += 1;
    return id;
  }

  /** Live sockets in this process. */
  get size(): number {
    return this.total;
  }

  /** True when no new socket may be accepted ({@link ChatCaps.total}). */
  isFull(): boolean {
    return this.total >= this.caps.total;
  }

  /**
   * Register a socket after its ticket and session checked out, then evict the
   * oldest sockets of its session and user beyond the caps.
   *
   * @returns `false` (and the socket is closed with `SessionRevoked`) when its
   * session was closed in the last {@link REVOKED_MEMORY_MS}: that revocation
   * raced the handshake's DB check.
   */
  add(connection: ChatConnection): boolean {
    const { sessionId, userId } = connection.principal;
    if (this.isRecentlyRevoked(sessionId)) {
      connection.close(WsCloseCode.SessionRevoked, CloseReason.SessionEnded);
      return false;
    }
    const wasOnline = this.byUser.has(userId);
    const sessionSet = addTo(this.bySession, sessionId, connection);
    const userSet = addTo(this.byUser, userId, connection);
    this.total += 1;
    this.evictOldest(sessionSet, this.caps.perSession);
    this.evictOldest(userSet, this.caps.perUser);
    if (!wasOnline && connection.principal.listedInDirectory) this.broadcastPresence();
    else connection.send(this.presenceFrameFor(connection));
    return true;
  }

  /** Forget a socket (on close). Idempotent. */
  remove(connection: ChatConnection): void {
    const { sessionId, userId } = connection.principal;
    if (!removeFrom(this.bySession, sessionId, connection)) return;
    removeFrom(this.byUser, userId, connection);
    this.total -= 1;
    if (!this.byUser.has(userId) && connection.principal.listedInDirectory) this.broadcastPresence();
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
    this.rememberRevoked(sessionId);
    return this.closeAllOf([...(this.bySession.get(sessionId) ?? [])], code, reason);
  }

  /**
   * Close every socket of a user and burn their unused tickets. Every session
   * id the hub knows for the user (live sockets and unused tickets) is also
   * remembered for {@link REVOKED_MEMORY_MS}, like {@link closeSession}, so a
   * handshake of one of those sessions that is past its DB check cannot
   * register afterwards.
   *
   * @returns How many sockets were closed.
   */
  closeUser(
    userId: string,
    code: number = WsCloseCode.SessionRevoked,
    reason: string = CloseReason.SessionEnded
  ): number {
    const sessionIds = this.tickets.revokeUser(userId);
    const connections = [...(this.byUser.get(userId) ?? [])];
    for (const connection of connections) sessionIds.add(connection.principal.sessionId);
    for (const sessionId of sessionIds) this.rememberRevoked(sessionId);
    return this.closeAllOf(connections, code, reason);
  }

  /** True while `sessionId` is in the recently-revoked memory (tests and diagnostics). */
  isRecentlyRevoked(sessionId: string): boolean {
    return (this.revokedSessions.get(sessionId) ?? 0) > this.deps.clock.now().getTime();
  }

  private rememberRevoked(sessionId: string): void {
    this.revokedSessions.set(sessionId, this.deps.clock.now().getTime() + REVOKED_MEMORY_MS);
  }

  /**
   * Re-validate every connected session against the database and close the
   * sockets of sessions that were revoked or expired, or whose user was
   * disabled, unverified or must change their password. Also refreshes each
   * user's directory listing for presence. Runs every
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
    const usable = await usableSessions(this.deps.db, sessionIds, this.deps.clock.now());
    let closed = 0;
    let presenceChanged = false;
    for (const sessionId of sessionIds) {
      const listed = usable.get(sessionId);
      if (listed === undefined) {
        closed += this.closeSession(sessionId);
        continue;
      }
      for (const connection of this.bySession.get(sessionId) ?? []) {
        if (connection.principal.listedInDirectory !== listed) {
          connection.principal.listedInDirectory = listed;
          presenceChanged = true;
        }
      }
    }
    if (presenceChanged) this.broadcastPresence();
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
    for (const [id, until] of this.revokedSessions) if (until <= now.getTime()) this.revokedSessions.delete(id);
  }

  /** Resolve once any in-flight session re-check has finished (shutdown). */
  async idle(): Promise<void> {
    await this.recheckRunning?.catch(() => undefined);
  }

  /** Close everything (app shutdown). */
  closeAll(): void {
    this.closeAllOf(this.connections(), 1001, CloseReason.Shutdown);
  }

  private closeAllOf(connections: readonly ChatConnection[], code: number, reason: string): number {
    for (const connection of connections) {
      this.remove(connection);
      connection.close(code, reason);
    }
    return connections.length;
  }

  /** Close the oldest sockets of `set` until it has at most `max`, telling each why. */
  private evictOldest(set: ReadonlySet<ChatConnection>, max: number): void {
    if (set.size <= max) return;
    const oldestFirst = [...set].sort((a, b) => a.id - b.id);
    for (const connection of oldestFirst.slice(0, set.size - max)) {
      connection.send({
        type: "error",
        code: "CONFLICT",
        message: CloseReason.TooManyConnections,
        clientMessageId: null
      });
      this.remove(connection);
      connection.close(WS_NORMAL_CLOSURE, CloseReason.TooManyConnections);
    }
  }

  /** Listed online members, plus the recipient. */
  private presenceFrameFor(recipient: ChatConnection): WsServerMessage {
    const online = this.listedOnline();
    online.add(recipient.principal.userId);
    return { type: "presence", onlineUserIds: [...online].slice(0, 5000) };
  }

  private listedOnline(): Set<string> {
    const online = new Set<string>();
    for (const [userId, set] of this.byUser) {
      for (const connection of set) {
        if (connection.principal.listedInDirectory) {
          online.add(userId);
          break;
        }
      }
    }
    return online;
  }

  private broadcastPresence(): void {
    const listed = [...this.listedOnline()].slice(0, 4999);
    const shared: WsServerMessage = { type: "presence", onlineUserIds: listed };
    this.fanOut((connection) =>
      connection.principal.listedInDirectory
        ? shared
        : { type: "presence", onlineUserIds: [...listed, connection.principal.userId] }
    );
  }
}
