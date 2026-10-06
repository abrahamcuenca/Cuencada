import type { ReactNode } from "react";
import { useFragmentToken } from "../useFragmentToken";

/** `/invitacion#t=…`: placeholder until T1 builds the real page. The token is scrubbed from the URL on load. */
export function InvitePage(): ReactNode {
  const token = useFragmentToken();
  return (
    <section className="shell">
      <p className="kicker">Invitación</p>
      <h1>Únete a la familia</h1>
      <p>{token === null ? "Este enlace no es válido o está incompleto. Pide uno nuevo." : "Crea tu cuenta con la invitación que recibiste."}</p>
    </section>
  );
}
