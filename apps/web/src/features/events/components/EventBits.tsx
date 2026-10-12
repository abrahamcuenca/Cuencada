/**
 * Small building blocks shared by the event pages (WP-5.4): the 16:9 cover
 * (or its gradient placeholder), the status badges and the 404 screen.
 */
import type { EventSummary } from "@cuencada/types";
import { type ReactNode, useState } from "react";
import { Badge } from "../../../shared/ui/Badge";
import { Button } from "../../../shared/ui/Button";
import { cx } from "../../../shared/ui/cx";
import { EmptyState } from "../../../shared/ui/EmptyState";
import styles from "../events.module.css";
import { EVENT_NOT_FOUND_TEXT, EVENT_NOT_FOUND_TITLE, eventBadges } from "../lib/format";

/** Props for {@link EventCover}. */
export interface EventCoverProps {
  /** Presigned cover URL (640 px in lists, 1280 px on the page), or `null`. */
  url: string | null;
  /** `card` in lists, `hero` on the event page. */
  variant?: "card" | "hero";
  /** An expired presigned URL: ask the owner to refetch. */
  onError?: () => void;
  className?: string | undefined;
}

/** Cover widths per variant (the derivative the server sent), for the `width`/`height` attributes. */
const COVER_SIZE = { card: { width: 640, height: 360 }, hero: { width: 1280, height: 720 } } as const;

/**
 * A 16:9 cover, decorative (the title is next to it). Without a cover, or
 * when it fails to load, a festive gradient with 🎉 holds the same box, so
 * nothing shifts.
 */
export function EventCover({ url, variant = "card", onError, className }: EventCoverProps): ReactNode {
  const [failed, setFailed] = useState<string | null>(null);
  const showImage = url !== null && failed !== url;
  const size = COVER_SIZE[variant];
  return (
    <div className={cx(styles.cover, variant === "hero" && styles.coverHero, className)}>
      {showImage ? (
        <img
          src={url}
          alt=""
          width={size.width}
          height={size.height}
          loading={variant === "hero" ? "eager" : "lazy"}
          decoding="async"
          className={styles.coverImage}
          onError={() => {
            setFailed(url);
            onError?.();
          }}
        />
      ) : (
        <span aria-hidden="true" className={styles.coverPlaceholder}>
          🎉
        </span>
      )}
    </div>
  );
}

/** "Borrador", "Oculto", "Solo participantes", "Organizas" / "Participas". */
export function EventBadges({ event }: { event: Pick<EventSummary, "status" | "visibility" | "viewerRole"> }): ReactNode {
  const badges = eventBadges(event);
  if (badges.length === 0) return null;
  return (
    <ul className={styles.badges} aria-label="Estado del evento">
      {badges.map((badge) => (
        <li key={badge.label}>
          <Badge tone={badge.tone}>{badge.label}</Badge>
        </li>
      ))}
    </ul>
  );
}

/**
 * "No encontramos ese evento" [SEC]: the same screen for a missing event, an
 * event the member cannot see (404 `EVENT_NOT_FOUND`) and a malformed
 * address, so the page never hints that an event exists.
 */
export function EventNotFound(): ReactNode {
  return (
    <div className={cx("cu-container", styles.page)}>
      <EmptyState
        icon="🔍"
        headingLevel={1}
        title={EVENT_NOT_FOUND_TITLE}
        description={EVENT_NOT_FOUND_TEXT}
        action={<Button to="/eventos">Ver eventos</Button>}
      />
    </div>
  );
}
