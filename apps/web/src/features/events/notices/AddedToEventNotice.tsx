/**
 * The "you were added to an event" notices (WP-5.4; ADR 0001 §7 consent,
 * WP-5.3 requirement 3): who added you, to which event, "Ver evento", a
 * one-tap "Salir" (when you may leave) and "Entendido".
 *
 * Isolated on purpose (`notices/`): WP-6 replaces it with a general
 * notifications bell. {@link EVENT_NOTICES_AVAILABLE} is the single switch.
 */
import type { ReactNode } from "react";
import { isAbortError } from "../../../shared/api/errors";
import { Button } from "../../../shared/ui/Button";
import { useToast } from "../../../shared/ui/Toast";
import { useLeaveEventMutation } from "../api";
import styles from "../events.module.css";
import { eventErrorMessage, eventPath } from "../lib/format";
import { useDismissEventNoticeMutation, useListEventNoticesQuery } from "./api";
import type { EventNotice } from "@cuencada/types";

/** Switch for the notices (on since WP-5.3's contract; WP-6 replaces them). */
export const EVENT_NOTICES_AVAILABLE = true;

/**
 * @param notice - Who added the member, with which role, to which event.
 * @returns e.g. "Rosa te agregó a «Viaje a la playa»." or "Te agregaron como organizador a «…»."
 */
export function addedToEventText(notice: Pick<EventNotice, "addedByName" | "role" | "event">): string {
  const as = notice.role === "organizer" ? " como organizador" : "";
  const title = `«${notice.event.title}»`;
  return notice.addedByName === null ? `Te agregaron${as} a ${title}.` : `${notice.addedByName} te agregó${as} a ${title}.`;
}

/** Props for {@link AddedToEventNotice}. */
export interface AddedToEventNoticeProps {
  notice: EventNotice;
  /** One-tap "Salir" (leaves the event). */
  onLeave: () => void;
  leaving: boolean;
  /** "Entendido". */
  onDismiss: () => void;
}

/** One notice card. */
export function AddedToEventNotice({ notice, onLeave, leaving, onDismiss }: AddedToEventNoticeProps): ReactNode {
  return (
    <li className={styles.notice}>
      <p className={styles.noticeText}>
        <span aria-hidden="true">🎉 </span>
        {addedToEventText(notice)} {notice.canLeave ? "Puedes salir cuando quieras." : null}
      </p>
      <div className={styles.inlineActions}>
        <Button to={eventPath(notice.event)} size="sm">
          Ver evento
        </Button>
        {notice.canLeave ? (
          <Button variant="secondary" size="sm" loading={leaving} onClick={onLeave}>
            Salir
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Entendido
        </Button>
      </div>
    </li>
  );
}

/** Every undismissed notice (Home and `/eventos`). Silent while loading, on errors and when empty. */
export function EventNotices(): ReactNode {
  const toast = useToast();
  const { data } = useListEventNoticesQuery(undefined, { skip: !EVENT_NOTICES_AVAILABLE });
  const [dismiss] = useDismissEventNoticeMutation();
  const [leave, leaveState] = useLeaveEventMutation();
  if (!EVENT_NOTICES_AVAILABLE || data === undefined || data.length === 0) return null;

  const onLeave = (notice: EventNotice): void => {
    leave({ id: notice.event.id })
      .unwrap()
      .then(() => toast.show({ message: `Saliste de ${notice.event.title}.`, tone: "success" }))
      .catch((cause: unknown) => {
        if (!isAbortError(cause)) toast.show({ message: eventErrorMessage(cause), tone: "danger" });
      });
  };
  const onDismiss = (notice: EventNotice): void => {
    dismiss({ eventId: notice.event.id })
      .unwrap()
      .catch((cause: unknown) => {
        if (!isAbortError(cause)) toast.show({ message: eventErrorMessage(cause), tone: "danger" });
      });
  };

  return (
    <section aria-label="Avisos de eventos">
      <ul className={styles.notices}>
        {data.map((notice) => (
          <AddedToEventNotice
            key={notice.event.id}
            notice={notice}
            leaving={leaveState.isLoading && leaveState.originalArgs?.id === notice.event.id}
            onLeave={() => onLeave(notice)}
            onDismiss={() => onDismiss(notice)}
          />
        ))}
      </ul>
    </section>
  );
}
