import type { ItineraryItem } from "@cuencada/types";
import type { ReactNode } from "react";
import { formatDate } from "../../../shared/lib/dates";
import { Badge } from "../../../shared/ui/Badge";
import { EmptyState } from "../../../shared/ui/EmptyState";
import { formatTimeRange, groupItineraryByDay } from "../lib/format";
import styles from "./content.module.css";

/** Props for {@link ProgramaTimeline}. */
export interface ProgramaTimelineProps {
  items: readonly ItineraryItem[];
  timeZone: string;
}

/**
 * The "Programa" timeline ported from the legacy `.timeline`: one card per day
 * with a date column (day number + weekday) and the day's activities, each
 * with its time range, description, price note and tags.
 *
 * Dates are calendar dates of the Cuencada and times are its wall-clock
 * times; both are formatted for its timezone, never the device's.
 */
export function ProgramaTimeline({ items, timeZone }: ProgramaTimelineProps): ReactNode {
  const days = groupItineraryByDay(items);
  if (days.length === 0) {
    return (
      <EmptyState
        icon="📅"
        headingLevel={3}
        title="El programa se publicará pronto"
        description="Estamos afinando los detalles de cada día."
      />
    );
  }

  return (
    <ol className={styles.timeline}>
      {days.map((day) => (
        <li key={day.date} className={styles.day}>
          <p className={styles.dayDate}>
            <span className={styles.dayNumber}>{formatDate(day.date, timeZone, { day: "numeric" })}</span>
            <span className={styles.dayWeekday}>{formatDate(day.date, timeZone, { weekday: "long" })}</span>
            <span className="visually-hidden">{formatDate(day.date, timeZone, { month: "long" })}</span>
          </p>
          <ul className={styles.dayItems}>
            {day.items.map((item) => (
              <ProgramaItem key={item.id} item={item} timeZone={timeZone} />
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}

function ProgramaItem({ item, timeZone }: { item: ItineraryItem; timeZone: string }): ReactNode {
  const timeRange = formatTimeRange(item, timeZone);
  return (
    <li className={styles.item}>
      <h3 className={styles.itemTitle}>{item.title}</h3>
      {timeRange || item.priceNote ? (
        <p className={styles.itemWhen}>
          {timeRange ? <span className={styles.itemTime}>{timeRange}</span> : null}
          {timeRange && item.priceNote ? " · " : null}
          {item.priceNote ? <strong className={styles.price}>{item.priceNote}</strong> : null}
        </p>
      ) : null}
      {item.description ? <p className={styles.itemDescription}>{item.description}</p> : null}
      <ProgramaTags item={item} />
    </li>
  );
}

/**
 * Tags under an activity. The contract has no free-form tags yet (see the
 * WP-T2-FE Requests), so they come from the fields it does have.
 */
function ProgramaTags({ item }: { item: ItineraryItem }): ReactNode {
  const tags: ReactNode[] = [];
  if (item.locationName) tags.push(<Badge key="location" tone="brand">📍 {item.locationName}</Badge>);
  if (item.startTime === null) tags.push(<Badge key="time" tone="neutral">🕒 Horario por confirmar</Badge>);
  if (item.visibility === "members") tags.push(<Badge key="members" tone="accent">🔒 Solo familia</Badge>);
  if (tags.length === 0) return null;
  return <div className={styles.tags}>{tags}</div>;
}
