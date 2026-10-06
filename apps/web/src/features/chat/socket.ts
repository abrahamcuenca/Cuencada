/**
 * The chat WebSocket client (T7) [SEC].
 *
 * **One shared connection per tab, only while a chat route is mounted.**
 * `ChatPage` calls {@link useChatConnection}; the first mount opens the
 * socket, the last unmount closes it. Outside `/chat` the unread badge polls
 * `GET /chat/rooms` instead (see `unread.ts`): a socket per idle tab would
 * keep phones awake for a badge that can be a minute late.
 *
 * Lifecycle:
 * 1. `POST /chat/ticket` (RTK mutation, `track: false`) → a single-use, 30 s
 *    ticket. A fresh ticket is fetched for every (re)connect.
 * 2. Open `wss://<api host><wsPath>?ticket=…` (`ws:` only in dev builds). The
 *    ticket is the only token we ever put in a URL (ADR 0001); it is never
 *    logged or stored.
 * 3. Every inbound frame is size-checked, `JSON.parse`d and validated with
 *    the contract's `wsServerMessageSchema`; anything else is dropped. Valid
 *    frames go to the `events.ts` hub, where the RTK Query cache entries
 *    merge them. Nothing is ever rendered as HTML.
 * 4. On close: exponential backoff with jitter (1 s → 30 s cap), paused while
 *    offline (`navigator.onLine` or the auth `isOffline` flag) and after the
 *    tab has been hidden for {@link HIDDEN_PAUSE_MS}; it resumes at once on
 *    `online` / `visibilitychange`.
 * 5. Logout, user switch or a new session epoch closes the socket right away
 *    (store subscription); a still-mounted chat reconnects with a ticket for
 *    the new session.
 * 6. 403 on the ticket or close code 4003 → `forbidden` (unverified email);
 *    no retries. Close code 4010 (session revoked) → no blind retry: one
 *    authenticated REST call runs the normal auth flow (refresh, or logout
 *    if refused); only a session that survives it reconnects. 1008 (bad or
 *    used ticket), 1009, 4400 and 4008 (backpressure, longer backoff) retry
 *    with a fresh ticket (a ticket is burned on any attempt, so never reused).
 *    1013 (server full) waits 30 s or more. 1000 after an `error` CONFLICT
 *    frame ("Demasiadas conexiones abiertas.") means another tab took this
 *    socket's place: no automatic reconnect, the user taps "Reconectar".
 * 7. Outgoing frames stay under the server's limits (20 sends and 60 frames
 *    per 10 s, no bursts): extra `send`s wait in a short queue, extra
 *    `typing`/`ping` frames are dropped.
 */
import {
  type ChatTicketResponse,
  chatTicketResponseSchema,
  WS_MAX_FRAME_BYTES,
  WS_PING_INTERVAL_MS,
  type WsClientMessage,
  type WsClientMessageRequest,
  WsCloseCode,
  wsClientMessageSchema,
  type WsServerMessage,
  wsServerMessageSchema
} from "@cuencada/types";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useStore } from "react-redux";
import type { AppDispatch, AppStore, RootState } from "../../app/store";
import { getApiErrorCode, isAbortError, isFetchBaseQueryError } from "../../shared/api/errors";
import { env } from "../../shared/lib/env";
import { reportUnexpected } from "../../shared/lib/reportUnexpected";
import { chatApi } from "./api";
import { conversationApi } from "./conversationApi";
import { emitChatEvent, setChatTransport } from "./events";

/** What the conversation shows about the connection. */
export type ChatConnectionStatus =
  /** No chat route mounted, or no session. */
  | "idle"
  /** First connection attempt. */
  | "connecting"
  | "open"
  /** Lost the connection; retrying with backoff. */
  | "reconnecting"
  /** The browser (or the API) is unreachable; waiting for `online`. */
  | "offline"
  /** The tab was hidden for a long time; reconnects when visible again. */
  | "paused"
  /** The server refused chat for this account (unverified email). */
  | "forbidden"
  /** The server closed this socket because the account has too many open (another tab); waits for "Reconectar". */
  | "evicted";

/** The subset of `WebSocket` the client uses, so tests can inject a fake. */
export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** Builds a socket for a URL (the real `WebSocket` in the browser). */
export type WebSocketFactory = (url: string) => WebSocketLike;

/** The store surface the connection needs. */
export interface ChatStore {
  dispatch: AppDispatch;
  getState: () => RootState;
  subscribe: (listener: () => void) => () => void;
}

/** Injectable dependencies (tests swap them). */
export interface ChatSocketDeps {
  createSocket: WebSocketFactory;
  /** `Math.random` (jitter). */
  random: () => number;
}

/** A validated `send` frame. */
type WsClientSend = Extract<WsClientMessage, { type: "send" }>;

/** `WebSocket.OPEN`. */
const OPEN = 1;
/** First retry delay. */
export const BACKOFF_BASE_MS = 1000;
/** Maximum retry delay. */
export const BACKOFF_MAX_MS = 30_000;
/** A connection that stayed open this long resets the backoff. */
export const STABLE_CONNECTION_MS = 10_000;
/** Close the socket after the tab has been hidden this long. */
export const HIDDEN_PAUSE_MS = 5 * 60_000;
/** A `send` without its echo for this long is marked failed. */
export const SEND_ACK_TIMEOUT_MS = 15_000;
/** No inbound frame (pong included) for this long → the connection is dead. */
export const LIVENESS_TIMEOUT_MS = WS_PING_INTERVAL_MS * 2 + 10_000;
/** Normal closure; with {@link EVICTION_REASON} it means "too many connections". */
const WS_NORMAL_CLOSURE = 1000;
/** 1013 Try Again Later: the server is full. */
const WS_TRY_AGAIN_LATER = 1013;
/** Close reason the server uses when it evicts the oldest socket of an account. */
const EVICTION_REASON = "Demasiadas conexiones abiertas.";
/** After 1013, wait at least this long (plus jitter). */
export const SERVER_BUSY_MIN_DELAY_MS = 30_000;
/** Backoff floor after the server closed with 4008 (rate limited / backpressure). */
const RATE_LIMITED_ATTEMPT = 3;

/** A sliding-window budget. */
interface FrameBudget {
  max: number;
  windowMs: number;
}

/** `send` frames: the server allows 20 per 10 s. */
export const SEND_BUDGET: FrameBudget = { max: 18, windowMs: 10_000 };
/** All frames: the server allows 60 per 10 s. */
export const FRAME_BUDGET: FrameBudget = { max: 50, windowMs: 10_000 };
/** Bursts: the server closes at 32 queued frames; stay far below. */
export const BURST_BUDGET: FrameBudget = { max: 8, windowMs: 1000 };

/**
 * Exponential backoff with "equal jitter": half the window is fixed, half is
 * random, so a crowd of tabs reconnecting after a deploy spreads out.
 *
 * @param attempt - 0 for the first retry.
 * @param random - A number in [0, 1).
 * @returns The delay in ms, at most {@link BACKOFF_MAX_MS}.
 */
export function backoffDelay(attempt: number, random: number): number {
  const window = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt));
  return Math.round(window / 2 + (window / 2) * Math.min(Math.max(random, 0), 1));
}

/** Only absolute, plain paths such as `/api/chat/ws` (no `//host`, no `..`, no query). */
const WS_PATH = /^\/(?!\/)[A-Za-z0-9._~\-/]{0,99}$/;

/**
 * Builds the WebSocket URL for a ticket [SEC].
 *
 * The host always comes from our API base, never from the response, so a
 * tampered `wsPath` cannot send the ticket elsewhere. `wss:` is required
 * unless `allowInsecure` (dev builds) is set.
 *
 * @param ticket - The validated ticket response.
 * @param apiBaseUrl - Absolute API base (`env.apiBaseUrl`).
 * @param allowInsecure - Allow `ws:` for an `http:` API (dev only).
 * @returns The URL, or `null` when it would not be safe.
 */
export function buildChatSocketUrl(ticket: ChatTicketResponse, apiBaseUrl: string, allowInsecure: boolean): string | null {
  if (!WS_PATH.test(ticket.wsPath) || ticket.wsPath.split("/").includes("..")) return null;
  let base: URL;
  try {
    base = new URL(apiBaseUrl);
  } catch {
    return null;
  }
  const url = new URL(ticket.wsPath, base.origin);
  if (base.protocol === "https:") url.protocol = "wss:";
  else if (base.protocol === "http:" && allowInsecure) url.protocol = "ws:";
  else return null;
  url.searchParams.set("ticket", ticket.ticket);
  return url.toString();
}

/**
 * Parses and validates one inbound frame [SEC]. Oversized, non-text,
 * non-JSON and off-contract frames return `null` (dropped without logging
 * their content).
 *
 * @param data - `MessageEvent.data`.
 * @returns The frame, or `null`.
 */
export function parseServerFrame(data: unknown): WsServerMessage | null {
  if (typeof data !== "string") return null;
  // `length` counts UTF-16 units: ≥ 1/3 of the UTF-8 bytes, ≤ the byte count.
  if (data.length > WS_MAX_FRAME_BYTES) return null;
  if (data.length * 3 > WS_MAX_FRAME_BYTES && new TextEncoder().encode(data).byteLength > WS_MAX_FRAME_BYTES) return null;
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return null;
  }
  const parsed = wsServerMessageSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

type Timer = ReturnType<typeof setTimeout>;

function isOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

function isHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function ticketErrorStatus(error: unknown): number | null {
  return isFetchBaseQueryError(error) && typeof error.status === "number" ? error.status : null;
}

/** One tab's chat connection. Use {@link getChatConnection}. */
export class ChatConnection {
  private readonly store: ChatStore;
  private readonly deps: ChatSocketDeps;
  private refs = 0;
  private started = false;
  private status: ChatConnectionStatus = "idle";
  private readonly statusListeners = new Set<() => void>();
  private socket: WebSocketLike | null = null;
  /** Bumped by every connect/teardown; stale async results compare against it. */
  private generation = 0;
  private attempt = 0;
  private everOpened = false;
  /** The server announced an eviction (`error` CONFLICT without a message id) before closing. */
  private evictionAnnounced = false;
  private openedAt: number | null = null;
  private lastInboundAt = 0;
  private sessionKey: string | null = null;
  private retryTimer: Timer | null = null;
  private hiddenTimer: Timer | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private readonly ackTimers = new Map<string, Timer>();
  /** `send` frames waiting for budget (oldest first). */
  private outbox: WsClientSend[] = [];
  private drainTimer: Timer | null = null;
  private frameTimes: number[] = [];
  private sendTimes: number[] = [];
  private detachers: (() => void)[] = [];

  constructor(store: ChatStore, deps: ChatSocketDeps) {
    this.store = store;
    this.deps = deps;
  }

  /** @returns The current status (stable between changes, for `useSyncExternalStore`). */
  readonly getStatus = (): ChatConnectionStatus => this.status;

  /**
   * @param listener - Called when the status changes.
   * @returns An unsubscribe function.
   */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  };

  /**
   * Keeps the connection open until the returned release function is called.
   * The first holder opens it; the last release closes it (a microtask later,
   * so a release immediately followed by an acquire, such as React
   * StrictMode's double effects, keeps the same socket).
   *
   * @returns Release function (idempotent).
   */
  acquire(): () => void {
    this.refs += 1;
    if (this.refs === 1 && !this.started) this.start();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.refs -= 1;
      if (this.refs === 0) {
        queueMicrotask(() => {
          if (this.refs === 0 && this.started) this.stop();
        });
      }
    };
  }

  /**
   * Writes a client frame to the open socket after validating it with the
   * contract, within the rate budget. Over budget, a `send` waits in the
   * outbox (still `true`: it will go out); other frames are dropped. A
   * written `send` starts the echo timer.
   *
   * @param frame - The frame.
   * @returns Whether it was written or queued.
   */
  readonly send = (frame: WsClientMessageRequest): boolean => {
    const socket = this.socket;
    if (socket === null || socket.readyState !== OPEN) return false;
    const parsed = wsClientMessageSchema.safeParse(frame);
    if (!parsed.success) return false;
    const data = parsed.data;
    if (data.type === "send") {
      if (this.outbox.length > 0 || !this.hasBudget(true)) {
        if (!this.outbox.some((queued) => queued.clientMessageId === data.clientMessageId)) this.outbox.push(data);
        this.scheduleDrain();
        return true;
      }
      return this.write(data);
    }
    return this.hasBudget(false) && this.write(data);
  };

  private write(frame: WsClientMessage): boolean {
    const socket = this.socket;
    if (socket === null || socket.readyState !== OPEN) return false;
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      return false;
    }
    const now = Date.now();
    this.frameTimes.push(now);
    if (frame.type === "send") {
      this.sendTimes.push(now);
      this.startAckTimer(frame.clientMessageId);
    }
    return true;
  }

  private hasBudget(isSend: boolean): boolean {
    const now = Date.now();
    const recent = (times: number[], budget: FrameBudget): number[] => times.filter((time) => now - time < budget.windowMs);
    this.frameTimes = recent(this.frameTimes, FRAME_BUDGET);
    this.sendTimes = recent(this.sendTimes, SEND_BUDGET);
    const burst = this.frameTimes.filter((time) => now - time < BURST_BUDGET.windowMs).length;
    if (this.frameTimes.length >= FRAME_BUDGET.max || burst >= BURST_BUDGET.max) return false;
    return !isSend || this.sendTimes.length < SEND_BUDGET.max;
  }

  /** @returns How long until a `send` fits the budget again. */
  private budgetDelay(): number {
    const now = Date.now();
    const waits = [0];
    const waitFor = (times: number[], budget: FrameBudget): void => {
      const inWindow = times.filter((time) => now - time < budget.windowMs);
      const oldest = inWindow[inWindow.length - budget.max];
      if (inWindow.length >= budget.max && oldest !== undefined) waits.push(oldest + budget.windowMs - now);
    };
    waitFor(this.frameTimes, FRAME_BUDGET);
    waitFor(this.sendTimes, SEND_BUDGET);
    waitFor(this.frameTimes, BURST_BUDGET);
    return Math.max(...waits) + 1;
  }

  private scheduleDrain(): void {
    if (this.drainTimer !== null) return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      while (this.outbox.length > 0 && this.hasBudget(true)) {
        const next = this.outbox.shift();
        if (next !== undefined) this.write(next);
      }
      if (this.outbox.length > 0) this.scheduleDrain();
    }, this.budgetDelay());
  }

  /** Reconnects now (the "Reconectar" button after an eviction). */
  reconnect(): void {
    if (this.refs === 0) return;
    this.attempt = 0;
    void this.connect();
  }

  /** Closes everything for good (store replaced, tests). */
  dispose(): void {
    this.refs = 0;
    if (this.started) this.stop();
    this.statusListeners.clear();
  }

  private setStatus(next: ChatConnectionStatus): void {
    if (this.status === next) return;
    this.status = next;
    for (const listener of [...this.statusListeners]) listener();
  }

  private start(): void {
    this.started = true;
    this.sessionKey = this.currentSessionKey();
    this.detachers.push(this.store.subscribe(this.onStoreChange));
    if (typeof window !== "undefined") {
      window.addEventListener("online", this.onOnline);
      window.addEventListener("offline", this.onOffline);
      this.detachers.push(() => {
        window.removeEventListener("online", this.onOnline);
        window.removeEventListener("offline", this.onOffline);
      });
    }
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onVisibilityChange);
      this.detachers.push(() => document.removeEventListener("visibilitychange", this.onVisibilityChange));
    }
    void this.connect();
  }

  private stop(): void {
    this.started = false;
    for (const detach of this.detachers) detach();
    this.detachers = [];
    this.teardownSocket();
    this.clearTimer("retry");
    this.clearTimer("hidden");
    this.attempt = 0;
    this.everOpened = false;
    this.setStatus("idle");
  }

  /** Identifies the session the socket belongs to: epoch + user. */
  private currentSessionKey(): string | null {
    const { auth } = this.store.getState();
    if (auth.status !== "authenticated" || auth.user === null || auth.passwordChangeRequired) return null;
    return `${auth.sessionEpoch}:${auth.user.id}`;
  }

  private canReachNetwork(): boolean {
    return isOnline() && !this.store.getState().auth.isOffline;
  }

  private readonly onStoreChange = (): void => {
    const key = this.currentSessionKey();
    if (key !== this.sessionKey) {
      // [SEC] Logout, account switch or a new epoch: the old socket must not live on.
      this.sessionKey = key;
      this.teardownSocket();
      this.clearTimer("retry");
      this.attempt = 0;
      this.everOpened = false;
      if (key === null) this.setStatus("idle");
      else void this.connect();
      return;
    }
    if (this.status === "offline" && this.canReachNetwork()) void this.connect();
  };

  private readonly onOnline = (): void => {
    if (this.status === "offline" || this.status === "reconnecting") {
      this.attempt = 0;
      this.clearTimer("retry");
      void this.connect();
    }
  };

  private readonly onOffline = (): void => {
    if (this.status === "forbidden" || this.status === "idle") return;
    this.teardownSocket();
    this.clearTimer("retry");
    this.setStatus("offline");
  };

  private readonly onVisibilityChange = (): void => {
    if (isHidden()) {
      this.clearTimer("hidden");
      this.hiddenTimer = setTimeout(() => {
        this.hiddenTimer = null;
        if (this.status === "forbidden" || this.status === "idle") return;
        this.teardownSocket();
        this.clearTimer("retry");
        this.setStatus("paused");
      }, HIDDEN_PAUSE_MS);
      return;
    }
    this.clearTimer("hidden");
    if (this.status === "paused" || (this.status === "reconnecting" && this.retryTimer !== null)) {
      this.attempt = 0;
      this.clearTimer("retry");
      void this.connect();
    }
  };

  private async connect(): Promise<void> {
    this.clearTimer("retry");
    this.teardownSocket();
    if (this.refs === 0) return;
    const sessionKey = this.currentSessionKey();
    if (sessionKey === null) {
      this.setStatus("idle");
      return;
    }
    if (!this.canReachNetwork()) {
      this.setStatus("offline");
      return;
    }
    const generation = ++this.generation;
    this.setStatus(this.everOpened ? "reconnecting" : "connecting");

    let ticket: unknown;
    try {
      ticket = await this.store.dispatch(conversationApi.endpoints.createChatTicket.initiate(undefined, { track: false })).unwrap();
    } catch (error) {
      if (generation !== this.generation) return;
      // An abort with the same session (the API cache was reset by an account switch): try again shortly.
      if (isAbortError(error)) {
        if (this.currentSessionKey() === sessionKey) this.scheduleRetry();
        return;
      }
      if (ticketErrorStatus(error) === 403 || getApiErrorCode(error) === "FORBIDDEN") {
        this.setStatus("forbidden");
        return;
      }
      // 401s were already handled by the base query (refresh, or logout → store listener).
      this.scheduleRetry();
      return;
    }
    // A logout or user switch while the ticket was in flight: drop it.
    if (generation !== this.generation || this.refs === 0 || this.currentSessionKey() !== sessionKey) return;

    const parsed = chatTicketResponseSchema.safeParse(ticket);
    const url = parsed.success ? buildChatSocketUrl(parsed.data, env.apiBaseUrl, env.isDev) : null;
    if (url === null) {
      reportUnexpected(new Error("Chat: respuesta de ticket inválida o URL de WebSocket no permitida."));
      this.scheduleRetry();
      return;
    }

    let socket: WebSocketLike;
    try {
      socket = this.deps.createSocket(url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (generation !== this.generation) return;
      this.handleOpen();
    };
    socket.onmessage = (event) => {
      if (generation !== this.generation) return;
      this.handleMessage(event.data);
    };
    socket.onclose = (event) => {
      if (generation !== this.generation) return;
      this.handleClose(event.code, event.reason);
    };
    socket.onerror = () => {
      // `close` always follows `error`; retries are handled there.
    };
  }

  private handleOpen(): void {
    const resumed = this.everOpened;
    this.everOpened = true;
    this.openedAt = Date.now();
    this.lastInboundAt = Date.now();
    setChatTransport(this.send);
    this.startPing();
    this.setStatus("open");
    emitChatEvent({ type: "open", resumed });
  }

  private handleMessage(data: unknown): void {
    const frame = parseServerFrame(data);
    if (frame === null) return;
    this.lastInboundAt = Date.now();
    if ((frame.type === "message" || frame.type === "error") && frame.clientMessageId !== null) {
      this.clearAck(frame.clientMessageId);
    }
    // Too many sockets for this account: the server sends this, then closes with 1000.
    if (frame.type === "error" && frame.clientMessageId === null && frame.code === "CONFLICT") this.evictionAnnounced = true;
    emitChatEvent({ type: "frame", frame });
  }

  private handleClose(code: number, reason: string): void {
    const openedAt = this.openedAt;
    const evicted = this.evictionAnnounced || (code === WS_NORMAL_CLOSURE && reason === EVICTION_REASON);
    this.evictionAnnounced = false;
    this.teardownSocket();
    if (code === WsCloseCode.Forbidden) {
      this.setStatus("forbidden");
      return;
    }
    if (evicted) {
      // Reconnecting on our own would just evict another tab in turn.
      this.setStatus("evicted");
      return;
    }
    if (code === WS_TRY_AGAIN_LATER) {
      this.scheduleRetry(SERVER_BUSY_MIN_DELAY_MS);
      return;
    }
    if (code === WsCloseCode.SessionRevoked) {
      this.setStatus("reconnecting");
      void this.verifySessionThenRetry();
      return;
    }
    if (openedAt !== null && Date.now() - openedAt >= STABLE_CONNECTION_MS) this.attempt = 0;
    if (code === WsCloseCode.RateLimited) this.attempt = Math.max(this.attempt, RATE_LIMITED_ATTEMPT);
    this.scheduleRetry();
  }

  /**
   * After 4010: one authenticated request runs the app's auth flow. A revoked
   * session gets 401 → refresh → `loggedOut` (the store listener then stops
   * everything); a session that is still valid reconnects with backoff.
   */
  private async verifySessionThenRetry(): Promise<void> {
    const generation = this.generation;
    const sessionKey = this.currentSessionKey();
    await this.store.dispatch(chatApi.endpoints.getRooms.initiate(undefined, { subscribe: false, forceRefetch: true }));
    if (generation !== this.generation || this.refs === 0 || this.currentSessionKey() !== sessionKey) return;
    this.scheduleRetry();
  }

  private scheduleRetry(minDelayMs = 0): void {
    if (this.refs === 0) return;
    if (!this.canReachNetwork()) {
      this.setStatus("offline");
      return;
    }
    const random = this.deps.random();
    const delay = Math.max(backoffDelay(this.attempt, random), minDelayMs + Math.round((minDelayMs / 2) * random));
    this.attempt += 1;
    this.setStatus(this.everOpened ? "reconnecting" : "connecting");
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastInboundAt > LIVENESS_TIMEOUT_MS) {
        // A silent, half-open connection (common after a phone sleeps): drop it and retry.
        this.teardownSocket();
        this.scheduleRetry();
        return;
      }
      this.send({ type: "ping", ts: Date.now() });
    }, WS_PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private startAckTimer(clientMessageId: string): void {
    this.clearAck(clientMessageId);
    this.ackTimers.set(
      clientMessageId,
      setTimeout(() => {
        this.ackTimers.delete(clientMessageId);
        emitChatEvent({ type: "send_failed", clientMessageId });
      }, SEND_ACK_TIMEOUT_MS)
    );
  }

  private clearAck(clientMessageId: string): void {
    const timer = this.ackTimers.get(clientMessageId);
    if (timer !== undefined) clearTimeout(timer);
    this.ackTimers.delete(clientMessageId);
  }

  /** Detaches and closes the socket. Pending sends stay pending; they are resent on the next `open`. */
  private teardownSocket(): void {
    this.generation += 1;
    this.stopPing();
    for (const timer of this.ackTimers.values()) clearTimeout(timer);
    this.ackTimers.clear();
    // Queued sends stay `pending` in the cache and are resent on the next `open`.
    this.outbox = [];
    if (this.drainTimer !== null) clearTimeout(this.drainTimer);
    this.drainTimer = null;
    this.openedAt = null;
    const socket = this.socket;
    this.socket = null;
    setChatTransport(null);
    if (socket === null) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close(1000);
    } catch {
      // Already closed.
    }
  }

  private clearTimer(which: "retry" | "hidden"): void {
    const timer = which === "retry" ? this.retryTimer : this.hiddenTimer;
    if (timer !== null) clearTimeout(timer);
    if (which === "retry") this.retryTimer = null;
    else this.hiddenTimer = null;
  }
}

const defaultDeps: ChatSocketDeps = {
  createSocket: (url) => new WebSocket(url),
  random: () => Math.random()
};

let depsOverride: Partial<ChatSocketDeps> = {};
let instance: { store: ChatStore; connection: ChatConnection } | null = null;

/**
 * The tab's single connection, bound to the app store. A different store
 * (tests) disposes the previous connection.
 *
 * @param store - The Redux store.
 * @returns The shared connection.
 */
export function getChatConnection(store: ChatStore): ChatConnection {
  if (instance === null || instance.store !== store) {
    instance?.connection.dispose();
    instance = { store, connection: new ChatConnection(store, { ...defaultDeps, ...depsOverride }) };
  }
  return instance.connection;
}

/**
 * Test hook: inject a fake socket factory and/or jitter source. Applies to
 * connections created afterwards.
 *
 * @param overrides - Dependencies to replace.
 */
export function configureChatSocketForTests(overrides: Partial<ChatSocketDeps>): void {
  depsOverride = overrides;
}

/** Test hook: disposes the shared connection and forgets injected dependencies. */
export function resetChatSocketForTests(): void {
  instance?.connection.dispose();
  instance = null;
  depsOverride = {};
}

const useAppStore = useStore.withTypes<AppStore>();

/** What {@link useChatConnection} returns. */
export interface ChatConnectionHandle {
  status: ChatConnectionStatus;
  /** Reconnects now (after an eviction). */
  reconnect: () => void;
}

/**
 * Keeps the shared chat connection open while the calling component is
 * mounted (and `enabled`).
 *
 * @param enabled - False to stay disconnected (e.g. the chat is forbidden).
 * @returns The live connection status and a manual reconnect.
 */
export function useChatConnection(enabled: boolean): ChatConnectionHandle {
  const store = useAppStore();
  const connection = getChatConnection(store);
  useEffect(() => (enabled ? connection.acquire() : undefined), [connection, enabled]);
  const status = useSyncExternalStore(connection.subscribe, connection.getStatus, connection.getStatus);
  const reconnect = useCallback(() => connection.reconnect(), [connection]);
  return { status, reconnect };
}
