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
  /** Text under the "no access" title; defaults to "ask an administrator". */
  forbiddenDescription?: ReactNode;
  /** Action under the "no access" state (e.g. a link home); none by default (retrying a 403 cannot succeed). */
  forbiddenAction?: ReactNode;
  /** Heading level of the title (1 when the state is the whole page, 3 inside a section). Defaults to 2. */
  headingLevel?: 1 | 2 | 3;
}

/**
 * Full-width 403 state shared by member-only screens: "verify your email"
 * with the resend button, or a generic "no access" (never a retry loop:
 * retrying a 403 cannot succeed).
 */
export function AccessDeniedState({
  denial,
  verifyTitle,
  forbiddenTitle,
  verifyDescription,
  forbiddenDescription,
  forbiddenAction,
  headingLevel = 2
}: AccessDeniedStateProps): ReactNode {
  if (denial === "unverified") {
    return (
      <EmptyState
        tone="lock"
        icon="✉️"
        headingLevel={headingLevel}
        title={verifyTitle}
        description={verifyDescription ?? "Abre el enlace que te enviamos por correo para confirmar que eres tú; si no lo encuentras, pide otro."}
        action={<ResendVerificationButton />}
      />
    );
  }
  return (
    <EmptyState
      tone="lock"
      icon="🔒"
      headingLevel={headingLevel}
      title={forbiddenTitle}
      description={forbiddenDescription ?? "Si crees que es un error, pídele ayuda a un administrador."}
      {...(forbiddenAction === undefined ? {} : { action: forbiddenAction })}
    />
  );
}
