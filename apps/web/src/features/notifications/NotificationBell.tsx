/**
 * The notifications bell (WP-6.1): beside the account menu in the header, at
 * every width (TopNav on desktop, the brand bar on phones). A link to
 * `/notificaciones` with a festive unread badge ("999+" cap).
 *
 * Requests happen only for a signed-in, verified member past any forced
 * password change (the same gate as the chat badge; the server decides).
 */
import { NOTIFICATION_UNREAD_COUNT_MAX } from "@cuencada/types";
import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAppSelector } from "../../app/hooks";
import { Badge } from "../../shared/ui/Badge";
import { cx } from "../../shared/ui/cx";
import { selectCanUseChat } from "../chat/unread";
import { NOTIFICATIONS_PATH, UNREAD_POLL_MS, useGetUnreadNotificationCountQuery } from "./api";
import styles from "./bell.module.css";

/** Accessible name of the bell. */
export const BELL_LABEL = "Notificaciones";

/**
 * @param count - Unread notifications.
 * @returns "1 notificación sin leer" / "3 notificaciones sin leer" / "999 o más…".
 */
export function unreadNotificationsLabel(count: number): string {
  if (count >= NOTIFICATION_UNREAD_COUNT_MAX) return `${NOTIFICATION_UNREAD_COUNT_MAX} o más notificaciones sin leer`;
  return count === 1 ? "1 notificación sin leer" : `${count} notificaciones sin leer`;
}

/**
 * @returns The unread count for the signed-in member (0 while it loads, on
 * errors, and for anyone who cannot use notifications).
 */
export function useUnreadNotificationCount(): number {
  const canUse = useAppSelector(selectCanUseChat);
  const { data } = useGetUnreadNotificationCountQuery(undefined, {
    skip: !canUse,
    pollingInterval: canUse ? UNREAD_POLL_MS : 0,
    skipPollingIfUnfocused: true
  });
  return canUse ? (data ?? 0) : 0;
}

/** The bell link; renders nothing for members who cannot use notifications yet. */
export function NotificationBell(): ReactNode {
  const canUse = useAppSelector(selectCanUseChat);
  const count = useUnreadNotificationCount();
  const { pathname } = useLocation();
  if (!canUse) return null;
  const current = pathname === NOTIFICATIONS_PATH;
  return (
    <Link
      to={NOTIFICATIONS_PATH}
      className={cx(styles.bell, current && styles.current)}
      aria-current={current ? "page" : undefined}
      aria-label={count > 0 ? `${BELL_LABEL}: ${unreadNotificationsLabel(count)}` : BELL_LABEL}
    >
      <span aria-hidden="true" className={styles.icon}>
        🔔
      </span>
      {count > 0 ? (
        <span aria-hidden="true" className={styles.badge}>
          <Badge tone="festive" shape="count" max={NOTIFICATION_UNREAD_COUNT_MAX}>
            {count}
          </Badge>
        </span>
      ) : null}
    </Link>
  );
}
