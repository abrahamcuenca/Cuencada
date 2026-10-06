import type { AdminCuencada, AdminRsvpRow, RsvpStatus } from "@cuencada/types";
import { type ReactNode, useState } from "react";
import { isAbortError } from "../../../shared/api/errors";
import { formatDate } from "../../../shared/lib/dates";
import { Badge, type BadgeTone } from "../../../shared/ui/Badge";
import { Button } from "../../../shared/ui/Button";
import { Field } from "../../../shared/ui/Field";
import { Select } from "../../../shared/ui/Select";
import { Skeleton } from "../../../shared/ui/Skeleton";
import { TextInput } from "../../../shared/ui/TextInput";
import { useGetRsvpSummaryQuery, useListAdminRsvpsQuery } from "../api";
import { matchesSearch } from "./attendanceModel";
import styles from "./admin.module.css";

type StatusFilter = RsvpStatus | "all";

const STATUS_LABEL: Record<RsvpStatus, string> = { yes: "Sí", maybe: "Tal vez", no: "No" };
const STATUS_TONE: Record<RsvpStatus, BadgeTone> = { yes: "success", maybe: "accent", no: "neutral" };
const FILTER_OPTIONS = [
  { value: "all", label: "Todas" },
  { value: "yes", label: "Sí" },
  { value: "maybe", label: "Tal vez" },
  { value: "no", label: "No" }
] as const;

function isStatusFilter(value: string): value is StatusFilter {
  return FILTER_OPTIONS.some((option) => option.value === value);
}

/** Props for {@link AdminRsvpList}. */
export interface AdminRsvpListProps {
  cuencada: AdminCuencada;
}

/**
 * The RSVP list for admins: totals from the summary endpoint (aggregated in
 * SQL), then one card per answer, filterable by status and name/email.
 * Contains PII; admin only.
 */
export function AdminRsvpList({ cuencada }: AdminRsvpListProps): ReactNode {
  const rows = useListAdminRsvpsQuery(cuencada.id);
  const summary = useGetRsvpSummaryQuery(cuencada.year);
  const [status, setStatus] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");

  if (rows.data === undefined) {
    if (rows.error !== undefined && !isAbortError(rows.error)) {
      return (
        <div className={styles.panel}>
          <p className={styles.formError}>No pudimos cargar las confirmaciones.</p>
          <Button variant="secondary" onClick={() => void rows.refetch()}>
            Reintentar
          </Button>
        </div>
      );
    }
    return <Skeleton shape="block" height="12rem" />;
  }

  const visible = rows.data.filter(
    (row) => (status === "all" || row.status === status) && (matchesSearch(row.displayName, search) || matchesSearch(row.email, search))
  );

  return (
    <div className={styles.panel}>
      {summary.data ? (
        <dl className={styles.totals} aria-label="Totales">
          <div>
            <dt>Sí</dt>
            <dd>{summary.data.yes}</dd>
          </div>
          <div>
            <dt>Tal vez</dt>
            <dd>{summary.data.maybe}</dd>
          </div>
          <div>
            <dt>No</dt>
            <dd>{summary.data.no}</dd>
          </div>
          <div>
            <dt>Personas esperadas</dt>
            <dd>{summary.data.expectedPeople}</dd>
          </div>
        </dl>
      ) : null}
      {summary.data && summary.data.byHotel.length > 0 ? (
        <p className={styles.muted}>
          {summary.data.byHotel.map((hotel) => `${hotel.name}: ${hotel.people}`).join(" · ")}
        </p>
      ) : null}

      <div className={styles.filters}>
        <Field label="Respuesta">
          {(control) => (
            <Select
              {...control}
              options={FILTER_OPTIONS}
              value={status}
              onChange={(event) => {
                if (isStatusFilter(event.target.value)) setStatus(event.target.value);
              }}
            />
          )}
        </Field>
        <Field label="Buscar">
          {(control) => (
            <TextInput
              {...control}
              type="search"
              inputMode="search"
              autoComplete="off"
              placeholder="Nombre o correo"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          )}
        </Field>
      </div>

      <p className={styles.muted} aria-live="polite">
        {visible.length} de {rows.data.length} {rows.data.length === 1 ? "respuesta" : "respuestas"}
      </p>
      {visible.length === 0 ? (
        <p className={styles.muted}>{rows.data.length === 0 ? "Todavía nadie ha respondido." : "Ninguna respuesta coincide con el filtro."}</p>
      ) : (
        <ul className={styles.rsvpList} aria-label="Respuestas">
          {visible.map((row) => (
            <RsvpRowCard key={row.userId} row={row} timeZone={cuencada.timezone} />
          ))}
        </ul>
      )}
    </div>
  );
}

function RsvpRowCard({ row, timeZone }: { row: AdminRsvpRow; timeZone: string }): ReactNode {
  const dateOptions: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
  const stay = [row.arrivalDate, row.departureDate].map((date) => (date ? formatDate(date, timeZone, dateOptions) : "?")).join(" → ");
  return (
    <li className={styles.rsvpCard}>
      <div className={styles.rsvpHead}>
        <span className={styles.rsvpName}>{row.displayName}</span>
        <Badge tone={STATUS_TONE[row.status]}>{STATUS_LABEL[row.status]}</Badge>
      </div>
      <span className={styles.rsvpEmail}>{row.email}</span>
      {row.status !== "no" ? (
        <p className={styles.rsvpMeta}>
          {row.guestCount > 0 ? `+${row.guestCount} ${row.guestCount === 1 ? "acompañante" : "acompañantes"}` : "Sin acompañantes"}
          {row.arrivalDate || row.departureDate ? ` · ${stay}` : ""}
          {row.hotelName ? ` · ${row.hotelName}` : ""}
        </p>
      ) : null}
      {row.notes ? <p className={styles.rsvpNotes}>“{row.notes}”</p> : null}
    </li>
  );
}
