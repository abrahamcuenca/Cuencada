import type { ReactNode } from "react";
import { getApiErrorMessage, isAbortError, isFetchBaseQueryError } from "../../../shared/api/errors";
import { Button } from "../../../shared/ui/Button";
import { EmptyState } from "../../../shared/ui/EmptyState";
import { Skeleton } from "../../../shared/ui/Skeleton";
import { cx } from "../../../shared/ui/cx";
import styles from "./states.module.css";

/** True for "the request never reached the server" (offline, DNS, captive portal). */
export function isNetworkError(error: unknown): boolean {
  return isFetchBaseQueryError(error) && (error.status === "FETCH_ERROR" || error.status === "TIMEOUT_ERROR");
}

/** Loading placeholder shaped like the hero and the first section. */
export function PageSkeleton(): ReactNode {
  return (
    <div className={styles.skeleton} aria-busy="true">
      <output className="visually-hidden">Cargando…</output>
      <Skeleton shape="block" height="16rem" className={styles.skeletonHero} />
      <div className={cx("cu-container", styles.skeletonBody)}>
        <Skeleton shape="text" width="60%" />
        <Skeleton shape="block" height="8rem" />
        <Skeleton shape="block" height="8rem" />
      </div>
    </div>
  );
}

/** Loading placeholder for the content below an already painted hero. */
export function SectionSkeleton(): ReactNode {
  return (
    <div className={cx("cu-container", styles.skeletonBody, styles.state)} aria-busy="true">
      <output className="visually-hidden">Cargando…</output>
      <Skeleton shape="text" width="60%" />
      <Skeleton shape="block" height="8rem" />
    </div>
  );
}

/** 404 for an unknown or unpublished year. */
export function CuencadaNotFound(): ReactNode {
  return (
    <div className={cx("cu-container", styles.state)}>
      <EmptyState
        icon="🧭"
        title="No encontramos esa Cuencada"
        description="Puede que el año esté mal escrito o que esa edición todavía no se publique."
        action={<Button to="/">Ir al inicio</Button>}
      />
    </div>
  );
}

/** Props for {@link LoadErrorState}. */
export interface LoadErrorStateProps {
  error: unknown;
  onRetry: () => void;
}

/**
 * First load failed and there is nothing cached to show. Offline gets its own
 * copy; other errors show the server's Spanish message. Aborts (logout) render
 * nothing, because the guards already move the user.
 */
export function LoadErrorState({ error, onRetry }: LoadErrorStateProps): ReactNode {
  if (isAbortError(error)) return null;
  const offline = isNetworkError(error);
  return (
    <div className={cx("cu-container", styles.state)}>
      <EmptyState
        icon={offline ? "📴" : "⚠️"}
        title={offline ? "Sin conexión" : "Algo salió mal al cargar esta sección"}
        description={
          offline
            ? "No pudimos cargar la Cuencada y no hay una copia guardada en este dispositivo. Revisa tu conexión."
            : getApiErrorMessage(error)
        }
        action={<Button onClick={onRetry}>Reintentar</Button>}
      />
    </div>
  );
}

/** Shown above cached content when the latest refresh failed. */
export function OfflineNotice({ onRetry }: { onRetry: () => void }): ReactNode {
  return (
    <div className={styles.notice}>
      <output>
        <span aria-hidden="true">📴 </span>
        Sin conexión. Mostramos la última información guardada.
      </output>
      <Button variant="ghost" size="sm" onClick={onRetry}>
        Reintentar
      </Button>
    </div>
  );
}
