/**
 * Close chat sockets after a session revocation commits (T7 wiring).
 *
 * Non-fatal by design: the revocation is already committed, and the chat
 * hub's 5-minute session re-check closes any socket missed here. A failure is
 * logged (error name only) and the request continues.
 */
import type { FastifyInstance } from "fastify";
import { closeSocketsForSession, closeSocketsForUser } from "../chat/index.js";

/** Which sockets to close. */
export type ChatSocketTarget = { sessionIds: readonly string[] } | { userId: string };

/**
 * Close the chat sockets of the given sessions, or of every session of a user.
 * Call only **after** the revoking transaction committed.
 *
 * @param app - Any Fastify instance of the app.
 * @param target - Session ids, or a user id.
 */
export function closeChatSockets(app: FastifyInstance, target: ChatSocketTarget): void {
  try {
    if ("userId" in target) {
      closeSocketsForUser(app, target.userId);
      return;
    }
    for (const sessionId of target.sessionIds) closeSocketsForSession(app, sessionId);
  } catch (error) {
    app.log.error(
      { errorName: error instanceof Error ? error.name : "unknown" },
      "closing chat sockets failed; the periodic re-check will close them"
    );
  }
}
