import { type ReactNode, useEffect, useState } from "react";
import { useAppSelector } from "../../../app/hooks";
import { Button } from "../../../shared/ui/Button";
import { useToast } from "../../../shared/ui/Toast";
import { useRequestEmailVerificationMutation } from "../api";
import styles from "../auth.module.css";
import { selectAuthStatus, selectCurrentUser } from "../authSlice";
import { describeAuthError } from "../forms";

/** Toast after a verification email was requested. */
export const VERIFICATION_SENT_MESSAGE = "Te enviamos un enlace nuevo. Revisa tu correo (y la carpeta de spam).";

/** Client cooldown after a successful resend (Security L2). The server rate limit is the real control. */
export const RESEND_COOLDOWN_MS = 60_000;

// Shared by every resend button (banner and /verificar), so remounting does not reset it.
let cooldownUntil = 0;

/** Clears the resend cooldown (tests). */
export function resetResendCooldown(): void {
  cooldownUntil = 0;
}

/**
 * @param ms - Remaining milliseconds.
 * @returns e.g. "0:59".
 */
function formatCountdown(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Re-renders every second while a cooldown runs; returns the remaining ms (0 when none). */
function useCooldownRemaining(): [number, () => void] {
  const [now, setNow] = useState(() => Date.now());
  const remaining = Math.max(0, cooldownUntil - now);

  useEffect(() => {
    if (remaining <= 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [remaining]);

  const start = (): void => {
    cooldownUntil = Date.now() + RESEND_COOLDOWN_MS;
    setNow(Date.now());
  };
  return [remaining, start];
}

/** Props for {@link ResendVerificationButton}. */
export interface ResendVerificationButtonProps {
  fullWidth?: boolean;
}

/**
 * Asks the server for a new verification email (`POST /auth/email/verify-request`).
 * Disabled while pending and for {@link RESEND_COOLDOWN_MS} after a success,
 * with a visible countdown ("Reenviar en 0:59").
 */
export function ResendVerificationButton({ fullWidth = false }: ResendVerificationButtonProps): ReactNode {
  const toast = useToast();
  const [request, { isLoading }] = useRequestEmailVerificationMutation();
  const [remaining, startCooldown] = useCooldownRemaining();

  const onClick = (): void => {
    if (isLoading || remaining > 0) return;
    request()
      .unwrap()
      .then(() => {
        startCooldown();
        toast.show({ message: VERIFICATION_SENT_MESSAGE, tone: "success" });
      })
      .catch((error: unknown) => {
        const message = describeAuthError(error);
        if (message !== null) toast.show({ message, tone: "danger" });
      });
  };

  return (
    <Button variant="secondary" size="sm" fullWidth={fullWidth} loading={isLoading} disabled={remaining > 0} onClick={onClick}>
      {remaining > 0 ? `Reenviar en ${formatCountdown(remaining)}` : "Reenviar enlace"}
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
