/**
 * Participants on the event page (WP-5.4): the first 8 avatars with names,
 * then "+N" opening the full list. Managers get the {@link ParticipantsSheet}:
 * add members from the directory (listed members only, with consent copy),
 * promote/demote and remove, with the last-organizer guard.
 */
import type { DirectoryEntry, EventDetail, EventParticipant } from "@cuencada/types";
import { type ReactNode, useId, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { isAbortError, isFetchBaseQueryError } from "../../../shared/api/errors";
import { AvatarCircle } from "../../../shared/ui/AvatarCircle";
import { Badge } from "../../../shared/ui/Badge";
import { Button } from "../../../shared/ui/Button";
import { Checkbox } from "../../../shared/ui/Checkbox";
import { Dialog } from "../../../shared/ui/Dialog";
import { Field } from "../../../shared/ui/Field";
import { Skeleton } from "../../../shared/ui/Skeleton";
import { TextInput } from "../../../shared/ui/TextInput";
import { useToast } from "../../../shared/ui/Toast";
import { useListDirectoryInfiniteQuery } from "../../directory/api";
import { useDebouncedValue } from "../../directory/lib/useDebouncedValue";
import { useAddParticipantsMutation, useRemoveParticipantMutation, useUpdateParticipantMutation } from "../api";
import styles from "../events.module.css";
import { ADD_PARTICIPANTS_FAILED, eventErrorMessage, PARTICIPANT_CONSENT_NOTE } from "../lib/format";

/** Participants shown before "+N". */
export const PARTICIPANTS_PREVIEW = 8;
/** Shown next to the last organizer's controls. */
export const LAST_ORGANIZER_GUARD = "Es la única persona que organiza: nombra antes a otra.";

function personKey(participant: EventParticipant, index: number): string {
  return participant.userId ?? `p-${index}`;
}

function ParticipantRow({ participant }: { participant: EventParticipant }): ReactNode {
  return (
    <li className={styles.person}>
      <AvatarCircle name={participant.displayName} src={participant.avatarUrl ?? undefined} size="sm" decorative />
      <span className={styles.personName}>
        {participant.displayName}
        {participant.isSelf ? <span className={styles.muted}> (tú)</span> : null}
      </span>
      {participant.role === "organizer" ? <Badge tone="brand">Organiza</Badge> : null}
    </li>
  );
}

/** The participants block of the "Detalles" tab. */
export function ParticipantsSection({ event }: { event: EventDetail }): ReactNode {
  const [showAll, setShowAll] = useState(false);
  const visible = event.participants.slice(0, PARTICIPANTS_PREVIEW);
  const hidden = Math.max(0, event.participantCount - visible.length);
  return (
    <section className={styles.block} aria-labelledby="evento-participantes">
      <h2 id="evento-participantes" className={styles.blockTitle}>
        Participantes <span className={styles.muted}>({event.participantCount})</span>
      </h2>
      {visible.length === 0 ? (
        <p className={styles.muted}>Todavía nadie se ha apuntado.</p>
      ) : (
        <ul className={styles.people}>
          {visible.map((participant, index) => (
            <ParticipantRow key={personKey(participant, index)} participant={participant} />
          ))}
        </ul>
      )}
      {hidden > 0 ? (
        <Button variant="ghost" size="sm" onClick={() => setShowAll(true)} aria-label={`Ver a todas las personas (${hidden} más)`}>
          +{hidden}
        </Button>
      ) : null}
      <Dialog open={showAll} onClose={() => setShowAll(false)} title={`Participantes (${event.participantCount})`}>
        <ul className={styles.people}>
          {event.participants.map((participant, index) => (
            <ParticipantRow key={personKey(participant, index)} participant={participant} />
          ))}
        </ul>
      </Dialog>
    </section>
  );
}

/** Props for {@link ParticipantsSheet}. */
export interface ParticipantsSheetProps {
  event: EventDetail;
  open: boolean;
  onClose: () => void;
}

/** Managers: add from the directory, change roles, remove. */
export function ParticipantsSheet({ event, open, onClose }: ParticipantsSheetProps): ReactNode {
  return (
    <Dialog open={open} onClose={onClose} title="Personas del evento" className={styles.sheet}>
      {open ? (
        <>
          <AddParticipants event={event} />
          <ManageList event={event} />
        </>
      ) : null}
    </Dialog>
  );
}

function AddParticipants({ event }: { event: EventDetail }): ReactNode {
  const toast = useToast();
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ReadonlyMap<string, string>>(new Map());
  const q = useDebouncedValue(query.trim(), 300);
  // The directory lists only listed, active members: the same set the server lets organizers add [SEC].
  const directory = useListDirectoryInfiniteQuery(q === "" ? {} : { q });
  const [add, { isLoading: adding }] = useAddParticipantsMutation();
  const already = useMemo(() => new Set(event.participants.flatMap((p) => (p.userId === undefined ? [] : [p.userId]))), [event.participants]);
  const candidates = (directory.data?.pages.flatMap((page) => page.items) ?? []).filter((entry) => !already.has(entry.userId));

  const toggle = (entry: DirectoryEntry, on: boolean): void => {
    setSelected((current) => {
      const next = new Map(current);
      if (on) next.set(entry.userId, entry.displayName);
      else next.delete(entry.userId);
      return next;
    });
  };

  const onAdd = (): void => {
    if (selected.size === 0 || adding) return;
    add({ id: event.id, body: { userIds: [...selected.keys()] } })
      .unwrap()
      .then(() => {
        toast.show({ message: selected.size === 1 ? "Agregaste a 1 persona." : `Agregaste a ${selected.size} personas.`, tone: "success" });
        setSelected(new Map());
      })
      .catch((cause: unknown) => {
        if (isAbortError(cause)) return;
        // [SEC] The server answers one generic 400 for any ineligible id (no oracle on hidden
        // accounts), so there is nothing per person to show: say it once, plainly.
        const generic = isFetchBaseQueryError(cause) && cause.status === 400;
        toast.show({ message: generic ? ADD_PARTICIPANTS_FAILED : eventErrorMessage(cause), tone: "danger" });
      });
  };

  return (
    <section className={styles.sheetSection} aria-labelledby={`${searchId}-title`}>
      <h3 id={`${searchId}-title`} className={styles.sheetTitle}>
        Agregar personas
      </h3>
      <Field label="Buscar en el directorio" hint="Solo aparecen quienes están en el directorio familiar.">
        {(p) => (
          <TextInput {...p} type="search" inputMode="search" autoComplete="off" enterKeyHint="search" value={query} onChange={(e) => setQuery(e.target.value)} />
        )}
      </Field>
      {directory.isLoading ? (
        <Skeleton shape="block" height="6rem" />
      ) : directory.isError ? (
        <p className={styles.fieldError} role="alert">
          No pudimos cargar el directorio. Inténtalo de nuevo.
        </p>
      ) : candidates.length === 0 ? (
        <p className={styles.muted}>{q === "" ? "Todas las personas del directorio ya participan." : "Nadie más coincide con esa búsqueda."}</p>
      ) : (
        <ul className={styles.pickList} aria-label="Personas del directorio">
          {candidates.map((entry) => (
            <li key={entry.userId} className={styles.pickRow}>
              <AvatarCircle name={entry.displayName} src={entry.avatarUrl ?? undefined} size="sm" decorative />
              <Checkbox
                label={entry.displayName}
                {...(entry.familyBranch === null ? {} : { hint: entry.familyBranch })}
                checked={selected.has(entry.userId)}
                onChange={(e) => toggle(entry, e.target.checked)}
                className={styles.pickCheck}
              />
            </li>
          ))}
        </ul>
      )}
      {directory.hasNextPage ? (
        <Button variant="ghost" size="sm" loading={directory.isFetchingNextPage} onClick={() => void directory.fetchNextPage()}>
          Cargar más
        </Button>
      ) : null}
      <p className={styles.consent}>{PARTICIPANT_CONSENT_NOTE}</p>
      <Button fullWidth disabled={selected.size === 0} loading={adding} onClick={onAdd}>
        {selected.size === 0 ? "Agregar" : `Agregar (${selected.size})`}
      </Button>
    </section>
  );
}

/**
 * True when a write about yourself answered 404: you removed or demoted
 * yourself out of an event you can no longer see (a participants-only event,
 * or a draft). That is "you left", not an error (WP-5.3).
 */
function leftByOwnChange(participant: EventParticipant, cause: unknown): boolean {
  return participant.isSelf && isFetchBaseQueryError(cause) && cause.status === 404;
}

function ManageList({ event }: { event: EventDetail }): ReactNode {
  const toast = useToast();
  const navigate = useNavigate();
  const [updateRole, roleState] = useUpdateParticipantMutation();
  const [remove, removeState] = useRemoveParticipantMutation();
  const [removing, setRemoving] = useState<EventParticipant | null>(null);
  const organizers = event.participants.filter((p) => p.role === "organizer").length;
  const busy = roleState.isLoading || removeState.isLoading;

  const fail = (cause: unknown, participant: EventParticipant): void => {
    if (isAbortError(cause)) return;
    if (leftByOwnChange(participant, cause)) {
      toast.show({ message: `Ya no participas en ${event.title}.`, tone: "info" });
      navigate("/eventos", { replace: true });
      return;
    }
    toast.show({ message: eventErrorMessage(cause), tone: "danger" });
  };

  const onRole = (participant: EventParticipant): void => {
    if (participant.userId === undefined || busy) return;
    const role = participant.role === "organizer" ? "participant" : "organizer";
    updateRole({ id: event.id, userId: participant.userId, role })
      .unwrap()
      .then(() => toast.show({ message: role === "organizer" ? `${participant.displayName} ahora organiza.` : `${participant.displayName} ya no organiza.`, tone: "success" }))
      .catch((cause: unknown) => fail(cause, participant));
  };

  const onRemove = (): void => {
    const target = removing;
    if (target?.userId === undefined || busy) return;
    remove({ id: event.id, userId: target.userId })
      .unwrap()
      .then(() => {
        setRemoving(null);
        toast.show({ message: `Quitaste a ${target.displayName} del evento.`, tone: "success" });
      })
      .catch((cause: unknown) => {
        setRemoving(null);
        fail(cause, target);
      });
  };

  return (
    <section className={styles.sheetSection} aria-labelledby="evento-gestionar-personas">
      <h3 id="evento-gestionar-personas" className={styles.sheetTitle}>
        Participan ({event.participantCount})
      </h3>
      <ul className={styles.manageList}>
        {event.participants.map((participant, index) => {
          const lastOrganizer = participant.role === "organizer" && organizers <= 1;
          return (
            <li key={personKey(participant, index)} className={styles.manageRow}>
              <div className={styles.manageWho}>
                <AvatarCircle name={participant.displayName} src={participant.avatarUrl ?? undefined} size="sm" decorative />
                <span className={styles.personName}>
                  {participant.displayName}
                  {participant.isSelf ? <span className={styles.muted}> (tú)</span> : null}
                </span>
                {participant.role === "organizer" ? <Badge tone="brand">Organiza</Badge> : null}
              </div>
              {participant.userId === undefined ? null : (
                <div className={styles.inlineActions}>
                  <Button variant="secondary" size="sm" disabled={lastOrganizer || busy} onClick={() => onRole(participant)}>
                    {participant.role === "organizer" ? "Quitar como organizador" : "Hacer organizador"}
                  </Button>
                  <Button variant="ghost" size="sm" disabled={lastOrganizer || busy} onClick={() => setRemoving(participant)}>
                    Quitar
                  </Button>
                </div>
              )}
              {lastOrganizer ? <p className={styles.muted}>{LAST_ORGANIZER_GUARD}</p> : null}
            </li>
          );
        })}
      </ul>
      <Dialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        role="alertdialog"
        closeOnBackdrop={false}
        title={`¿Quitar a ${removing?.displayName ?? ""}?`}
        description="Dejará de ver el chat y las fotos del evento."
        footer={
          <>
            <Button variant="danger" fullWidth loading={removeState.isLoading} onClick={onRemove}>
              Quitar del evento
            </Button>
            <Button variant="secondary" fullWidth onClick={() => setRemoving(null)}>
              Cancelar
            </Button>
          </>
        }
      />
    </section>
  );
}
