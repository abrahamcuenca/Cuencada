/**
 * WebSocket tickets [SEC]: 256-bit opaque, single-use, 30 s, bound to the
 * issuing session (ADR 0001). Only the SHA-256 hash is kept, in memory: a
 * restart simply invalidates outstanding tickets, and the client asks for a
 * new one. Never log a ticket or its hash.
 */
import { CHAT_TICKET_TTL_SECONDS } from "@cuencada/types";
import { createOpaqueToken, hashToken } from "../../lib/tokens.js";

/** Most tickets held at once; the oldest are evicted first past this. */
export const MAX_OUTSTANDING_TICKETS = 10_000;

/** What a ticket proves. */
export interface TicketGrant {
  userId: string;
  sessionId: string;
  expiresAt: Date;
}

/** A freshly issued ticket (the raw value goes to the client once). */
export interface IssuedTicket {
  ticket: string;
  expiresAt: Date;
}

/** In-memory ticket store, keyed by `hashToken(ticket)`. */
export class TicketStore {
  private readonly grants = new Map<string, TicketGrant>();

  /**
   * Issue a ticket for a session.
   *
   * @param now - Issue time (`app.clock`).
   */
  issue(userId: string, sessionId: string, now: Date): IssuedTicket {
    this.sweep(now);
    while (this.grants.size >= MAX_OUTSTANDING_TICKETS) {
      const oldest = this.grants.keys().next();
      if (oldest.done === true) break;
      this.grants.delete(oldest.value);
    }
    const ticket = createOpaqueToken();
    const expiresAt = new Date(now.getTime() + CHAT_TICKET_TTL_SECONDS * 1000);
    this.grants.set(hashToken(ticket), { userId, sessionId, expiresAt });
    return { ticket, expiresAt };
  }

  /**
   * Burn a ticket: it is removed on lookup whether or not it is still valid.
   *
   * @returns The grant, or `null` for an unknown, used or expired ticket.
   */
  consume(ticket: string, now: Date): TicketGrant | null {
    const key = hashToken(ticket);
    const grant = this.grants.get(key);
    if (grant === undefined) return null;
    this.grants.delete(key);
    return grant.expiresAt > now ? grant : null;
  }

  /** Drop every unused ticket of a session (logout, revocation). */
  revokeSession(sessionId: string): void {
    for (const [key, grant] of this.grants) {
      if (grant.sessionId === sessionId) this.grants.delete(key);
    }
  }

  /**
   * Drop every unused ticket of a user (disable).
   *
   * @returns The session ids those tickets were bound to.
   */
  revokeUser(userId: string): Set<string> {
    const sessionIds = new Set<string>();
    for (const [key, grant] of this.grants) {
      if (grant.userId === userId) {
        sessionIds.add(grant.sessionId);
        this.grants.delete(key);
      }
    }
    return sessionIds;
  }

  /**
   * Remove expired tickets.
   *
   * @returns How many were removed.
   */
  sweep(now: Date): number {
    let removed = 0;
    for (const [key, grant] of this.grants) {
      if (grant.expiresAt <= now) {
        this.grants.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** Outstanding tickets (tests). */
  get size(): number {
    return this.grants.size;
  }
}
