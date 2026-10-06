import type { Attendee, CurrentUser } from "@cuencada/types";
import { type ReactNode, useState } from "react";
import { isAbortError, isFetchBaseQueryError } from "../../../shared/api/errors";
import { AvatarCircle } from "../../../shared/ui/AvatarCircle";
import { AvatarStack } from "../../../shared/ui/AvatarStack";
import { Badge } from "../../../shared/ui/Badge";
import { Button } from "../../../shared/ui/Button";
import { Card } from "../../../shared/ui/Card";
import { Dialog } from "../../../shared/ui/Dialog";
import { Skeleton } from "../../../shared/ui/Skeleton";
import { useGetCuencadaQuery } from "../../cuencadas/api";
import { useListAttendeesQuery } from "../api";
import { attendeeKey, isMe, safeAvatarUrl, useMember } from "../lib/members";
import styles from "../rsvp.module.css";

/** Props for {@link AttendeesCircles}. */
export interface AttendeesCirclesProps {
  year: number;
}

/**
 * The attendee strip (`AttendeesSlot`): an `AvatarStack` with "+N"; tapping
 * it opens a Dialog (bottom sheet on phones) with every name.
 * Members only; a 403 (email not verified) gets its own message.
 */
export function AttendeesCircles({ year }: AttendeesCirclesProps): ReactNode {
  const member = useMember();
  const cuencada = useGetCuencadaQuery(year, { skip: member === null });
  const attendees = useListAttendeesQuery(year, { skip: member === null });
  if (member === null) return null;
  const isPast = cuencada.data?.status === "past";
  const title = isPast ? "¿Quién fue?" : "¿Quién va?";

  let body: ReactNode;
  if (attendees.data !== undefined) {
    body = <AttendeeStrip year={year} title={title} isPast={isPast} attendees={attendees.data} me={member} />;
  } else if (attendees.error !== undefined) {
    if (isAbortError(attendees.error)) return null;
    const forbidden = isFetchBaseQueryError(attendees.error) && attendees.error.status === 403;
    body = forbidden ? (
      <p className={styles.muted}>
        <span aria-hidden="true">✉️ </span>
        {member.emailVerified ? "No tienes acceso a la lista de asistentes." : "Verifica tu correo para ver quiénes asistieron."}
      </p>
    ) : (
      <div className={styles.stack}>
        <p className={styles.muted}>No pudimos cargar la lista de asistentes.</p>
        <Button variant="secondary" size="sm" onClick={() => void attendees.refetch()}>
          Reintentar
        </Button>
      </div>
    );
  } else {
    body = (
      <div aria-busy="true" className={styles.stripLoading}>
        <Skeleton shape="circle" width={48} height={48} />
        <Skeleton shape="circle" width={48} height={48} />
        <Skeleton shape="circle" width={48} height={48} />
        <span className="visually-hidden">Cargando asistentes…</span>
      </div>
    );
  }

  return (
    <Card as="section" padding="md" icon="👨‍👩‍👧‍👦" title={title} className={styles.card} data-slot="attendees">
      {body}
    </Card>
  );
}

/** Sorts names in Spanish order, with the current user first. */
function sortAttendees(list: readonly Attendee[], me: CurrentUser): Attendee[] {
  return [...list].sort((a, b) => {
    const meA = isMe(a, me) ? 0 : 1;
    const meB = isMe(b, me) ? 0 : 1;
    return meA - meB || a.displayName.localeCompare(b.displayName, "es-MX");
  });
}

function countLabel(attendees: readonly Attendee[], isPast: boolean): string {
  if (isPast) return `${attendees.length} ${attendees.length === 1 ? "asistente" : "asistentes"}`;
  const maybe = attendees.filter((attendee) => attendee.rsvpStatus === "maybe").length;
  const confirmed = attendees.length - maybe;
  const base = `${confirmed} ${confirmed === 1 ? "confirmado" : "confirmados"}`;
  return maybe > 0 ? `${base} · ${maybe} tal vez` : base;
}

interface AttendeeStripProps {
  year: number;
  title: string;
  isPast: boolean;
  attendees: readonly Attendee[];
  me: CurrentUser;
}

function AttendeeStrip({ year, title, isPast, attendees, me }: AttendeeStripProps): ReactNode {
  const [open, setOpen] = useState(false);
  if (attendees.length === 0) {
    return (
      <p className={styles.muted}>
        {isPast ? "No hay asistentes registrados para esta Cuencada." : "Todavía nadie ha confirmado. ¡Sé el primero!"}
      </p>
    );
  }
  const sorted = sortAttendees(attendees, me);
  const label = countLabel(attendees, isPast);
  return (
    <>
      <div className={styles.strip}>
        <AvatarStack
          people={sorted.map((attendee, index) => ({
            id: attendeeKey(attendee, index),
            name: attendee.displayName,
            src: safeAvatarUrl(attendee.avatarUrl)
          }))}
          label={label}
        />
        <button type="button" className={styles.stripButton} aria-haspopup="dialog" onClick={() => setOpen(true)}>
          {label}
          <span aria-hidden="true"> ›</span>
          <span className="visually-hidden">: ver la lista</span>
        </button>
      </div>
      <Dialog open={open} onClose={() => setOpen(false)} title={`${title} · Cuencada ${year}`} description={label}>
        <ul className={styles.attendeeList}>
          {sorted.map((attendee, index) => (
            <li key={attendeeKey(attendee, index)} className={styles.attendeeRow}>
              <AvatarCircle name={attendee.displayName} src={safeAvatarUrl(attendee.avatarUrl)} size="md" decorative highlight={isMe(attendee, me)} />
              <span className={styles.attendeeName}>{attendee.displayName}</span>
              {isMe(attendee, me) ? <Badge tone="accent">Tú</Badge> : null}
              {attendee.rsvpStatus === "maybe" ? <Badge tone="neutral">Tal vez</Badge> : null}
            </li>
          ))}
        </ul>
      </Dialog>
    </>
  );
}
