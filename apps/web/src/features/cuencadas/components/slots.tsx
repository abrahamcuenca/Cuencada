/**
 * Placeholders that other tracks replace with their real components:
 * - `RsvpSlot` → T3 RSVP card ("¿Vas a la Cuencada?")
 * - `AttendeesSlot` → T3 attendee circles ("¿Quién va?")
 * - `GalleryPreviewSlot` → T4 gallery preview ("Álbum vivo")
 *
 * Keep the names and props stable: T3/T4 swap the body of each function and
 * the pages do not change. Each renders a `data-slot` hook for tests.
 */
import type { ReactNode } from "react";
import { Button } from "../../../shared/ui/Button";
import { Card } from "../../../shared/ui/Card";
import styles from "./content.module.css";

/** Props shared by every slot. */
export interface CuencadaSlotProps {
  /** Edition year (`/cuencada/:year`). */
  year: number;
}

/** RSVP card (T3). Placeholder until T3 lands. */
export function RsvpSlot({ year }: CuencadaSlotProps): ReactNode {
  return (
    <Card tone="sunken" padding="sm" className={styles.slot} data-slot="rsvp" icon="✅" title="Confirmar asistencia">
      <p>Muy pronto podrás confirmar tu asistencia a la Cuencada {year} desde aquí.</p>
    </Card>
  );
}

/** Attendee circles (T3). Placeholder until T3 lands. */
export function AttendeesSlot({ year }: CuencadaSlotProps): ReactNode {
  return (
    <Card tone="sunken" padding="sm" className={styles.slot} data-slot="attendees" icon="👨‍👩‍👧‍👦" title="¿Quién va?">
      <p>Aquí verás a la familia que asistirá a la Cuencada {year}.</p>
    </Card>
  );
}

/** Gallery preview (T4). Placeholder until T4 lands. */
export function GalleryPreviewSlot({ year }: CuencadaSlotProps): ReactNode {
  return (
    <Card tone="sunken" padding="sm" className={styles.slot} data-slot="gallery" icon="📸" title="Álbum vivo">
      <p>Fotos y videos de la familia, privados para quienes tienen cuenta.</p>
      <Button to={`/galeria/${year}`} variant="secondary" size="sm">
        Ver álbum {year}
      </Button>
    </Card>
  );
}
