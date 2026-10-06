import type { MyRsvp, MyRsvpResponse, PublicCuencada, RsvpStatus } from "@cuencada/types";
import { type FormEvent, type ReactNode, useRef, useState } from "react";
import { getApiErrorCode, getApiErrorMessage, isAbortError } from "../../../shared/api/errors";
import { formatDate } from "../../../shared/lib/dates";
import { Badge } from "../../../shared/ui/Badge";
import { Button } from "../../../shared/ui/Button";
import { Card } from "../../../shared/ui/Card";
import { Skeleton } from "../../../shared/ui/Skeleton";
import { useToast } from "../../../shared/ui/Toast";
import { useGetCuencadaMembersQuery, useGetCuencadaQuery } from "../../cuencadas/api";
import { useZonedToday } from "../../cuencadas/hooks/useZonedToday";
import { useGetMyRsvpQuery, useListAttendeesQuery, usePutMyRsvpMutation } from "../api";
import { useMember } from "../lib/members";
import {
  type DateWindow,
  draftFromRsvp,
  editionDateWindow,
  type HotelChoice,
  hotelChoices,
  isDeadlineDayOver,
  optimisticRsvp,
  type RsvpDraft,
  type RsvpFieldErrors,
  validateRsvpDraft
} from "../lib/rsvpForm";
import { RsvpForm } from "./RsvpForm";
import styles from "../rsvp.module.css";

/** Props for {@link RsvpCard}. */
export interface RsvpCardProps {
  /** Edition year. */
  year: number;
}

/**
 * The RSVP slot (`RsvpSlot`) on Home and `/cuencada/:year`.
 * - Visitors: nothing (the page already shows the lock card).
 * - Upcoming/active edition: the "¿Vas a la Cuencada?" card.
 * - Past edition: a "Fuiste a esta Cuencada" badge when the member attended.
 */
export function RsvpCard({ year }: RsvpCardProps): ReactNode {
  const member = useMember();
  const cuencada = useGetCuencadaQuery(year, { skip: member === null });
  if (member === null || cuencada.data === undefined) return null;
  if (cuencada.data.status === "past") return <AttendedBadge year={year} />;
  if (cuencada.data.status === "draft") return null;
  return <RsvpPanel cuencada={cuencada.data} />;
}

/** "Fuiste a esta Cuencada" for past editions the member attended. Silent otherwise. */
function AttendedBadge({ year }: { year: number }): ReactNode {
  const member = useMember();
  const attendees = useListAttendeesQuery(year, { skip: member === null });
  if (member === null || attendees.data === undefined) return null;
  if (!attendees.data.some((attendee) => attendee.isMe)) return null;
  return (
    <p className={styles.attendedBadge} data-slot="rsvp">
      <Badge tone="festive">🎉 Fuiste a esta Cuencada</Badge>
    </p>
  );
}

function RsvpPanel({ cuencada }: { cuencada: PublicCuencada }): ReactNode {
  const my = useGetMyRsvpQuery(cuencada.year);
  let body: ReactNode;
  if (my.data !== undefined) {
    body = <RsvpBody cuencada={cuencada} data={my.data} onClosed={() => void my.refetch()} />;
  } else if (my.error !== undefined) {
    body = isAbortError(my.error) ? null : (
      <div className={styles.stack}>
        <p>No pudimos cargar tu respuesta.</p>
        <Button variant="secondary" size="sm" onClick={() => void my.refetch()}>
          Reintentar
        </Button>
      </div>
    );
  } else {
    body = (
      <div aria-busy="true">
        <Skeleton lines={3} />
        <span className="visually-hidden">Cargando tu respuesta…</span>
      </div>
    );
  }
  return (
    <Card as="section" tone="default" padding="md" icon="✅" title="Confirmar asistencia" className={styles.card} data-slot="rsvp">
      {body}
    </Card>
  );
}

/** Formats the deadline day in the edition's timezone ("15 de agosto de 2026"); it lasts until the end of that day. */
function formatDeadline(deadline: string, timeZone: string): string {
  return formatDate(deadline, timeZone, { day: "numeric", month: "long", year: "numeric" });
}

/** Ends a sentence with a period, unless it already ends with one ("… 11:59 p.m."). */
function sentence(text: string): string {
  return text.endsWith(".") ? text : `${text}.`;
}

interface RsvpBodyProps {
  cuencada: PublicCuencada;
  data: MyRsvpResponse;
  /** Called on 409 `CONFLICT` (RSVP closed): reloads `editable` so the card locks. */
  onClosed: () => void;
}

function RsvpBody({ cuencada, data, onClosed }: RsvpBodyProps): ReactNode {
  const { year, timezone } = cuencada;
  const toast = useToast();
  const members = useGetCuencadaMembersQuery(year);
  const [put, putState] = usePutMyRsvpMutation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<RsvpDraft>(() => draftFromRsvp(data.rsvp));
  const [errors, setErrors] = useState<RsvpFieldErrors>({});
  const summaryRef = useRef<HTMLDivElement>(null);

  const hotelListLoaded = members.data !== undefined;
  const hotels = hotelChoices(members.data?.locations ?? [], data.rsvp?.hotelLocationId ?? null, hotelListLoaded);
  const hotelHint = !hotelListLoaded && members.error !== undefined ? "No pudimos cargar la lista de hoteles; conservamos el que ya elegiste." : undefined;
  const dateWindow: DateWindow = editionDateWindow(cuencada.startsAt, cuencada.endsAt, timezone);
  // Re-renders at local midnight, so the card locks when the deadline's day ends with the page open.
  const today = useZonedToday(timezone);
  const deadlinePassed = isDeadlineDayOver(data.deadline, today, timezone);
  const closed = !data.editable || deadlinePassed;

  if (closed) {
    return (
      <div className={styles.stack}>
        {data.rsvp ? <RsvpSummary rsvp={data.rsvp} hotels={hotels} timeZone={timezone} /> : null}
        <p className={styles.closed} role="note">
          <span aria-hidden="true">🔒 </span>
          {data.deadline
            ? `${sentence(`Las confirmaciones cerraron el ${formatDeadline(data.deadline, timezone)}`)} Escribe en el grupo de WhatsApp si cambiaron tus planes.`
            : "Las confirmaciones están cerradas. Escribe en el grupo de WhatsApp si cambiaron tus planes."}
        </p>
      </div>
    );
  }

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const result = validateRsvpDraft(
      draft,
      dateWindow,
      hotels.map((hotel) => hotel.id)
    );
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    setEditing(false);
    put({ year, body: result.body, optimistic: optimisticRsvp(result.body, cuencada.id, new Date()) })
      .unwrap()
      .then(() => {
        toast.show({
          message: result.body.status === "no" ? "Listo. Guardamos tu respuesta." : "¡Listo! Confirmaste tu asistencia.",
          tone: "success"
        });
        summaryRef.current?.focus();
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) return;
        setEditing(true);
        toast.show({ message: getApiErrorMessage(error), tone: "danger" });
        if (getApiErrorCode(error) === "CONFLICT") onClosed();
      });
  };

  const deadlineHint = data.deadline ? (
    <p className={styles.deadline}>{sentence(`Confirma a más tardar el ${formatDeadline(data.deadline, timezone)}`)}</p>
  ) : null;

  if (data.rsvp !== null && !editing) {
    return (
      <div className={styles.stack}>
        <div ref={summaryRef} tabIndex={-1} className={styles.summaryFocus}>
          <RsvpSummary rsvp={data.rsvp} hotels={hotels} timeZone={timezone} />
        </div>
        {deadlineHint}
        <Button
          variant="secondary"
          disabled={putState.isLoading}
          onClick={() => {
            setDraft(draftFromRsvp(data.rsvp));
            setErrors({});
            setEditing(true);
          }}
        >
          Cambiar respuesta
        </Button>
      </div>
    );
  }

  return (
    <div className={styles.stack}>
      {deadlineHint}
      <RsvpForm
        year={year}
        draft={draft}
        errors={errors}
        hotels={hotels}
        hotelHint={hotelHint}
        dateWindow={dateWindow}
        saving={putState.isLoading}
        onChange={setDraft}
        onSubmit={submit}
        onCancel={data.rsvp !== null ? () => setEditing(false) : undefined}
      />
    </div>
  );
}

const STATUS_HEADLINE: Record<RsvpStatus, string> = {
  yes: "✅ ¡Vas!",
  maybe: "🤔 Tal vez vas",
  no: "Te vamos a extrañar 💛"
};

function companions(count: number): string {
  if (count === 0) return "Solo tú";
  return `Tú + ${count} ${count === 1 ? "acompañante" : "acompañantes"}`;
}

/** Read-only view of a saved RSVP. */
function RsvpSummary({ rsvp, hotels, timeZone }: { rsvp: MyRsvp; hotels: readonly HotelChoice[]; timeZone: string }): ReactNode {
  const hotel = hotels.find((candidate) => candidate.id === rsvp.hotelLocationId);
  const dateOptions: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short" };
  const attending = rsvp.status !== "no";
  return (
    <div className={styles.summary}>
      <p className={styles.summaryHeadline}>
        {STATUS_HEADLINE[rsvp.status]}
        {attending ? <span className={styles.summaryGuests}> {companions(rsvp.guestCount)}</span> : null}
      </p>
      {attending && (rsvp.arrivalDate || rsvp.departureDate || hotel) ? (
        <dl className={styles.summaryList}>
          {rsvp.arrivalDate ? (
            <div>
              <dt>Llegada</dt>
              <dd>{formatDate(rsvp.arrivalDate, timeZone, dateOptions)}</dd>
            </div>
          ) : null}
          {rsvp.departureDate ? (
            <div>
              <dt>Salida</dt>
              <dd>{formatDate(rsvp.departureDate, timeZone, dateOptions)}</dd>
            </div>
          ) : null}
          {hotel ? (
            <div>
              <dt>Hotel</dt>
              <dd>{hotel.name}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      {rsvp.notes ? <p className={styles.summaryNotes}>“{rsvp.notes}”</p> : null}
    </div>
  );
}
