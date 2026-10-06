import type { ReactNode } from "react";
import { isRouteErrorResponse, Link, useRouteError } from "react-router-dom";
import { Spinner } from "../shared/ui/Spinner";

/** Shown while a lazy route's code downloads on first load. */
export function RouteSpinner(): ReactNode {
  return (
    <div className="shell">
      <Spinner size="lg" label="Cargando…" />
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
