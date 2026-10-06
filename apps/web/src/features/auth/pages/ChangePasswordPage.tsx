import type { ReactNode } from "react";

/** `/cambiar-contrasena`: placeholder until T1 builds the real page. */
export function ChangePasswordPage(): ReactNode {
  return (
    <section className="shell">
      <p className="kicker">Seguridad</p>
      <h1>Cambia tu contraseña</h1>
      <p>Tu cuenta usa una contraseña temporal. Crea una nueva para continuar.</p>
    </section>
  );
}
