/**
 * Home's "Próximos eventos" strip (WP-5.4, members): at most three upcoming
 * events and a link to `/eventos`. Lazy (its own chunk, loaded only for
 * members) and silent: nothing renders while loading, on an error, or when
 * there is no upcoming event.
 */
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useUpcomingEventsQuery } from "../api";
import styles from "../events.module.css";
import { EventCard } from "./EventCard";

/** The strip. Render only for members (the API refuses anyone else). */
export function UpcomingEventsStrip(): ReactNode {
  const { data, refetch } = useUpcomingEventsQuery();
  if (data === undefined || data.length === 0) return null;
  return (
    <section className={`cu-container ${styles.strip}`} aria-labelledby="proximos-eventos-titulo">
      <div className={styles.stripHeader}>
        <h2 id="proximos-eventos-titulo" className={styles.stripTitle}>
          <span aria-hidden="true">🎉 </span>
          Próximos eventos
        </h2>
        <Link to="/eventos" className={styles.stripLink}>
          Ver todos
        </Link>
      </div>
      <ul className={styles.stripList}>
        {data.map((event) => (
          <li key={event.id}>
            <EventCard event={event} compact headingLevel={3} onMediaError={() => void refetch()} />
          </li>
        ))}
      </ul>
    </section>
  );
}
