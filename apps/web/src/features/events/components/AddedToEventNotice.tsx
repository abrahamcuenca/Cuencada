/**
 * The "you were added to an event" notice (WP-5.4; ADR 0001 §7 consent,
 * WP-5.3 requirement 3): who added you, which event, "Ver evento" and a
 * one-tap "Salir".
 *
 * Behind a feature check: WP-5.2's contracts do not define the notice yet
 * (WP-5.3 creates it server-side). Until a contract exposes it,
 * {@link EVENT_NOTICES_AVAILABLE} is false and nothing mounts the card; it
 * is built and tested against the local shape below, to be swapped for the
 * contract type (and mounted on Home and `/eventos`) when it lands.
 */
import type { ReactNode } from "react";
import { Button } from "../../../shared/ui/Button";
import styles from "../events.module.css";
import { eventPath } from "../lib/format";

/** Feature check: flip (or replace with a contract/capability check) once WP-5.3 exposes the notices. */
export const EVENT_NOTICES_AVAILABLE = false;

/** What the card needs (local shape until the contract exists). */
export interface AddedToEventNoticeData {
  id: string;
  eventId: string;
  year: number;
  slug: string;
  title: string;
  /** `null` when the person who added you is not visible to you (or was deleted). */
  addedByName: string | null;
}

/** Props for {@link AddedToEventNotice}. */
export interface AddedToEventNoticeProps {
  notice: AddedToEventNoticeData;
  /** One-tap "Salir" (leaves the event). */
  onLeave: () => void;
  leaving: boolean;
  /** "Entendido": hides the notice. */
  onDismiss: () => void;
}

/**
 * @param notice - Who added the member to which event.
 * @returns "Rosa te agregó a «Viaje a la playa»." or "Te agregaron a «…»."
 */
export function addedToEventText(notice: Pick<AddedToEventNoticeData, "addedByName" | "title">): string {
  return notice.addedByName === null ? `Te agregaron a «${notice.title}».` : `${notice.addedByName} te agregó a «${notice.title}».`;
}

/** The notice card. */
export function AddedToEventNotice({ notice, onLeave, leaving, onDismiss }: AddedToEventNoticeProps): ReactNode {
  return (
    <section className={styles.notice} aria-label="Aviso de evento">
      <p className={styles.noticeText}>
        <span aria-hidden="true">🎉 </span>
        {addedToEventText(notice)} Puedes salir cuando quieras.
      </p>
      <div className={styles.inlineActions}>
        <Button to={eventPath(notice)} size="sm">
          Ver evento
        </Button>
        <Button variant="secondary" size="sm" loading={leaving} onClick={onLeave}>
          Salir
        </Button>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Entendido
        </Button>
      </div>
    </section>
  );
}
