/**
 * Home's "Baúl de recuerdos" strip (WP-6.3, members): up to three published
 * boxes and a link to `/recuerdos`. Lazy (its own chunk, loaded only for
 * members) and silent: nothing renders while loading, on an error, or when
 * there is no published box.
 */
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useListMemoriesQuery } from "../api";
import { MEMORY_BOX_NAME } from "../lib/format";
import styles from "../memories.module.css";
import { MemoryCard } from "./MemoryCard";

/** Boxes shown on Home. */
export const HOME_MEMORIES_COUNT = 3;

/** The strip. Render only for members (the API refuses anyone else). */
export function HomeMemories(): ReactNode {
  const { data, refetch } = useListMemoriesQuery();
  const boxes = data?.items.slice(0, HOME_MEMORIES_COUNT) ?? [];
  if (boxes.length === 0) return null;
  return (
    <section className={`cu-container ${styles.strip}`} aria-labelledby="baul-recuerdos-titulo">
      <div className={styles.stripHeader}>
        <h2 id="baul-recuerdos-titulo" className={styles.stripTitle}>
          <span aria-hidden="true">🗃️ </span>
          {MEMORY_BOX_NAME}
        </h2>
        <Link to="/recuerdos" className={styles.stripLink}>
          Ver todos
        </Link>
      </div>
      <ul className={styles.stripList}>
        {boxes.map((box) => (
          <li key={box.id}>
            <MemoryCard box={box} compact headingLevel={3} onMediaError={() => void refetch()} />
          </li>
        ))}
      </ul>
    </section>
  );
}
