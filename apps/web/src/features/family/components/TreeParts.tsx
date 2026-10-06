import type { Person, PersonSummary } from "@cuencada/types";
import type { CSSProperties, ReactNode, Ref } from "react";
import { AvatarCircle } from "../../../shared/ui/AvatarCircle";
import { Badge } from "../../../shared/ui/Badge";
import { cx } from "../../../shared/ui/cx";
import styles from "../family.module.css";
import { type TrailEntry, displayName, lifeYears } from "../lib/tree";

/** Columns of a relatives band; the connector lines are drawn for the same grid. */
export const BAND_MAX_COLUMNS = 3;

/** Called when a person is tapped: the page navigates and re-centres on them. */
export type OpenPerson = (person: Pick<PersonSummary, "id" | "fullName">) => void;

/** Accessible name of a person button. */
export function personButtonLabel(person: Pick<PersonSummary, "fullName" | "deceased">): string {
  return `Ver a ${person.fullName}${person.deceased ? ", ya falleció" : ""}`;
}

/** Props for {@link PersonButton}. */
export interface PersonButtonProps {
  person: PersonSummary;
  onOpen: OpenPerson;
  className?: string | undefined;
}

/** A tappable relative (≥ 44px): avatar, name, a subtle "†" and "Sin cuenta". */
export function PersonButton({ person, onOpen, className }: PersonButtonProps): ReactNode {
  return (
    <button type="button" className={cx(styles.person, className)} aria-label={personButtonLabel(person)} onClick={() => onOpen(person)}>
      <AvatarCircle name={person.fullName} src={person.avatarUrl ?? undefined} size="md" decorative />
      <span className={styles.personName}>
        {displayName(person)}
        {person.deceased ? <span className={styles.dagger}> †</span> : null}
      </span>
      {person.userId === null ? <span className={styles.personMeta}>Sin cuenta</span> : null}
    </button>
  );
}

/** Which way a band's connector points. */
export type ConnectorDirection = "up" | "down";

/**
 * Decorative SVG lines between a band and the focus card. The band's grid has
 * `columns` equal columns, so each person's centre is at `(2i + 1) / 2n`.
 * `down`: a stem from the focus splits into ticks to each column (children).
 * `up`: ticks from each column join into a stem to the focus (parents).
 * `vector-effect` keeps a 2px stroke however the SVG is stretched.
 */
export function Connector({ columns, direction }: { columns: number; direction: ConnectorDirection }): ReactNode {
  const centres = Array.from({ length: Math.max(columns, 1) }, (_, index) => ((2 * index + 1) / (2 * Math.max(columns, 1))) * 100);
  const first = centres[0] ?? 50;
  const last = centres[centres.length - 1] ?? 50;
  const stem = direction === "down" ? "M50 0 V12" : "M50 12 V24";
  const ticks = centres.map((x) => (direction === "down" ? `M${x} 12 V24` : `M${x} 0 V12`)).join(" ");
  return (
    <svg className={styles.connector} viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <path d={`${stem} M${first} 12 H${last} ${ticks}`} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Props for {@link RelativeBand}. */
export interface RelativeBandProps {
  /** Group heading, e.g. "Padres". */
  title: string;
  people: PersonSummary[];
  emptyText: string;
  onOpen: OpenPerson;
  /** Draw connector lines towards the focus card. */
  connector?: ConnectorDirection | undefined;
  headingId: string;
  className?: string | undefined;
}

/**
 * A labelled list of relatives (parents, partners, children, grandparents…),
 * laid out in up to {@link BAND_MAX_COLUMNS} columns with optional connector
 * lines. Screen readers get a heading plus a list of buttons; the lines are
 * `aria-hidden`.
 */
export function RelativeBand({ title, people, emptyText, onOpen, connector, headingId, className }: RelativeBandProps): ReactNode {
  const columns = Math.min(Math.max(people.length, 1), BAND_MAX_COLUMNS);
  const style = { "--band-columns": columns } as CSSProperties; // CSS custom property: CSSProperties has no index signature for `--*`.
  const lines = connector !== undefined && people.length > 0 ? <Connector columns={columns} direction={connector} /> : null;
  return (
    <section className={cx(styles.band, className)} aria-labelledby={headingId} style={style}>
      <h2 id={headingId} className={styles.bandTitle}>
        {title}
        {people.length > 1 ? <span className={styles.count}> ({people.length})</span> : null}
      </h2>
      {connector === "down" ? lines : null}
      {people.length === 0 ? (
        <p className={styles.empty}>{emptyText}</p>
      ) : (
        <ul className={styles.bandList}>
          {people.map((person) => (
            <li key={person.id}>
              <PersonButton person={person} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      )}
      {connector === "up" ? lines : null}
    </section>
  );
}

/** Props for {@link SiblingStrip}. */
export interface SiblingStripProps {
  people: PersonSummary[];
  onOpen: OpenPerson;
  headingId: string;
}

/** Siblings in a horizontally scrolling strip: it scrolls inside its own container, never the page. */
export function SiblingStrip({ people, onOpen, headingId }: SiblingStripProps): ReactNode {
  return (
    <section className={styles.siblings} aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.bandTitle}>
        Hermanos
        {people.length > 0 ? <span className={styles.count}> ({people.length})</span> : null}
      </h2>
      {people.length === 0 ? (
        <p className={styles.empty}>Aún no hay hermanos registrados.</p>
      ) : (
        <ul className={styles.strip}>
          {people.map((person) => (
            <li key={person.id}>
              <PersonButton person={person} onOpen={onOpen} className={styles.stripPerson} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Props for {@link FocusCard}. */
export interface FocusCardProps {
  person: Person;
  headingRef: Ref<HTMLHeadingElement>;
  actions?: ReactNode;
}

/** The person in the centre: large avatar with a gold ring, name, years, branch. */
export function FocusCard({ person, headingRef, actions }: FocusCardProps): ReactNode {
  const years = lifeYears(person);
  return (
    <article className={styles.focus} aria-labelledby={`focus-${person.id}`}>
      <AvatarCircle name={person.fullName} src={person.avatarUrl ?? undefined} size="xl" highlight decorative />
      <h2 id={`focus-${person.id}`} ref={headingRef} tabIndex={-1} className={styles.focusName}>
        {person.fullName}
        {person.deceased ? (
          <>
            <span className={styles.dagger} aria-hidden="true">
              {" "}
              †
            </span>
            <span className="visually-hidden"> (ya falleció)</span>
          </>
        ) : null}
      </h2>
      {person.nickname ? <p className={styles.focusNickname}>«{person.nickname}»</p> : null}
      {years !== null || person.familyBranch !== null ? (
        <p className={styles.focusMeta}>
          {[years, person.familyBranch === null ? null : `Rama ${person.familyBranch}`].filter((part) => part !== null).join(" · ")}
        </p>
      ) : null}
      {person.userId === null ? <Badge tone="neutral">Sin cuenta</Badge> : null}
      {actions ? <div className={styles.focusActions}>{actions}</div> : null}
    </article>
  );
}

/** Props for {@link Breadcrumbs}. */
export interface BreadcrumbsProps {
  trail: TrailEntry[];
  current: TrailEntry;
  onOpen: (entry: TrailEntry) => void;
}

/** The last visited people, oldest first; the current focus is last and not a button. */
export function Breadcrumbs({ trail, current, onOpen }: BreadcrumbsProps): ReactNode {
  if (trail.length === 0) return null;
  return (
    <nav aria-label="Personas visitadas" className={styles.breadcrumbs}>
      <ol>
        {trail.map((entry) => (
          <li key={entry.id}>
            <button type="button" className={styles.crumb} onClick={() => onOpen(entry)}>
              {entry.name}
            </button>
            <span aria-hidden="true" className={styles.crumbSep}>
              ›
            </span>
          </li>
        ))}
        <li aria-current="page" className={styles.crumbCurrent}>
          {current.name}
        </li>
      </ol>
    </nav>
  );
}
