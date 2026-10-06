/**
 * Invite helpers [SEC]: validity, list mapping, keyset cursors and sending.
 * Only token hashes are stored; the raw token exists in the emailed link (or
 * the one-time copy-link) only.
 */
import {
  type AdminInviteListItem,
  type InviteStatus,
  OPEN_INVITE_MAX_LIFETIME_MS,
  OPEN_INVITE_MAX_USES
} from "@cuencada/types";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { type invites, people } from "../../db/schema/index.js";
import type { DbOrTx } from "../../lib/audit.js";
import { AppError } from "../../lib/errors.js";
import { AppLinkPath, appLink, sendTemplate } from "../../lib/mailer/index.js";
import { sendWithRetry } from "../auth/mailQueue.js";

/** An `invites` row. */
export type InviteRow = typeof invites.$inferSelect;

/** Invite fields that decide its effective limits. */
type InviteLimitFields = Pick<InviteRow, "email" | "createdAt" | "expiresAt" | "maxUses">;

/**
 * Expiry actually enforced (WP-2.3b): an open invite lives at most
 * {@link OPEN_INVITE_MAX_LIFETIME_MS} (72 h) after creation, even when it was
 * created under the old 14-day limit. Email-bound invites keep `expiresAt`.
 *
 * @param invite - The row.
 */
export function effectiveInviteExpiresAt(invite: InviteLimitFields): Date {
  if (invite.email !== null) return invite.expiresAt;
  const cap = new Date(invite.createdAt.getTime() + OPEN_INVITE_MAX_LIFETIME_MS);
  return cap < invite.expiresAt ? cap : invite.expiresAt;
}

/**
 * Uses actually allowed (WP-2.3b): an open invite allows at most
 * {@link OPEN_INVITE_MAX_USES} (10), even when it was created under the old
 * limit of 20. Email-bound invites keep `maxUses` (always 1).
 *
 * @param invite - The row.
 */
export function effectiveInviteMaxUses(invite: Pick<InviteRow, "email" | "maxUses">): number {
  return invite.email === null ? Math.min(invite.maxUses, OPEN_INVITE_MAX_USES) : invite.maxUses;
}

/**
 * Whether an invite can still be accepted: pending, unexpired, uses left,
 * using the effective (clamped) limits for open invites.
 *
 * @param invite - The row.
 * @param now - Current time.
 */
export function isInviteUsable(
  invite: InviteLimitFields & Pick<InviteRow, "status" | "useCount">,
  now: Date
): boolean {
  return (
    invite.status === "pending" && effectiveInviteExpiresAt(invite) > now && invite.useCount < effectiveInviteMaxUses(invite)
  );
}

/**
 * Status as admins see it: a pending invite past its effective expiry reads `expired`.
 *
 * @param invite - The row.
 * @param now - Current time.
 */
export function effectiveInviteStatus(invite: InviteLimitFields & Pick<InviteRow, "status">, now: Date): InviteStatus {
  return invite.status === "pending" && effectiveInviteExpiresAt(invite) <= now ? "expired" : invite.status;
}

/**
 * Map a row (plus the creator's display name) to the admin list item.
 * Never includes the token hash. `maxUses` and `expiresAt` are the effective
 * (clamped) limits, so admins see what acceptance enforces.
 *
 * @param invite - The row.
 * @param createdByName - Creator's display name, if the creator still exists.
 * @param now - Current time (for the expired status).
 */
export function toAdminInviteListItem(
  invite: InviteRow,
  createdByName: string | null,
  now: Date
): AdminInviteListItem {
  return {
    id: invite.id,
    email: invite.email,
    role: invite.role,
    status: effectiveInviteStatus(invite, now),
    maxUses: effectiveInviteMaxUses(invite),
    useCount: invite.useCount,
    expiresAt: effectiveInviteExpiresAt(invite).toISOString(),
    createdAt: invite.createdAt.toISOString(),
    createdByName,
    personId: invite.personId,
    note: invite.note,
    lastSentAt: invite.lastSentAt === null ? null : invite.lastSentAt.toISOString()
  };
}

/** Keyset position in the admin list (newest first). */
export interface InviteCursor {
  createdAt: Date;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Encode a keyset cursor (opaque base64url; clients must not parse it).
 *
 * @param cursor - Last item's `createdAt` and `id`.
 */
export function encodeInviteCursor(cursor: InviteCursor): string {
  return Buffer.from(`${cursor.createdAt.toISOString()}|${cursor.id}`, "utf8").toString("base64url");
}

/**
 * Decode a cursor from the query string.
 *
 * @param value - Raw cursor.
 * @throws AppError `VALIDATION` (path `cursor`) when it is not one of ours.
 */
export function decodeInviteCursor(value: string): InviteCursor {
  const invalid = new AppError("VALIDATION", undefined, { details: [{ path: "cursor", message: "Cursor inválido." }] });
  const decoded = Buffer.from(value, "base64url").toString("utf8");
  const [iso, id, ...rest] = decoded.split("|");
  if (iso === undefined || id === undefined || rest.length > 0 || !UUID.test(id)) throw invalid;
  const createdAt = new Date(iso);
  if (Number.isNaN(createdAt.getTime())) throw invalid;
  return { createdAt, id };
}

/** What the invite email needs. */
export interface InviteEmailInput {
  inviteId: string;
  to: string;
  token: string;
  inviterName: string;
  inviteeName: string | null;
  expiresAt: Date;
  /** Distinguishes create from each resend in the idempotency key. */
  sentAt: Date;
}

/**
 * Send the invite email now (awaited, so the admin learns about failures),
 * retrying provider rate limits and server errors like the mail queue does.
 *
 * @param app - The app (mailer, config).
 * @param input - Recipient, raw token and names.
 * @throws AppError `SERVICE_UNAVAILABLE` when the provider rejects it.
 */
export async function sendInviteEmail(app: FastifyInstance, input: InviteEmailInput): Promise<void> {
  try {
    await sendWithRetry(() => sendTemplate(
      app,
      input.to,
      {
        kind: "invite",
        props: {
          inviterName: input.inviterName,
          ...(input.inviteeName === null ? {} : { inviteeName: input.inviteeName }),
          acceptUrl: appLink(app.config, AppLinkPath.Invite, input.token),
          expiresAt: input.expiresAt
        }
      },
      // Derived from the operation (invite id + send time), never from the token.
      { idempotencyKey: `invite:${input.inviteId}:${input.sentAt.getTime()}` }
    ), new AbortController().signal);
  } catch (error) {
    throw new AppError("SERVICE_UNAVAILABLE", "No pudimos enviar el correo de invitación. Intenta reenviarla.", {
      cause: error
    });
  }
}

/**
 * Full name of a family-tree person, for greetings and suggested names.
 *
 * @param db - Client or transaction.
 * @param personId - The person, or `null`.
 */
export async function personName(db: DbOrTx, personId: string | null): Promise<string | null> {
  if (personId === null) return null;
  const [row] = await db.select({ fullName: people.fullName }).from(people).where(eq(people.id, personId)).limit(1);
  return row?.fullName ?? null;
}
