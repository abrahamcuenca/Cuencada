import type { ReactNode } from "react";
import { useAppSelector } from "../../../app/hooks";
import { Button } from "../../../shared/ui/Button";
import { useToast } from "../../../shared/ui/Toast";
import { useRequestEmailVerificationMutation } from "../api";
import styles from "../auth.module.css";
import { selectAuthStatus, selectCurrentUser } from "../authSlice";
import { describeAuthError } from "../forms";

/** Toast after a verification email was requested. */
export const VERIFICATION_SENT_MESSAGE = "Te enviamos un enlace nuevo. Revisa tu correo (y la carpeta de spam).";

/** Props for {@link ResendVerificationButton}. */
export interface ResendVerificationButtonProps {
  fullWidth?: boolean;
}

/**
 * Asks the server for a new verification email (`POST /auth/email/verify-request`).
 * Disabled while pending; reports the result in a toast.
 */
export function ResendVerificationButton({ fullWidth = false }: ResendVerificationButtonProps): ReactNode {
  const toast = useToast();
  const [request, { isLoading }] = useRequestEmailVerificationMutation();

  const onClick = (): void => {
    if (isLoading) return;
    request()
      .unwrap()
      .then(() => {
        toast.show({ message: VERIFICATION_SENT_MESSAGE, tone: "success" });
      })
      .catch((error: unknown) => {
        const message = describeAuthError(error);
        if (message !== null) toast.show({ message, tone: "danger" });
      });
  };

  return (
    <Button variant="secondary" size="sm" fullWidth={fullWidth} loading={isLoading} onClick={onClick}>
      Reenviar enlace
    </Button>
  );
}

/**
 * "Verifica tu correo" notice for logged-in users whose `emailVerified` is
 * false, with a resend action. Renders nothing otherwise. Meant for the
 * `PageShell` banner slot (see WP-T1-FE Requests).
 */
export function VerifyEmailBanner(): ReactNode {
  const status = useAppSelector(selectAuthStatus);
  const user = useAppSelector(selectCurrentUser);
  if (status !== "authenticated" || user === null || user.emailVerified) return null;

  return (
    <section className={styles.banner} aria-label="Verifica tu correo">
      <p className={styles.bannerText}>
        <span aria-hidden="true">✉️ </span>
        <strong>Verifica tu correo.</strong> Confirma que <span translate="no">{user.email}</span> es tuyo para poder recuperar tu cuenta.
      </p>
      <ResendVerificationButton />
    </section>
  );
}
