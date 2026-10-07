import type { ReactNode } from "react";
import { Button } from "../../../shared/ui/Button";
import { AccessDeniedState } from "./AccessDeniedState";

/** Title of the screen a logged-in non-admin sees on `/admin/*`. */
export const ADMIN_RESTRICTED_TITLE = "Acceso restringido";
/** Why the admin console is closed to them. */
export const ADMIN_RESTRICTED_DESCRIPTION = "Esta sección es solo para administradores.";

/**
 * `/admin/*` for a logged-in member without the admin role: says so, with a
 * way home, instead of silently redirecting (which looked like a dead link).
 * Built on {@link AccessDeniedState} like every other "no access" state.
 *
 * UX only [SEC]: the server refuses every `/api/admin/*` call for non-admins.
 */
export function AdminRestricted(): ReactNode {
  return (
    <section className="shell">
      <AccessDeniedState
        denial="forbidden"
        headingLevel={1}
        verifyTitle={ADMIN_RESTRICTED_TITLE}
        forbiddenTitle={ADMIN_RESTRICTED_TITLE}
        forbiddenDescription={ADMIN_RESTRICTED_DESCRIPTION}
        forbiddenAction={<Button to="/">Volver al inicio</Button>}
      />
    </section>
  );
}
