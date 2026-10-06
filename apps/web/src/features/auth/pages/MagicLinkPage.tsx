import type { ReactNode } from "react";
import { useFragmentToken } from "../useFragmentToken";

/** `/entrar/enlace#t=…`: placeholder until T1 builds the real page. The token is scrubbed from the URL on load. */
export function MagicLinkPage(): ReactNode {
  const token = useFragmentToken();
  return (
    <section className="shell">
      <p className="kicker">Acceso</p>
      <h1>Entrando con tu enlace</h1>
      <p>{token === null ? "Este enlace no es válido o está incompleto. Pide uno nuevo." : "Estamos validando tu enlace de acceso."}</p>
    </section>
  );
}
