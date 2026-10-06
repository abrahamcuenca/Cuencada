import type { ReactNode } from "react";

/** `/entrar`: placeholder until T1 builds the real page. */
export function LoginPage(): ReactNode {
  return (
    <section className="shell">
      <p className="kicker">Acceso</p>
      <h1>Entrar</h1>
      <p>Inicia sesión con tu correo y contraseña, o pide un enlace mágico.</p>
    </section>
  );
}
