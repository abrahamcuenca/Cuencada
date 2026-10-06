import type { ReactNode } from "react";

/** `/perfil/sesiones`: placeholder until T1 builds the real page. */
export function SessionsPage(): ReactNode {
  return (
    <section className="shell">
      <p className="kicker">Mi perfil</p>
      <h1>Sesiones activas</h1>
      <p>Revisa y cierra las sesiones abiertas en otros dispositivos.</p>
    </section>
  );
}
