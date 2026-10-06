import type { AdminCuencada } from "@cuencada/types";
import { type ReactNode, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getApiErrorMessage, isAbortError, isFetchBaseQueryError } from "../../../shared/api/errors";
import { Button } from "../../../shared/ui/Button";
import { EmptyState } from "../../../shared/ui/EmptyState";
import { Skeleton } from "../../../shared/ui/Skeleton";
import { Tabs } from "../../../shared/ui/Tabs";
import { useToast } from "../../../shared/ui/Toast";
import { useGetAdminCuencadaQuery } from "../../cuencadas/admin/api";
import { useExportRsvpsCsvMutation } from "../api";
import { downloadCsv } from "../lib/download";
import { AttendanceChecklist } from "./AttendanceChecklist";
import { AdminRsvpList } from "./AdminRsvpList";
import styles from "./admin.module.css";

/**
 * `/admin/cuencadas/:id/asistencia`: historical attendance (a searchable
 * people checklist saved as one bulk request) and the RSVP list with
 * filters and the CSV export.
 */
export function AdminAttendancePage(): ReactNode {
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
  return <AttendanceScreen cuencada={query.data.cuencada} />;
}

function AttendanceScreen({ cuencada }: { cuencada: AdminCuencada }): ReactNode {
  const toast = useToast();
  const [tab, setTab] = useState("asistencia");
  const [exportCsv, exportState] = useExportRsvpsCsvMutation();

  const onExport = async (): Promise<void> => {
    try {
      const csv = await exportCsv(cuencada.id).unwrap();
      downloadCsv(csv, `cuencada-${cuencada.year}-confirmaciones.csv`);
      toast.show({ message: "Descargamos el CSV de confirmaciones.", tone: "success" });
    } catch (error) {
      if (!isAbortError(error)) toast.show({ message: getApiErrorMessage(error), tone: "danger" });
    } finally {
      // The CSV holds PII (emails); don't keep it in the store.
      exportState.reset();
    }
  };

  return (
    <div className={`cu-container ${styles.page}`}>
      <Link to={`/admin/cuencadas/${encodeURIComponent(cuencada.id)}`} className={styles.back}>
        ‹ {cuencada.title}
      </Link>
      <div className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>Asistencia</h1>
        <Button variant="secondary" size="sm" icon="⬇️" loading={exportState.isLoading} onClick={() => void onExport()}>
          Exportar CSV
        </Button>
      </div>
      <Tabs
        label="Asistencia y confirmaciones"
        value={tab}
        onChange={setTab}
        className={styles.tabs}
        items={[
          { id: "asistencia", label: "Asistencia", content: <AttendanceChecklist cuencadaId={cuencada.id} /> },
          { id: "confirmaciones", label: "Confirmaciones", content: <AdminRsvpList cuencada={cuencada} /> }
        ]}
      />
    </div>
  );
}
