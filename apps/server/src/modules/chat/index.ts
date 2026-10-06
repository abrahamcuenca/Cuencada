/**
 * Chat module (T7 owns this folder). Registered under `/api` by
 * `app.ts`; add routes here: chat REST routes, `POST /chat/ticket` and the `/chat/ws` WebSocket route (`@fastify/websocket` is registered).
 * See `docs/coordination/WP-0.4.md` for the route checklist.
 */
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";

/** Chat routes under `/api` (stub until T7). */
const chatModule: FastifyPluginAsyncZod = async () => {};

export default chatModule;
