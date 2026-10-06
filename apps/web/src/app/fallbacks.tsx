import type { ReactNode } from "react";
import { isRouteErrorResponse, Link, useRouteError } from "react-router-dom";

/** Shown while a lazy route's code downloads on first load. */
export function RouteSpinner(): ReactNode {
  return (
    <div role="status" aria-live="polite" className="shell">
      <p>Cargando…</p>
    </div>
  );
}

/** 404 for any unknown path. */
export function NotFoundPage(): ReactNode {
  return (
    <section className="shell">
      <p className="kicker">Error 404</p>
      <h1>No encontramos esta página</h1>
      <p>Puede que el enlace esté mal escrito o que la página ya no exista.</p>
      <Link className="btn primary" to="/">
        Volver al inicio
      </Link>
    </section>
  );
}

/**
 * Router error boundary (failed lazy chunk, render error). Shows a generic
 * Spanish message; no stack traces or internals reach the screen.
 */
export function RouteErrorPage(): ReactNode {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFoundPage />;

  return (
    <section className="shell" role="alert">
      <h1>Algo salió mal</h1>
      <p>Recarga la página. Si el problema continúa, avísale a la administración.</p>
      <Link className="btn primary" to="/">
        Volver al inicio
      </Link>
    </section>
  );
}

/**
 * Dev-only `/_ui` placeholder.
 * TODO(WP-0.7): mount `shared/ui/StyleGuide.tsx` here once that branch lands.
 */
export function DevStyleGuidePlaceholder(): ReactNode {
  return (
    <section className="shell">
      <p className="kicker">Solo desarrollo</p>
      <h1>Guía de estilos</h1>
      <p>Aquí se montará la guía de componentes de WP-0.7.</p>
    </section>
  );
}
