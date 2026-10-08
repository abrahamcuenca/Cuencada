import type { PersonDetails } from "@cuencada/types";
import type { ReactNode } from "react";
import { ContactList } from "../../directory/components/ContactList";
import styles from "../family.module.css";

const LONG_DATE = new Intl.DateTimeFormat("es-MX", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/**
 * @param date - `YYYY-MM-DD` (a calendar date, no time zone).
 * @returns e.g. "4 de marzo de 1950".
 */
export function formatPersonDate(date: string): string {
  return LONG_DATE.format(new Date(`${date}T00:00:00Z`));
}

/** "4 de marzo de 1950", or just "1950", or `null`. */
function dateOrYear(date: string | null, year: number | null): string | null {
  if (date !== null) return formatPersonDate(date);
  return year === null ? null : String(year);
}

/** Rows of the "Detalles" list (label, value), only those with a value. */
export function detailRows(person: PersonDetails): Array<[string, string]> {
  const rows: Array<[string, string | null]> = [
    ["Nacimiento", dateOrYear(person.birthDate, person.birthYear)],
    ["Lugar de nacimiento", person.birthplace],
    ["Fallecimiento", person.deceased ? dateOrYear(person.deathDate, person.deathYear) : null]
  ];
  return rows.filter((row): row is [string, string] => row[1] !== null);
}

/** Props for {@link PersonDetailsSection}. */
export interface PersonDetailsSectionProps {
  person: PersonDetails;
  /** "Editar" / "Eliminar" buttons, shown inside the panel. */
  actions?: ReactNode;
  /** WP-4.3: the tree-photo controls (`PersonPhotoEditor`), under the photo slot. */
  photoEditor?: ReactNode;
}

/**
 * The "Detalles" accordion under the focus card: dates, birthplace, bio, and
 * the slots for the tree photo (WP-4.3) and contacts (WP-4.4), each rendered
 * only when present. The server already applied the privacy rules (living
 * people's dates only for their circle), so missing values simply don't show.
 */
export function PersonDetailsSection({ person, actions, photoEditor }: PersonDetailsSectionProps): ReactNode {
  const rows = detailRows(person);
  const hasPhoto = person.photoUrl !== null && person.photoSource === "person";
  const empty = rows.length === 0 && person.bio === null && !hasPhoto && person.contacts.length === 0;
  return (
    <details className={styles.details}>
      <summary className={styles.detailsSummary}>Detalles</summary>
      <div className={styles.detailsBody}>
        {hasPhoto && person.photoUrl !== null ? (
          <img className={styles.detailsPhoto} src={person.photoUrl} alt={`Foto de ${person.fullName}`} loading="lazy" decoding="async" />
        ) : null}
        {photoEditor ?? null}
        {rows.length > 0 ? (
          <dl className={styles.detailsList}>
            {rows.map(([label, value]) => (
              <div key={label} className={styles.detailsRow}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {person.bio !== null ? <p className={styles.detailsBio}>{person.bio}</p> : null}
        <ContactList contacts={person.contacts} ownerName={person.fullName} />
        {empty ? <p className={styles.empty}>Aún no hay más datos de {person.fullName}.</p> : null}
        {actions ? <div className={styles.detailsActions}>{actions}</div> : null}
      </div>
    </details>
  );
}
