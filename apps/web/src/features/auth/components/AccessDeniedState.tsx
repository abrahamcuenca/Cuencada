import type { ReactNode } from "react";
import { EmptyState } from "../../../shared/ui/EmptyState";
import type { AccessDenial } from "../accessDenied";
import { ResendVerificationButton } from "./VerifyEmailBanner";

/** Props for {@link AccessDeniedState}. */
export interface AccessDeniedStateProps {
  /** From `useAccessDenial` / `classifyAccessDenial`. */
  denial: AccessDenial;
  /** Title when the email isn't verified, e.g. "Verifica tu correo para ver el álbum". */
  verifyTitle: string;
  /** Title for any other 403, e.g. "No tienes acceso al álbum". */
  forbiddenTitle: string;
  /** Why verification is needed; a generic sentence by default. */
  verifyDescription?: ReactNode;
}

/**
 * Full-width 403 state shared by member-only screens: "verify your email"
 * with the resend button, or a generic "no access" (never a retry loop:
 * retrying a 403 cannot succeed).
 */
export function AccessDeniedState({ denial, verifyTitle, forbiddenTitle, verifyDescription }: AccessDeniedStateProps): ReactNode {
  if (denial === "unverified") {
    return (
      <EmptyState
        tone="lock"
        icon="✉️"
        title={verifyTitle}
        description={verifyDescription ?? "Abre el enlace que te enviamos por correo para confirmar que eres tú; si no lo encuentras, pide otro."}
        action={<ResendVerificationButton />}
      />
    );
  }
  return <EmptyState tone="lock" icon="🔒" title={forbiddenTitle} description="Si crees que es un error, pídele ayuda a un administrador." />;
}
