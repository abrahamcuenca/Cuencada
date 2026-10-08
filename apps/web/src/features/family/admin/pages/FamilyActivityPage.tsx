import { type PersonRevisionAction, personRevisionActionSchema } from "@cuencada/types";
import { type ReactNode, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "../../../../shared/ui/Button";
import { Field } from "../../../../shared/ui/Field";
import { Select } from "../../../../shared/ui/Select";
import { cx } from "../../../../shared/ui/cx";
import styles from "../admin.module.css";
import { REVISION_ACTION_LABELS } from "../components/RevisionList";
import { RevisionFeed } from "../components/RevisionFeed";

const ACTION_OPTIONS = personRevisionActionSchema.options.map((action) => ({ value: action, label: REVISION_ACTION_LABELS[action] }));

/**
 * `/admin/familia/actividad` ("Actividad del árbol"): every change to the
 * family tree by admins and members, newest first, with "Deshacer". Filter
 * by action, or tap a name to see only that person's changes.
 */
export function FamilyActivityPage(): ReactNode {
  const [action, setAction] = useState<PersonRevisionAction | null>(null);
  const [actor, setActor] = useState<{ userId: string; displayName: string } | null>(null);
  const filters = {
    ...(action === null ? {} : { action }),
    ...(actor === null ? {} : { actorUserId: actor.userId })
  };

  return (
    <div className={cx("cu-container", styles.page)}>
      <Link to="/admin" className={styles.back}>
        ‹ Panel
      </Link>
      <div className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>Actividad del árbol</h1>
      </div>
      <p className={styles.muted}>Cada cambio en el árbol familiar, de administradores y familiares. Puedes deshacer los que no corresponden.</p>
      <section aria-label="Filtros" className={styles.panel}>
        <Field label="Tipo de cambio">
          {(control) => (
            <Select
              {...control}
              options={ACTION_OPTIONS}
              placeholder="Todos los cambios"
              value={action ?? ""}
              onChange={(event) => {
                const parsed = personRevisionActionSchema.safeParse(event.target.value);
                setAction(parsed.success ? parsed.data : null);
              }}
            />
          )}
        </Field>
        {actor !== null ? (
          <div className={styles.groupHeader}>
            <span>
              Solo cambios de <strong>{actor.displayName}</strong>
            </span>
            <Button variant="ghost" size="sm" onClick={() => setActor(null)}>
              Ver de todos
            </Button>
          </div>
        ) : null}
      </section>
      <section aria-label="Cambios" className={styles.panel}>
        <RevisionFeed source={{ kind: "activity", filters }} onFilterActor={setActor} emptyTitle="No hay cambios con estos filtros." />
      </section>
    </div>
  );
}
