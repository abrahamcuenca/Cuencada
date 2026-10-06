import type { FamilyTreeView, PersonSummary, RelationshipKind } from "@cuencada/types";
import { type ReactNode, useState } from "react";
import { Link } from "react-router-dom";
import { getApiErrorCode, isAbortError, isFetchBaseQueryError, parseApiError } from "../../../../shared/api/errors";
import { AvatarCircle } from "../../../../shared/ui/AvatarCircle";
import { Button } from "../../../../shared/ui/Button";
import { Dialog } from "../../../../shared/ui/Dialog";
import { EmptyState } from "../../../../shared/ui/EmptyState";
import { Skeleton } from "../../../../shared/ui/Skeleton";
import { useToast } from "../../../../shared/ui/Toast";
import { useAccessDenial } from "../../../auth/accessDenied";
import { AccessDeniedState } from "../../../auth/components/AccessDeniedState";
import { useGetFamilyTreeQuery } from "../../api";
import { PersonSearch } from "../../components/PersonSearch";
import familyStyles from "../../family.module.css";
import styles from "../admin.module.css";
import { useCreateRelationshipMutation, useDeleteRelationshipMutation } from "../api";
import { ConfirmDialog } from "./ConfirmDialog";

/** The three groups an admin can add to. */
export type RelationRole = "parent" | "partner" | "child";

interface RoleCopy {
  title: string;
  add: string;
  pickTitle: string;
  empty: string;
}

const COPY: Record<RelationRole, RoleCopy> = {
  parent: {
    title: "Padres",
    add: "Agregar padre/madre",
    pickTitle: "Agregar padre o madre",
    empty: "Aún no hay padres registrados."
  },
  partner: {
    title: "Parejas",
    add: "Agregar pareja",
    pickTitle: "Agregar pareja",
    empty: "Aún no hay pareja registrada."
  },
  child: {
    title: "Hijos",
    add: "Agregar hijo/a",
    pickTitle: "Agregar hijo o hija",
    empty: "Aún no hay hijos registrados."
  }
};

const ROLES: readonly RelationRole[] = ["parent", "partner", "child"];

/** Most parents a person can have; the server enforces it too. */
const MAX_PARENTS = 2;

/** A relative plus the edge that links them to the person (needed to remove it). */
interface RelatedPerson {
  person: PersonSummary;
  relationshipId: string | null;
}

/**
 * Finds the edge id for each relative in `extended.relationships`.
 *
 * @param view - A tree view of the person being edited (`extended.relationships` carries the first-ring edge ids, per T6-BE).
 * @param role - Which group.
 * @returns The group's people with their edge ids (`null` if the server did not return the edge).
 */
export function relatedWithEdges(view: FamilyTreeView, role: RelationRole): RelatedPerson[] {
  const focusId = view.focus.id;
  const people = role === "parent" ? view.parents : role === "child" ? view.children : view.partners;
  return people.map((person) => {
    const edge = view.extended.relationships.find((relationship) => {
      if (role === "parent")
        return relationship.kind === "parent_of" && relationship.fromPersonId === person.id && relationship.toPersonId === focusId;
      if (role === "child")
        return relationship.kind === "parent_of" && relationship.fromPersonId === focusId && relationship.toPersonId === person.id;
      return (
        relationship.kind === "partner_of" &&
        ((relationship.fromPersonId === focusId && relationship.toPersonId === person.id) ||
          (relationship.fromPersonId === person.id && relationship.toPersonId === focusId))
      );
    });
    return { person, relationshipId: edge?.id ?? null };
  });
}

/**
 * The Spanish message for a refused `POST /admin/relationships`: the
 * server's own message (cycle, duplicate, more than two parents) when it sent
 * one, or a fallback that names every rule.
 *
 * @param error - What `.unwrap()` rejected with.
 * @returns The message to show in the picker.
 */
export function relationshipErrorMessage(error: unknown): string {
  const parsed = parseApiError(error);
  const code = getApiErrorCode(error);
  const detail = parsed?.error.details?.[0]?.message;
  // A 409 without a contract body (e.g. a proxy) still means a rule was broken.
  const status = isFetchBaseQueryError(error) ? error.status : null;
  if (code === "CONFLICT" || code === "VALIDATION" || (code === null && status === 409)) {
    return detail ?? parsed?.error.message ?? "No se pudo agregar: la relación ya existe, crearía un ciclo o la persona ya tiene dos padres.";
  }
  if (code === "NOT_FOUND") return "Una de las dos personas ya no existe. Recarga la página.";
  return parsed?.error.message ?? "No pudimos agregar la relación. Revisa tu conexión e inténtalo otra vez.";
}

function bodyFor(role: RelationRole, personId: string, otherId: string): { kind: RelationshipKind; fromPersonId: string; toPersonId: string } {
  if (role === "parent") return { kind: "parent_of", fromPersonId: otherId, toPersonId: personId };
  if (role === "child") return { kind: "parent_of", fromPersonId: personId, toPersonId: otherId };
  // Partners are symmetric; the server normalises the order.
  return { kind: "partner_of", fromPersonId: personId, toPersonId: otherId };
}

/** Props for {@link RelationshipManager}. */
export interface RelationshipManagerProps {
  personId: string;
  personName: string;
}

/**
 * Parents, partners and children of one person, each with "Agregar …"
 * (picked with the people search) and "Quitar" (confirmed in a Dialog).
 * Server refusals (cycle, duplicate, > 2 parents) are shown in Spanish
 * inside the picker.
 */
export function RelationshipManager({ personId, personName }: RelationshipManagerProps): ReactNode {
  const tree = useGetFamilyTreeQuery({ personId, depth: 1 });
  const denial = useAccessDenial(tree.error);
  const [adding, setAdding] = useState<RelationRole | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<{
    relationshipId: string;
    name: string;
    role: RelationRole;
  } | null>(null);
  const [create, createState] = useCreateRelationshipMutation();
  const [remove, removeState] = useDeleteRelationshipMutation();
  const toast = useToast();

  if (tree.currentData === undefined) {
    if (denial !== null) {
      return <AccessDeniedState denial={denial} verifyTitle="Verifica tu correo para ver sus relaciones" forbiddenTitle="No tienes acceso a sus relaciones" />;
    }
    if (tree.isError) {
      return (
        <EmptyState icon="⚠️" title="No pudimos cargar las relaciones" action={<Button onClick={() => void tree.refetch()}>Reintentar</Button>} />
      );
    }
    return <Skeleton shape="block" height="12rem" />;
  }
  const view = tree.currentData;
  const groups: Record<RelationRole, RelatedPerson[]> = {
    parent: relatedWithEdges(view, "parent"),
    partner: relatedWithEdges(view, "partner"),
    child: relatedWithEdges(view, "child")
  };
  const related = new Set<string>([personId, ...[...view.parents, ...view.partners, ...view.children].map((entry) => entry.id)]);

  const pick = async (other: PersonSummary): Promise<void> => {
    if (adding === null) return;
    setAddError(null);
    try {
      await create(bodyFor(adding, personId, other.id)).unwrap();
      toast.show({
        message: `Agregamos a ${other.fullName}.`,
        tone: "success"
      });
      setAdding(null);
    } catch (error) {
      if (isAbortError(error)) return;
      setAddError(relationshipErrorMessage(error));
    }
  };

  const confirmRemove = async (): Promise<void> => {
    if (removing === null) return;
    try {
      await remove(removing.relationshipId).unwrap();
      toast.show({
        message: `Quitamos la relación con ${removing.name}.`,
        tone: "success"
      });
    } catch (error) {
      if (!isAbortError(error))
        toast.show({
          message: "No pudimos quitar la relación. Inténtalo otra vez.",
          tone: "danger"
        });
    } finally {
      setRemoving(null);
    }
  };

  return (
    <div className={styles.panel}>
      {ROLES.map((role) => {
        const copy = COPY[role];
        const people = groups[role];
        const full = role === "parent" && people.length >= MAX_PARENTS;
        const headingId = `relaciones-${role}`;
        return (
          <section key={role} className={styles.group} aria-labelledby={headingId}>
            <div className={styles.groupHeader}>
              <h3 id={headingId} className={styles.groupTitle}>
                {copy.title}
              </h3>
              <Button
                variant="secondary"
                size="sm"
                icon="＋"
                disabled={full}
                onClick={() => {
                  setAddError(null);
                  setAdding(role);
                }}
              >
                {copy.add}
              </Button>
            </div>
            {full ? <p className={styles.muted}>Ya tiene dos padres registrados.</p> : null}
            {people.length === 0 ? (
              <p className={styles.muted}>{copy.empty}</p>
            ) : (
              <ul className={styles.rows}>
                {people.map(({ person, relationshipId }) => (
                  <li key={person.id} className={styles.row}>
                    <AvatarCircle name={person.fullName} src={person.avatarUrl ?? undefined} size="sm" decorative />
                    <div className={styles.rowMain}>
                      <Link to={`/admin/familia/${encodeURIComponent(person.id)}`} className={styles.rowTitle}>
                        {person.fullName}
                        {person.deceased ? " †" : ""}
                      </Link>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={relationshipId === null}
                      aria-label={`Quitar a ${person.fullName} de ${copy.title.toLowerCase()}`}
                      onClick={() => {
                        if (relationshipId !== null)
                          setRemoving({
                            relationshipId,
                            name: person.fullName,
                            role
                          });
                      }}
                    >
                      Quitar
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}

      <Dialog
        open={adding !== null}
        onClose={() => setAdding(null)}
        title={adding === null ? "" : COPY[adding].pickTitle}
        description={`Para ${personName}.`}
      >
        {adding !== null ? (
          <div className={familyStyles.form}>
            <PersonSearch
              label="Buscar persona"
              actionLabel="Elegir a"
              excludeIds={related}
              excludedReason="Ya está relacionada"
              autoFocus
              clearOnPick={false}
              onPick={(other) => void pick(other)}
            />
            {createState.isLoading ? <p className={styles.muted}>Guardando…</p> : null}
            {addError !== null ? (
              <p role="alert" className={familyStyles.formError}>
                {addError}
              </p>
            ) : null}
          </div>
        ) : null}
      </Dialog>

      <ConfirmDialog
        open={removing !== null}
        title="¿Quitar esta relación?"
        description={removing === null ? "" : `Se quita el vínculo entre ${personName} y ${removing.name}. Las dos personas siguen en el árbol.`}
        confirmLabel="Quitar"
        busy={removeState.isLoading}
        onConfirm={() => void confirmRemove()}
        onClose={() => setRemoving(null)}
      />
    </div>
  );
}
