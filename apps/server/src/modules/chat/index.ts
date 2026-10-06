/**
 * Chat module (T7): REST routes, the ticket endpoint and the
 * `GET /api/chat/ws?ticket=` WebSocket. Registered under `/api` by `app.ts`.
 * See `docs/coordination/WP-T7-BE.md`.
 *
 * One {@link ChatHub} per app holds the live sockets. Timers (unref'd, cleared
 * on close): heartbeat every `WS_PING_INTERVAL_MS` (25 s), session re-check
 * every 5 min, ticket/limiter sweep every minute.
 *
 * **For T1/T8:** after revoking a session or disabling a user, call
 * {@link closeSocketsForSession} / {@link closeSocketsForUser} so open sockets
 * close at once (code `WsCloseCode.SessionRevoked`) instead of at the next
 * 5-minute re-check. Both also burn unused tickets and are safe to call
 * before the chat module has seen any socket.
 */
import { WS_PING_INTERVAL_MS } from "@cuencada/types";
import type { FastifyInstance } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { rateLimitByIp } from "../../lib/rateLimit.js";
import { ChatHub, SESSION_RECHECK_INTERVAL_MS, SWEEP_INTERVAL_MS } from "./hub.js";
import chatRoutes from "./routes.js";
import { openChatSocket } from "./socket.js";

/**
 * Hubs by HTTP server. Every encapsulated Fastify context of one app shares
 * `app.server`, so any module can find the hub from its own instance.
 */
const hubs = new WeakMap<object, ChatHub>();

/**
 * The chat hub of the app `instance` belongs to (tests and other modules).
 *
 * @returns The hub, or `null` before the chat module registered.
 */
export function chatHubOf(instance: FastifyInstance): ChatHub | null {
  return hubs.get(instance.server) ?? null;
}

/**
 * Close every chat socket of a session (and burn its unused tickets).
 * Call after revoking a session (logout, password change, admin revoke).
 *
 * @param instance - Any Fastify instance of the app.
 * @returns How many sockets were closed.
 */
export function closeSocketsForSession(instance: FastifyInstance, sessionId: string): number {
  return chatHubOf(instance)?.closeSession(sessionId) ?? 0;
}

/**
 * Close every chat socket of a user (and burn their unused tickets).
 * Call after disabling a user or revoking all their sessions.
 *
 * @param instance - Any Fastify instance of the app.
 * @returns How many sockets were closed.
 */
export function closeSocketsForUser(instance: FastifyInstance, userId: string): number {
  return chatHubOf(instance)?.closeUser(userId) ?? 0;
}

/** Chat routes under `/api` plus the hub's timers. */
const chatModule: FastifyPluginAsyncZod = async (app) => {
  const hub = new ChatHub({ db: app.db, clock: app.clock, log: app.log });
  hubs.set(app.server, hub);

  await app.register(chatRoutes, { hub });

  /** `GET /api/chat/ws?ticket=`: the chat socket. The ticket, not a bearer token, authenticates it. */
  app.get(
    "/chat/ws",
    {
      websocket: true,
      config: {
        auth: "public",
        rateLimit: rateLimitByIp({ max: 30, timeWindow: "1 minute" })
      }
    },
    (socket, request) => {
      openChatSocket(app, hub, socket, request);
    }
  );

  const timers: NodeJS.Timeout[] = [];
  app.addHook("onReady", async () => {
    const every = (ms: number, task: () => void): void => {
      const timer = setInterval(task, ms);
      timer.unref();
      timers.push(timer);
    };
    every(WS_PING_INTERVAL_MS, () => {
      hub.heartbeat();
    });
    every(SWEEP_INTERVAL_MS, () => {
      hub.sweep();
    });
    every(SESSION_RECHECK_INTERVAL_MS, () => {
      hub.recheckSessions().catch((error: unknown) => {
        app.log.error({ err: error }, "chat session re-check failed");
      });
    });
  });
  app.addHook("onClose", async () => {
    for (const timer of timers) clearInterval(timer);
    await hub.idle();
    hub.closeAll();
    hubs.delete(app.server);
  });
};

export default chatModule;
