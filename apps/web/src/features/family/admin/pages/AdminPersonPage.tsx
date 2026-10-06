import { type Person, idSchema } from "@cuencada/types";
import { type ReactNode, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { getApiErrorCode, isAbortError } from "../../../../shared/api/errors";
import { Button } from "../../../../shared/ui/Button";
import { EmptyState } from "../../../../shared/ui/EmptyState";
import { Skeleton } from "../../../../shared/ui/Skeleton";
import { useToast } from "../../../../shared/ui/Toast";
import { cx } from "../../../../shared/ui/cx";
import { useAccessDenial } from "../../../auth/accessDenied";
import { AccessDeniedState } from "../../../auth/components/AccessDeniedState";
import { useGetPersonQuery } from "../../api";
import { type FieldErrors, serverErrorToFieldErrors } from "../../lib/forms";
import styles from "../admin.module.css";
import { useDeletePersonMutation, useUpdatePersonMutation } from "../api";
import { ADMIN_VERIFY_TITLE } from "./AdminFamilyPage";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { PERSON_FORM_FIELDS, PersonForm, type PersonFormSubmit } from "../components/PersonForm";
import { RelationshipManager } from "../components/RelationshipManager";

/**
 * `/admin/familia/:personId`: edit one person (data + linked account), manage
 * their parents, partners and children, or delete them.
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

function PersonEditor({ person }: { person: Person }): ReactNode {
  const [update] = useUpdatePersonMutation();
  const [remove, removeState] = useDeletePersonMutation();
  const [confirmDelete, setConfirmDelete] = useState(false);
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
      if (getApiErrorCode(error) === "CONFLICT") return { userId: "Esa cuenta ya está vinculada a otra persona." };
      return serverErrorToFieldErrors(error, "No pudimos guardar los cambios. Inténtalo otra vez.", PERSON_FORM_FIELDS);
    }
  };

  const doDelete = async (): Promise<void> => {
    try {
      await remove(person.id).unwrap();
      toast.show({
        message: `Quitamos a ${person.fullName} del árbol.`,
        tone: "success"
      });
      navigate("/admin/familia");
    } catch (error) {
      setConfirmDelete(false);
      if (!isAbortError(error))
        toast.show({
          message: "No pudimos quitar a la persona. Inténtalo otra vez.",
          tone: "danger"
        });
    }
  };

  return (
    <>
      <div className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>{person.fullName}</h1>
        <Button variant="ghost" size="sm" to={`/arbol/${encodeURIComponent(person.id)}`}>
          Ver en el árbol
        </Button>
      </div>

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
        <p className={styles.muted}>Se borran también todas sus relaciones. Su cuenta, si tiene, no se borra.</p>
        <Button variant="danger" onClick={() => setConfirmDelete(true)}>
          Quitar a {person.fullName}
        </Button>
      </section>

      <ConfirmDialog
        open={confirmDelete}
        title={`¿Quitar a ${person.fullName}?`}
        description="Se borra la persona y todas sus relaciones. No se puede deshacer."
        confirmLabel="Quitar"
        busy={removeState.isLoading}
        onConfirm={() => void doDelete()}
        onClose={() => setConfirmDelete(false)}
      />
    </>
  );
}
