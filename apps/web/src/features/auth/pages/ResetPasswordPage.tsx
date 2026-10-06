import type { ReactNode } from "react";
import { useFragmentToken } from "../useFragmentToken";

/** `/restablecer#t=…`: placeholder until T1 builds the real page. The token is scrubbed from the URL on load. */
export function ResetPasswordPage(): ReactNode {
  const token = useFragmentToken();
  return (
    <section className="shell">
      <p className="kicker">Acceso</p>
      <h1>Nueva contraseña</h1>
      <p>{token === null ? "Este enlace no es válido o está incompleto. Pide uno nuevo." : "Escribe tu nueva contraseña."}</p>
    </section>
  );
}
