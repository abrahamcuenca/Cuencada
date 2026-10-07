import type { AdminCuencadaDetail } from "@cuencada/types";
import { type ReactNode, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { getApiErrorCode, isAbortError, isFetchBaseQueryError } from "../../../../shared/api/errors";
import { Badge } from "../../../../shared/ui/Badge";
import { Button } from "../../../../shared/ui/Button";
import { Switch } from "../../../../shared/ui/Checkbox";
import { EmptyState } from "../../../../shared/ui/EmptyState";
import { Skeleton } from "../../../../shared/ui/Skeleton";
import { Tabs } from "../../../../shared/ui/Tabs";
import { useToast } from "../../../../shared/ui/Toast";
import { useDeleteCuencadaMutation, useGetAdminCuencadaQuery, useUpdateCuencadaMutation } from "../api";
import { AnnouncementsEditor } from "../components/AnnouncementsEditor";
import { ConfirmDialog, toastError } from "../components/common";
import { CuencadaForm, type CuencadaFormBody } from "../components/CuencadaForm";
import { DailyMessagesEditor } from "../components/DailyMessagesEditor";
import { ItineraryEditor } from "../components/ItineraryEditor";
import { LocationEditor } from "../components/LocationEditor";
import { type FieldErrors, isoToZonedLocal, serverErrorToFieldErrors } from "../forms";
import styles from "../admin.module.css";

/**
 * `/admin/cuencadas/:id`: one edition's editor. A publish switch and a
 * draft-only delete sit on top; below, tabs for the data form, Programa,
 * Lugares, Mensajes del día and Avisos.
 */
export function AdminCuencadaEditPage(): ReactNode {
  const id = useParams().id ?? "";
  const query = useGetAdminCuencadaQuery(id, { skip: id === "" });

  if (query.data === undefined) {
    if (query.error === undefined) {
      return (
        <div className={`cu-container ${styles.page}`}>
          <Skeleton shape="block" height="20rem" />
        </div>
      );
    }
    const notFound = isFetchBaseQueryError(query.error) && (query.error.status === 404 || query.error.status === 400);
    return (
      <div className={`cu-container ${styles.page}`}>
        <EmptyState
          icon={notFound ? "🧭" : "⚠️"}
          title={notFound ? "No encontramos esa Cuencada" : "No pudimos cargar la Cuencada"}
          action={notFound ? <Button to="/admin/cuencadas">Ver todas</Button> : <Button onClick={() => void query.refetch()}>Reintentar</Button>}
        />
      </div>
    );
  }
  return <Editor detail={query.data} />;
}

function Editor({ detail }: { detail: AdminCuencadaDetail }): ReactNode {
  const { cuencada } = detail;
  const toast = useToast();
  const navigate = useNavigate();
  const [update, updateState] = useUpdateCuencadaMutation();
  const [remove, removeState] = useDeleteCuencadaMutation();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [tab, setTab] = useState("datos");

  const togglePublished = (isPublished: boolean): void => {
    update({ id: cuencada.id, patch: { isPublished } })
      .unwrap()
      .then(() =>
        toast.show({
          message: isPublished ? `La Cuencada ${cuencada.year} ya es pública.` : `La Cuencada ${cuencada.year} volvió a borrador.`,
          tone: "success"
        })
      )
      .catch((error: unknown) => toastError(toast, error));
  };

  const saveData = async (body: CuencadaFormBody): Promise<FieldErrors | null> => {
    try {
      await update({ id: cuencada.id, patch: body }).unwrap();
      toast.show({ message: "Cambios guardados.", tone: "success" });
      return null;
    } catch (error) {
      if (isAbortError(error)) return null;
      if (getApiErrorCode(error) === "CONFLICT") return { year: "Ya existe una Cuencada con ese año." };
      return serverErrorToFieldErrors(error, "No pudimos guardar los cambios. Inténtalo otra vez.");
    }
  };

  const confirmDelete = (): void => {
    remove(cuencada.id)
      .unwrap()
      .then(() => {
        toast.show({ message: `Borraste el borrador ${cuencada.year}.`, tone: "success" });
        navigate("/admin/cuencadas");
      })
      .catch((error: unknown) => {
        setConfirmingDelete(false);
        toastError(toast, error);
      });
  };

  // An announced edition has no first day yet: a new activity starts with an empty date.
  const firstDay = cuencada.startsAt === null ? "" : isoToZonedLocal(cuencada.startsAt, cuencada.timezone).slice(0, 10);

  return (
    <div className={`cu-container ${styles.page}`}>
      <Link to="/admin/cuencadas" className={styles.back}>
        ‹ Cuencadas
      </Link>
      <div className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>{cuencada.title}</h1>
        <Badge tone={cuencada.isPublished ? "success" : "neutral"}>{cuencada.isPublished ? "Publicada" : "Borrador"}</Badge>
      </div>
      <div className={styles.publishRow}>
        <Switch
          label="Publicada"
          hint={cuencada.isPublished ? "Visible en el portal." : "Solo la ven los administradores."}
          checked={cuencada.isPublished}
          disabled={updateState.isLoading}
          onChange={(event) => togglePublished(event.target.checked)}
        />
        <Button to={`/admin/cuencadas/${encodeURIComponent(cuencada.id)}/asistencia`} variant="secondary" size="sm" icon="✅">
          Asistencia y confirmaciones
        </Button>
        {cuencada.isPublished ? (
          <Button to={`/cuencada/${cuencada.year}`} variant="secondary" size="sm" iconEnd="↗">
            Ver página
          </Button>
        ) : (
          <Button variant="danger" size="sm" onClick={() => setConfirmingDelete(true)}>
            Borrar borrador
          </Button>
        )}
      </div>

      <Tabs
        label="Secciones de la Cuencada"
        value={tab}
        onChange={setTab}
        className={styles.tabs}
        items={[
          {
            id: "datos",
            label: "Datos",
            content: <CuencadaForm key={cuencada.updatedAt} initial={cuencada} submitLabel="Guardar cambios" onSubmit={saveData} />
          },
          {
            id: "programa",
            label: `Programa (${detail.itinerary.length})`,
            content: (
              <ItineraryEditor
                cuencadaId={cuencada.id}
                timeZone={cuencada.timezone}
                defaultDate={firstDay}
                items={detail.itinerary}
                locations={detail.locations}
              />
            )
          },
          {
            id: "lugares",
            label: `Lugares (${detail.locations.length})`,
            content: <LocationEditor cuencadaId={cuencada.id} locations={detail.locations} />
          },
          {
            id: "mensajes",
            label: `Mensajes (${detail.dailyMessageCount})`,
            content: <DailyMessagesEditor cuencadaId={cuencada.id} timeZone={cuencada.timezone} />
          },
          {
            id: "avisos",
            label: `Avisos (${detail.announcements.length})`,
            content: <AnnouncementsEditor cuencadaId={cuencada.id} timeZone={cuencada.timezone} />
          }
        ]}
      />

      <ConfirmDialog
        open={confirmingDelete}
        title={`¿Borrar el borrador ${cuencada.year}?`}
        description="Se borrarán también su programa, lugares, mensajes y avisos. No se puede deshacer."
        confirmLabel="Borrar borrador"
        busy={removeState.isLoading}
        onConfirm={confirmDelete}
        onClose={() => setConfirmingDelete(false)}
      />
    </div>
  );
}
