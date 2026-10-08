import type { FamilyActivityItem, PersonRevision, PersonRevisionAction, PersonRevisionSnapshot } from "@cuencada/types";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Badge } from "../../../../shared/ui/Badge";
import { Button } from "../../../../shared/ui/Button";
import { cx } from "../../../../shared/ui/cx";
import { formatInstant } from "../../../admin/lib/format";
import styles from "../admin.module.css";

/** Spanish label per revision action (filters and list). */
export const REVISION_ACTION_LABELS: Record<PersonRevisionAction, string> = {
  "person.create": "Agregó a una persona",
  "person.update": "Editó datos",
  "person.delete": "Quitó a una persona",
  "relationship.create": "Agregó un parentesco",
  "relationship.delete": "Quitó un parentesco",
  "person.photo": "Cambió la foto",
  "person.revert": "Deshizo un cambio",
  "person.merge": "Fusionó a dos personas"
};

/** Field labels for "Cambió: …" on edits. */
const FIELD_LABELS: Record<string, string> = {
  fullName: "nombre",
  nickname: "apodo",
  familyBranch: "rama",
  birthYear: "año de nacimiento",
  deathYear: "año de fallecimiento",
  birthDate: "fecha de nacimiento",
  deathDate: "fecha de fallecimiento",
  birthplace: "lugar de nacimiento",
  bio: "biografía",
  deceased: "fallecimiento",
  userId: "cuenta vinculada"
};

const SKIP_KEYS: ReadonlySet<string> = new Set(["type", "personId", "id"]);

/**
 * @param before - Snapshot before the change.
 * @param after - Snapshot after it.
 * @returns Spanish names of the fields that differ (person snapshots only).
 */
export function changedFieldLabels(before: PersonRevisionSnapshot | null, after: PersonRevisionSnapshot | null): string[] {
  if (before?.type !== "person" || after?.type !== "person") return [];
  const labels: string[] = [];
  for (const [key, value] of Object.entries(after)) {
    if (SKIP_KEYS.has(key)) continue;
    const previous: unknown = (before as unknown as Record<string, unknown>)[key]; // same discriminant: identical key set
    if (previous !== value) labels.push(FIELD_LABELS[key] ?? key);
  }
  return labels;
}

/** "padre o madre" / "pareja" for a relationship snapshot. */
function kindLabel(snapshot: PersonRevisionSnapshot | null): string | null {
  if (snapshot?.type !== "relationship") return null;
  return snapshot.kind === "parent_of" ? "padres e hijos" : "pareja";
}

/** One-line description of what a revision did. */
export function revisionSummary(revision: PersonRevision): string {
  const label = REVISION_ACTION_LABELS[revision.action];
  if (revision.before?.type === "merge") {
    // WP-4.5: "Fusionó a dos personas: «duplicate» en «keep»".
    return `${label}: «${revision.before.duplicate.fullName}» en «${revision.before.keep.fullName}»`;
  }
  if (revision.action === "person.update") {
    const fields = changedFieldLabels(revision.before, revision.after);
    return fields.length === 0 ? label : `${label}: ${fields.join(", ")}`;
  }
  const kind = kindLabel(revision.after ?? revision.before);
  return kind === null ? label : `${label} (${kind})`;
}

/** Props for {@link RevisionList}. */
export interface RevisionListProps {
  items: ReadonlyArray<PersonRevision | FamilyActivityItem>;
  /** Show the person's name (activity feed) as a link to their admin page. */
  showPerson?: boolean;
  /** "Deshacer" handler; the button shows only on revertible rows. */
  onRevert: (revision: PersonRevision) => void;
  /** The row being reverted (its button shows a spinner). */
  revertingId: string | null;
  /** "Solo de …" filter on the actor's name (activity feed). */
  onFilterActor?: ((actor: { userId: string; displayName: string }) => void) | undefined;
}

function personName(item: PersonRevision | FamilyActivityItem): string | null {
  return "personName" in item ? item.personName : null;
}

/**
 * A list of family changes, newest first: what changed, who and when, a
 * "Deshecho" badge on undone rows and "Deshacer" on revertible ones.
 */
export function RevisionList({ items, showPerson = false, onRevert, revertingId, onFilterActor }: RevisionListProps): ReactNode {
  return (
    <ul className={styles.rows}>
      {items.map((item) => {
        const name = personName(item);
        const subjectId = item.personId;
        return (
          <li key={item.id} className={cx(styles.row, styles.revisionRow)}>
            <div className={styles.rowMain}>
              {showPerson && name !== null ? (
                subjectId === null ? (
                  <span className={styles.rowTitle}>{name}</span>
                ) : (
                  <Link to={`/admin/familia/${encodeURIComponent(subjectId)}`} className={cx(styles.rowTitle, styles.personLink)}>
                    {name}
                  </Link>
                )
              ) : null}
              <span>{revisionSummary(item)}</span>
              <span className={styles.muted}>
                {item.actor === null ? (
                  "Cuenta eliminada"
                ) : onFilterActor ? (
                  <button type="button" className={styles.linkButton} onClick={() => item.actor && onFilterActor(item.actor)}>
                    {item.actor.displayName}
                  </button>
                ) : (
                  item.actor.displayName
                )}{" "}
                · {formatInstant(item.createdAt)}
              </span>
              {item.revertedByRevisionId !== null ? (
                <span className={styles.badgeLine}>
                  <Badge tone="neutral">Deshecho</Badge>
                </span>
              ) : null}
            </div>
            {item.revertible ? (
              <Button
                variant="secondary"
                size="sm"
                loading={revertingId === item.id}
                aria-label={`Deshacer: ${revisionSummary(item)}${name === null ? "" : ` de ${name}`}`}
                onClick={() => onRevert(item)}
              >
                Deshacer
              </Button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
