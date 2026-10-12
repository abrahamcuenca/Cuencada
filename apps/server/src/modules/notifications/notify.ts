/**
 * Notification writers (WP-6.0 stub; WP-6.1 implements). The signatures are
 * fixed so WP-6.2 (tags, comments, likes) and WP-6.4 (proposal resolution)
 * can call them before WP-6.1 lands. Rules: ADR 0001 §8.
 *
 * - {@link recordNotification} runs **inside the caller's transaction**, so a
 *   rolled-back action leaves no notification. It upserts on
 *   `(user_id, dedupe_key)` (`notificationDedupeKey`), never writes a
 *   self-notification (returns `null`), and trims the recipient to
 *   `NOTIFICATIONS_PER_USER_MAX` rows.
 * - {@link retractNotification} deletes one row (a removed or declined tag).
 * - {@link markNotificationSeen} marks one row seen (an approved tag request).
 * - {@link pushNotifications} runs **after the commit**: it rebuilds each
 *   notification through the feed's read model (visibility re-checked for the
 *   recipient) and sends the `notification` frame to that recipient's own
 *   sockets only. When the row is gone, invisible, or the read fails, it
 *   sends nothing; failures are logged with ids only and never fail the
 *   request.
 *
 * TODO(WP-6.1): implement all four; until then they are no-ops.
 */
import type { NotificationKind } from "@cuencada/types";
import type { FastifyInstance } from "fastify";
import type { Transaction } from "../../lib/audit.js";

/** The entity a notification points at: exactly the one its kind needs (DB CHECK `notifications_target_check`). */
export type NotificationTargetInput = { mediaId: string } | { eventId: string } | { proposalId: string };

/** What happened, to whom and by whom. */
export interface RecordNotificationInput {
  recipientUserId: string;
  /** The member who caused it; `null` for system actions. Equal to the recipient → nothing is written. */
  actorUserId: string | null;
  kind: NotificationKind;
  target: NotificationTargetInput;
}

/**
 * Writes (or coalesces into) the recipient's notification inside `tx`.
 *
 * @returns The notification id to pass to {@link pushNotifications} after the commit, or `null` when nothing was written.
 */
export async function recordNotification(tx: Transaction, input: RecordNotificationInput): Promise<string | null> {
  void tx;
  void input;
  return null;
}

/** Deletes the recipient's notification with `dedupeKey` inside `tx` (no-op when absent). */
export async function retractNotification(tx: Transaction, recipientUserId: string, dedupeKey: string): Promise<void> {
  void tx;
  void recipientUserId;
  void dedupeKey;
}

/**
 * Marks the recipient's notification with `dedupeKey` seen inside `tx` (no-op
 * when absent or already seen). Added by WP-6.2 with the signature WP-6.1
 * announced (approving a tag request marks it seen).
 */
export async function markNotificationSeen(tx: Transaction, userId: string, dedupeKey: string): Promise<void> {
  void tx;
  void userId;
  void dedupeKey;
}

/** After the commit: pushes each still-visible notification to its recipient's sockets (best effort). */
export async function pushNotifications(app: FastifyInstance, ids: readonly string[]): Promise<void> {
  void app;
  void ids;
}
