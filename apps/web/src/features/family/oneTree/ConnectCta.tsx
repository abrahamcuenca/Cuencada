import type { ReactNode } from "react";
import { Button } from "../../../shared/ui/Button";
import { useGetTreeOverviewQuery } from "./api";
import styles from "./oneTree.module.css";

/** Props for {@link ConnectCta}. */
export interface ConnectCtaProps {
  /** Opens "Conectar con…" for the caller's own person (the tree page owns the dialog). */
  onPropose: () => void;
}

/**
 * "¿No ves a tu familia? Propón una conexión" (WP-6.4): shown only when the
 * server says the caller's own person is not connected to the root
 * (`TreeOverview.viewerConnected === false`). Nothing while loading, without
 * a root, or on error.
 */
export function ConnectCta({ onPropose }: ConnectCtaProps): ReactNode {
  const overview = useGetTreeOverviewQuery({ depth: 1 });
  if (overview.currentData?.viewerConnected !== false) return null;
  return (
    <aside className={styles.cta} aria-labelledby="cta-conexion">
      <h2 id="cta-conexion" className={styles.ctaTitle}>
        ¿No ves a tu familia? Propón una conexión
      </h2>
      <p className={styles.ctaText}>
        Tu rama todavía no está unida al resto del árbol. Si alguien de tu familia ya aparece en el árbol completo, dinos quién es y un administrador lo revisará.
      </p>
      <div className={styles.actions}>
        <Button size="sm" onClick={onPropose}>
          Proponer una conexión
        </Button>
        <Button size="sm" variant="ghost" to="/arbol/completo">
          Ver el árbol completo
        </Button>
      </div>
    </aside>
  );
}
