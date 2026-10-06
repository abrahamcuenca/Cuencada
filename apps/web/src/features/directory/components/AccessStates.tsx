import type { ReactNode } from "react";
import { useAppSelector } from "../../../app/hooks";
import { getApiErrorCode } from "../../../shared/api/errors";
import { Button } from "../../../shared/ui/Button";
import { EmptyState } from "../../../shared/ui/EmptyState";
import { selectCurrentUser } from "../../auth/authSlice";
import { ResendVerificationButton } from "../../auth/components/VerifyEmailBanner";
import styles from "../directory.module.css";

/** Title of the unverified-member state. */
export const VERIFY_TO_VIEW_TITLE = "Verifica tu correo para ver el directorio";

/**
 * Error state for the directory. A 403 for a member whose email is not
 * verified explains how to get in and offers the resend action; any other
 * 403 says access is closed; the rest offer a retry.
 */
export function DirectoryError({ error, onRetry }: { error: unknown; onRetry: () => void }): ReactNode {
  const user = useAppSelector(selectCurrentUser);
  const code = getApiErrorCode(error);

  if (code === "FORBIDDEN" && user?.emailVerified === false) {
    return (
      <EmptyState
        tone="lock"
        icon="✉️"
        title={VERIFY_TO_VIEW_TITLE}
        description={
          <>
            El directorio tiene datos de contacto de la familia. Abre el enlace que te enviamos a{" "}
            <span translate="no" className={styles.email}>
              {user.email}
            </span>{" "}
            para confirmar que eres tú.
          </>
        }
        action={<ResendVerificationButton />}
      />
    );
  }
  if (code === "FORBIDDEN") {
    return <EmptyState tone="lock" icon="🔒" title="No tienes acceso al directorio" description="Si crees que es un error, pídele ayuda a un administrador." />;
  }
  return (
    <EmptyState
      icon="📡"
      title="No pudimos cargar el directorio"
      description="Revisa tu conexión e inténtalo de nuevo."
      action={
        <Button variant="secondary" onClick={onRetry}>
          Reintentar
        </Button>
      }
    />
  );
}
