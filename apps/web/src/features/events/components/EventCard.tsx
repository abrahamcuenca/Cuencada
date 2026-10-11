import type { EventSummary } from "@cuencada/types";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { cx } from "../../../shared/ui/cx";
import styles from "../events.module.css";
import { eventPath, formatCardDates, participantCountLabel } from "../lib/format";
import { EventBadges, EventCover } from "./EventBits";

/** Props for {@link EventCard}. */
export interface EventCardProps {
  event: EventSummary;
  /** `compact`: Home's strip (no summary). */
  compact?: boolean;
  /** Heading level of the title inside its list. */
  headingLevel?: 2 | 3;
  /** A cover URL expired: refetch the list. */
  onMediaError?: () => void;
}

/**
 * One event in a list: the 16:9 cover, badges, title (the link, stretched
 * over the whole card so the card is one tap target), dates or "Por
 * anunciar", the place, the summary and the participant count.
 */
export function EventCard({ event, compact = false, headingLevel = 2, onMediaError }: EventCardProps): ReactNode {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <article className={cx(styles.card, compact && styles.cardCompact)}>
      <EventCover url={event.coverUrl} {...(onMediaError === undefined ? {} : { onError: onMediaError })} />
      <div className={styles.cardBody}>
        <EventBadges event={event} />
        <Heading className={styles.cardTitle}>
          <Link to={eventPath(event)} className={styles.cardLink}>
            {event.title}
          </Link>
        </Heading>
        <p className={styles.cardMeta}>
          <span aria-hidden="true">📅 </span>
          {formatCardDates(event)}
        </p>
        {event.locationText !== null ? (
          <p className={styles.cardMeta}>
            <span aria-hidden="true">📍 </span>
            {event.locationText}
          </p>
        ) : null}
        {!compact && event.summary !== null ? <p className={styles.cardSummary}>{event.summary}</p> : null}
        <p className={styles.cardCount}>
          <span aria-hidden="true">👥 </span>
          {participantCountLabel(event.participantCount)}
        </p>
      </div>
    </article>
  );
}
