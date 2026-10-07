import type { AdminCuencada } from "@cuencada/types";
import { type ReactNode, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { getApiErrorCode, isAbortError } from "../../../../shared/api/errors";
import { formatDate } from "../../../../shared/lib/dates";
import { Badge } from "../../../../shared/ui/Badge";
import { Button } from "../../../../shared/ui/Button";
import { Card } from "../../../../shared/ui/Card";
import { EmptyState } from "../../../../shared/ui/EmptyState";
import { Skeleton } from "../../../../shared/ui/Skeleton";
import { useToast } from "../../../../shared/ui/Toast";
import { useCreateCuencadaMutation, useListAdminCuencadasQuery } from "../api";
import { AnnouncementsEditor } from "../components/AnnouncementsEditor";
import { CuencadaForm, type CuencadaFormBody } from "../components/CuencadaForm";
import { type FieldErrors, serverErrorToFieldErrors } from "../forms";
import styles from "../admin.module.css";

/** Portal-wide announcements are shown in the family's home timezone. */
const PORTAL_TIMEZONE = "America/Merida";

/**
 * `/admin/cuencadas`: every edition (drafts included) as cards, a "Nueva"
 * form, and the portal-wide announcements shown on Home. Phone-first: no
 * tables, one column of cards.
 */
export function AdminCuencadasPage(): ReactNode {
  const list = useListAdminCuencadasQuery();
  const [creating, setCreating] = useState(false);
  const [create] = useCreateCuencadaMutation();
  const navigate = useNavigate();
  const toast = useToast();

  const submit = async (body: CuencadaFormBody): Promise<FieldErrors | null> => {
    try {
      const created = await create({ ...body, isPublished: false }).unwrap();
      toast.show({ message: `Creaste la Cuencada ${created.year} como borrador.`, tone: "success" });
      navigate(`/admin/cuencadas/${created.id}`);
      return null;
    } catch (error) {
      if (isAbortError(error)) return null;
      if (getApiErrorCode(error) === "CONFLICT") return { year: "Ya existe una Cuencada con ese año." };
      return serverErrorToFieldErrors(error, "No pudimos crear la Cuencada. Inténtalo otra vez.");
    }
  };

  return (
    <div className={`cu-container ${styles.page}`}>
      <Link to="/admin" className={styles.back}>
        ‹ Panel
      </Link>
      <div className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>Cuencadas</h1>
        {creating ? null : (
          <Button icon="＋" onClick={() => setCreating(true)}>
            Nueva
          </Button>
        )}
      </div>

      {creating ? (
        <section aria-labelledby="nueva-cuencada" className={styles.panel}>
          <h2 id="nueva-cuencada" className={styles.sectionTitle}>
            Nueva Cuencada
          </h2>
          <p className={styles.muted}>Se crea como borrador: nadie la ve hasta que la publiques.</p>
          <CuencadaForm initial={null} submitLabel="Crear borrador" onSubmit={submit} onCancel={() => setCreating(false)} />
        </section>
      ) : null}

      <section aria-label="Lista de Cuencadas" className={styles.panel}>
        {list.data === undefined ? (
          list.error === undefined ? (
            <Skeleton shape="block" height="10rem" />
          ) : (
            <EmptyState
              icon="⚠️"
              title="No pudimos cargar las Cuencadas"
              action={<Button onClick={() => void list.refetch()}>Reintentar</Button>}
            />
          )
        ) : list.data.length === 0 ? (
          <EmptyState icon="📅" title="Todavía no hay Cuencadas" description="Crea la primera con el botón «Nueva»." />
        ) : (
          <ul className={styles.rows}>
            {[...list.data]
              .sort((a, b) => b.year - a.year)
              .map((cuencada) => (
                <li key={cuencada.id}>
                  <CuencadaCard cuencada={cuencada} />
                </li>
              ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="avisos-generales" className={styles.panel}>
        <h2 id="avisos-generales" className={styles.sectionTitle}>
          Avisos generales
        </h2>
        <p className={styles.muted}>Se muestran en el inicio del portal, no en una Cuencada en particular.</p>
        <AnnouncementsEditor cuencadaId={null} timeZone={PORTAL_TIMEZONE} />
      </section>
    </div>
  );
}

function CuencadaCard({ cuencada }: { cuencada: AdminCuencada }): ReactNode {
  return (
    <Link to={`/admin/cuencadas/${cuencada.id}`} className={styles.cardLink}>
      <Card padding="sm" className={styles.row}>
        <div className={styles.rowMain}>
          <h2 className={styles.rowTitle}>
            {cuencada.year} · {cuencada.city}
          </h2>
          <p className={styles.rowMeta}>
            {formatDate(cuencada.startsAt, cuencada.timezone, { day: "numeric", month: "short" })} –{" "}
            {formatDate(cuencada.endsAt, cuencada.timezone, { day: "numeric", month: "short", year: "numeric" })}
          </p>
        </div>
        <Badge tone={cuencada.isPublished ? "success" : "neutral"}>{cuencada.isPublished ? "Publicada" : "Borrador"}</Badge>
        <span aria-hidden="true" className={styles.chevron}>
          ›
        </span>
      </Card>
    </Link>
  );
}
