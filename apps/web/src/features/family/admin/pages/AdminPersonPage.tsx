import { type PersonDetails, idSchema } from "@cuencada/types";
import { type ReactNode, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { getApiErrorCode, getApiErrorMessage, isAbortError } from "../../../../shared/api/errors";
import { Button } from "../../../../shared/ui/Button";
import { Checkbox } from "../../../../shared/ui/Checkbox";
import { EmptyState } from "../../../../shared/ui/EmptyState";
import { Skeleton } from "../../../../shared/ui/Skeleton";
import { Tabs } from "../../../../shared/ui/Tabs";
import { useToast } from "../../../../shared/ui/Toast";
import { cx } from "../../../../shared/ui/cx";
import { useAccessDenial } from "../../../auth/accessDenied";
import { AccessDeniedState } from "../../../auth/components/AccessDeniedState";
import { useGetPersonQuery } from "../../api";
import { type FieldErrors, serverErrorToFieldErrors } from "../../lib/forms";
import styles from "../admin.module.css";
import { useDeletePersonMutation, usePurgePersonRevisionsMutation, useUpdatePersonMutation } from "../api";
import { ADMIN_VERIFY_TITLE } from "./AdminFamilyPage";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { PERSON_FORM_FIELDS, PersonForm, type PersonFormSubmit } from "../components/PersonForm";
import { RelationshipManager } from "../components/RelationshipManager";
import { RevisionFeed } from "../components/RevisionFeed";

/** Why "Quitar" is disabled for a person linked to an account (the server answers 409 otherwise). */
export const LINKED_DELETE_HINT = "Está vinculada a una cuenta. Para quitarla del árbol, primero desvincula la cuenta en «Datos» y guarda.";

/**
 * `/admin/familia/:personId`: edit one person (data + linked account), manage
 * their parents, partners and children, see and undo their history, or
 * delete them (optionally with their history).
 */
export function AdminPersonPage(): ReactNode {
  const { personId = "" } = useParams();
  const validId = idSchema.safeParse(personId).success;
  const person = useGetPersonQuery(personId, { skip: !validId });
  const denial = useAccessDenial(person.error);

  let body: ReactNode;
  if (!validId || getApiErrorCode(person.error) === "NOT_FOUND") {
    body = <EmptyState icon="🔎" title="No encontramos a esa persona" action={<Button to="/admin/familia">Volver a la lista</Button>} />;
  } else if (person.currentData === undefined && denial !== null) {
    body = <AccessDeniedState denial={denial} verifyTitle={ADMIN_VERIFY_TITLE} forbiddenTitle="No tienes acceso a esta persona" />;
  } else if (person.currentData === undefined) {
    body = person.isError ? (
      <EmptyState icon="⚠️" title="No pudimos cargar a la persona" action={<Button onClick={() => void person.refetch()}>Reintentar</Button>} />
    ) : (
      <Skeleton shape="block" height="20rem" />
    );
  } else {
    body = <PersonEditor key={person.currentData.id} person={person.currentData} />;
  }

  return (
    <div className={cx("cu-container", styles.page)}>
      <Link to="/admin/familia" className={styles.back}>
        ‹ Personas
      </Link>
      {body}
    </div>
  );
}

function PersonEditor({ person }: { person: PersonDetails }): ReactNode {
  const [update] = useUpdatePersonMutation();
  const [remove, removeState] = useDeletePersonMutation();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [purgeWithDelete, setPurgeWithDelete] = useState(false);
  const toast = useToast();
  const navigate = useNavigate();

  const submit = async (request: PersonFormSubmit): Promise<FieldErrors | null> => {
    if (request.mode !== "update") return null;
    try {
      await update({ id: person.id, patch: request.patch }).unwrap();
      toast.show({ message: "Guardamos los cambios.", tone: "success" });
      return null;
    } catch (error) {
      if (isAbortError(error)) return null;
      const errors = serverErrorToFieldErrors(error, "No pudimos guardar los cambios. Inténtalo otra vez.", PERSON_FORM_FIELDS);
      // A 409 is always about the account link (already linked elsewhere, or a re-link without unlinking first).
      if (getApiErrorCode(error) === "CONFLICT" && errors.userId === undefined) return { userId: "Esa cuenta ya está vinculada a otra persona." };
      return errors;
    }
  };

  const doDelete = async (): Promise<void> => {
    try {
      await remove({ id: person.id, purgeHistory: purgeWithDelete }).unwrap();
      toast.show({
        message: purgeWithDelete ? `Quitamos a ${person.fullName} del árbol y borramos su historial.` : `Quitamos a ${person.fullName} del árbol.`,
        tone: "success"
      });
      navigate("/admin/familia");
    } catch (error) {
      setConfirmDelete(false);
      if (isAbortError(error)) return;
      // 409: linked to an account (e.g. linked from another tab meanwhile): show the server's reason.
      const message = getApiErrorCode(error) === "CONFLICT" ? getApiErrorMessage(error) : "No pudimos quitar a la persona. Inténtalo otra vez.";
      toast.show({ message, tone: "danger" });
    }
  };

  const data = (
    <>
      <section aria-labelledby="datos-persona" className={styles.panel}>
        <h2 id="datos-persona" className={styles.sectionTitle}>
          Datos
        </h2>
        <PersonForm person={person} submitLabel="Guardar cambios" onSubmit={submit} />
      </section>

      <section aria-labelledby="relaciones-persona" className={styles.panel}>
        <h2 id="relaciones-persona" className={styles.sectionTitle}>
          Relaciones
        </h2>
        <RelationshipManager personId={person.id} personName={person.fullName} />
      </section>

      <section aria-labelledby="quitar-persona" className={styles.danger}>
        <h2 id="quitar-persona" className={styles.sectionTitle}>
          Quitar del árbol
        </h2>
        <p className={styles.muted}>Se borran también todas sus relaciones y su foto del árbol. Su cuenta, si tiene, no se borra.</p>
        {person.userId !== null ? (
          <p id="quitar-persona-vinculada" className={styles.muted}>
            {LINKED_DELETE_HINT}
          </p>
        ) : null}
        <Checkbox
          label="Borrar también el historial"
          hint="Para solicitudes de borrado: no queda ningún registro de sus datos y no se podrá deshacer."
          checked={purgeWithDelete}
          disabled={person.userId !== null}
          onChange={(event) => setPurgeWithDelete(event.target.checked)}
        />
        <Button
          variant="danger"
          disabled={person.userId !== null}
          aria-describedby={person.userId !== null ? "quitar-persona-vinculada" : undefined}
          onClick={() => setConfirmDelete(true)}
        >
          Quitar a {person.fullName}
        </Button>
      </section>
    </>
  );

  return (
    <>
      <div className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>{person.fullName}</h1>
        <Button variant="ghost" size="sm" to={`/arbol/${encodeURIComponent(person.id)}`}>
          Ver en el árbol
        </Button>
      </div>

      <Tabs
        label="Secciones de la persona"
        variant="underline"
        items={[
          { id: "datos", label: "Datos", content: data },
          { id: "historial", label: "Historial", content: <PersonHistory person={person} /> }
        ]}
      />

      <ConfirmDialog
        open={confirmDelete}
        title={`¿Quitar a ${person.fullName}?`}
        description={
          purgeWithDelete
            ? "Se borra la persona, sus relaciones y todo su historial. No se puede deshacer."
            : "Se borra la persona y todas sus relaciones. Podrás deshacerlo desde «Actividad del árbol»."
        }
        confirmLabel="Quitar"
        busy={removeState.isLoading}
        onConfirm={() => void doDelete()}
        onClose={() => setConfirmDelete(false)}
      />
    </>
  );
}

/** "Historial": the person's changes with "Deshacer", and "Borrar historial" behind a confirmation. */
function PersonHistory({ person }: { person: PersonDetails }): ReactNode {
  const [confirmPurge, setConfirmPurge] = useState(false);
  const [purge, purgeState] = usePurgePersonRevisionsMutation();
  const toast = useToast();

  const doPurge = async (): Promise<void> => {
    try {
      const result = await purge(person.id).unwrap();
      toast.show({ message: result.deleted === 1 ? "Borramos 1 cambio del historial." : `Borramos ${result.deleted} cambios del historial.`, tone: "success" });
    } catch (error) {
      if (!isAbortError(error)) toast.show({ message: "No pudimos borrar el historial. Inténtalo otra vez.", tone: "danger" });
    } finally {
      setConfirmPurge(false);
    }
  };

  return (
    <section aria-labelledby="historial-persona" className={styles.panel}>
      <div className={styles.groupHeader}>
        <h2 id="historial-persona" className={styles.sectionTitle}>
          Historial
        </h2>
        <Button variant="ghost" size="sm" onClick={() => setConfirmPurge(true)}>
          Borrar historial
        </Button>
      </div>
      <p className={styles.muted}>Cada cambio de sus datos y relaciones, de administradores y familiares. Se guarda un año.</p>
      <RevisionFeed source={{ kind: "person", personId: person.id }} emptyTitle="Todavía no hay cambios registrados." />
      <ConfirmDialog
        open={confirmPurge}
        title="¿Borrar el historial?"
        description={`Se borran todos los cambios registrados de ${person.fullName}. Ya no se podrán deshacer.`}
        confirmLabel="Borrar historial"
        busy={purgeState.isLoading}
        onConfirm={() => void doPurge()}
        onClose={() => setConfirmPurge(false)}
      />
    </section>
  );
}
