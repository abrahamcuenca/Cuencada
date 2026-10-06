import type { DailyMessage } from "@cuencada/types";
import type { ReactNode } from "react";
import { Card } from "../../../shared/ui/Card";
import { formatDate } from "../../../shared/lib/dates";
import styles from "./content.module.css";

/**
 * "💌 Mensaje del día" card (legacy `mensajes.txt`). Render it only for the
 * message that belongs to today in the Cuencada's timezone
 * (see `messageForToday`).
 */
export function DailyMessageCard({ message, timeZone }: { message: DailyMessage; timeZone: string }): ReactNode {
  return (
    <Card as="aside" tone="sunken" icon="💌" title="Mensaje del día" className={styles.dailyMessage} aria-label="Mensaje del día">
      <p className={styles.dailyMessageText}>{message.message}</p>
      <p className={styles.meta}>{formatDate(message.date, timeZone, { weekday: "long", day: "numeric", month: "long" })}</p>
    </Card>
  );
}
