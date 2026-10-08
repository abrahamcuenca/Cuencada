import { type PersonRevisionAction, personRevisionActionSchema } from "@cuencada/types";
import { type ReactNode, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Button } from "../../../../shared/ui/Button";
import { Field } from "../../../../shared/ui/Field";
import { Select } from "../../../../shared/ui/Select";
import { Tabs } from "../../../../shared/ui/Tabs";
import { cx } from "../../../../shared/ui/cx";
import styles from "../admin.module.css";
import { DuplicateList } from "../components/DuplicateList";
import { REVISION_ACTION_LABELS } from "../components/RevisionList";
import { RevisionFeed } from "../components/RevisionFeed";

const ACTION_OPTIONS = personRevisionActionSchema.options.map((action) => ({ value: action, label: REVISION_ACTION_LABELS[action] }));

/** `?vista=duplicados` opens the "Posibles duplicados" tab (links from elsewhere, reloads). */
const DUPLICATES_TAB = "duplicados";

/**
 * `/admin/familia/actividad` ("Actividad del árbol"): every change to the
 * family tree by admins and members, newest first, with "Deshacer". Filter
 * by action, or tap a name to see only that person's changes. The
 * "Posibles duplicados" tab (WP-4.5) lists people who may be the same human,
 * with "Revisar" to merge them.
 */
export function FamilyActivityPage(): ReactNode {
  const [action, setAction] = useState<PersonRevisionAction | null>(null);
  const [actor, setActor] = useState<{ userId: string; displayName: string } | null>(null);
  const [params, setParams] = useSearchParams();
  const tab = params.get("vista") === DUPLICATES_TAB ? DUPLICATES_TAB : "cambios";
  const filters = {
    ...(action === null ? {} : { action }),
    ...(actor === null ? {} : { actorUserId: actor.userId })
  };

  const changes = (
    <div className={styles.panel}>
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

  const duplicates = (
    <section aria-label="Posibles duplicados" className={styles.panel}>
      <p className={styles.muted}>
        Personas que podrían ser la misma: mismo nombre (o con un apellido de más) y años compatibles, o una invitación que no se pudo vincular a su persona del árbol. Revisa cada
        par antes de fusionar.
      </p>
      <DuplicateList />
    </section>
  );

  return (
    <div className={cx("cu-container", styles.page)}>
      <Link to="/admin" className={styles.back}>
        ‹ Panel
      </Link>
      <div className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>Actividad del árbol</h1>
      </div>
      <Tabs
        label="Vistas de la actividad"
        variant="underline"
        value={tab}
        onChange={(id) => setParams(id === DUPLICATES_TAB ? { vista: DUPLICATES_TAB } : {}, { replace: true })}
        items={[
          { id: "cambios", label: "Cambios", content: changes },
          { id: DUPLICATES_TAB, label: "Posibles duplicados", content: duplicates }
        ]}
      />
    </div>
  );
}
