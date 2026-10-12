/**
 * `/recuerdos` (members, WP-6.3): the "Baúl de recuerdos". Published boxes
 * as cards (cover or placeholder, title, photo count, description), in the
 * order admins set. Admins get a shortcut to the panel.
 */
import type { ReactNode } from "react";
import { useAppSelector } from "../../../app/hooks";
import { isAbortError } from "../../../shared/api/errors";
import { Button } from "../../../shared/ui/Button";
import { EmptyState } from "../../../shared/ui/EmptyState";
import { Skeleton } from "../../../shared/ui/Skeleton";
import { cx } from "../../../shared/ui/cx";
import { useAccessDenial } from "../../auth/accessDenied";
import { selectIsAdmin } from "../../auth/authSlice";
import { AccessDeniedState } from "../../auth/components/AccessDeniedState";
import { useListMemoriesQuery } from "../api";
import { MemoryCard } from "../components/MemoryCard";
import { MEMORY_BOX_NAME } from "../lib/format";
import styles from "../memories.module.css";

/** The list page. */
export function MemoriesPage(): ReactNode {
  const isAdmin = useAppSelector(selectIsAdmin);
  return (
    <div className={cx("cu-container", styles.page)}>
      <header className={styles.listHeader}>
        <div>
          <h1 className={styles.title}>{MEMORY_BOX_NAME}</h1>
          <p className={styles.intro}>Fotos de antes y de siempre. Cualquiera de la familia puede agregar las suyas.</p>
        </div>
        {isAdmin ? (
          <Button to="/admin/recuerdos" variant="secondary" icon="⭐">
            Administrar
          </Button>
        ) : null}
      </header>
      <MemoryList />
    </div>
  );
}

function MemoryList(): ReactNode {
  const { data, isLoading, isError, error, refetch } = useListMemoriesQuery();
  const denial = useAccessDenial(error);

  if (isLoading) {
    return (
      <div className={styles.grid} aria-busy="true">
        <span className="visually-hidden">Cargando baúles…</span>
        {[0, 1, 2].map((index) => (
          <Skeleton key={index} shape="block" height="15rem" />
        ))}
      </div>
    );
  }
  if (isError && data === undefined) {
    if (isAbortError(error)) return null;
    if (denial !== null) {
      return <AccessDeniedState denial={denial} verifyTitle="Verifica tu correo para ver el baúl de recuerdos" forbiddenTitle="No tienes acceso al baúl de recuerdos" />;
    }
    return (
      <EmptyState
        icon="📡"
        title="No pudimos cargar el baúl"
        description="Revisa tu conexión e inténtalo de nuevo."
        action={
          <Button variant="secondary" onClick={() => void refetch()}>
            Reintentar
          </Button>
        }
      />
    );
  }
  const boxes = data?.items ?? [];
  if (boxes.length === 0) {
    return <EmptyState icon="🗃️" title="El baúl todavía está vacío" description="Pronto habrá colecciones de fotos para recordar juntos." />;
  }
  return (
    <ul className={styles.grid} aria-label="Baúles">
      {boxes.map((box) => (
        <li key={box.id}>
          <MemoryCard box={box} onMediaError={() => void refetch()} />
        </li>
      ))}
    </ul>
  );
}
