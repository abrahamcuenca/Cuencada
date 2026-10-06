import { type ReactNode, useEffect, useRef, useState } from "react";
import { useAppDispatch, useAppSelector } from "../../../app/hooks";
import { Button } from "../../../shared/ui/Button";
import { Spinner } from "../../../shared/ui/Spinner";
import { authApi, refreshCurrentUser } from "../api";
import { selectAuthStatus, selectCurrentUser } from "../authSlice";
import { AuthLayout } from "../components/AuthLayout";
import { FormAlert } from "../components/FormAlert";
import { ResendVerificationButton } from "../components/VerifyEmailBanner";
import { describeAuthError, LINK_INVALID_MESSAGE, LINK_MISSING_MESSAGE } from "../forms";
import { useConsumableFragmentToken } from "../useFragmentToken";

type VerifyState = { kind: "verifying" } | { kind: "verified" } | { kind: "failed"; message: string };

/** Shown once the email is confirmed. */
export const EMAIL_VERIFIED_MESSAGE = "¡Listo! Confirmamos tu correo electrónico.";

/**
 * `/verificar#t=…`: confirms the email address. Public (the link may be
 * opened on a device without a session). When logged in, `GET /me` is
 * refetched so `emailVerified` and the banner update at once.
 */
export function VerifyEmailPage(): ReactNode {
  const dispatch = useAppDispatch();
  const status = useAppSelector(selectAuthStatus);
  const user = useAppSelector(selectCurrentUser);
  const { token, discard } = useConsumableFragmentToken();
  const started = useRef(false);
  const [state, setState] = useState<VerifyState>(() =>
    token === null ? { kind: "failed", message: LINK_MISSING_MESSAGE } : { kind: "verifying" }
  );

  useEffect(() => {
    if (token === null || started.current) return;
    started.current = true;

    const verify = async (): Promise<void> => {
      try {
        await dispatch(authApi.endpoints.verifyEmail.initiate({ token }, { track: false })).unwrap();
        discard();
        setState({ kind: "verified" });
        dispatch(refreshCurrentUser());
      } catch (error) {
        discard();
        const message = describeAuthError(error, { TOKEN_INVALID: LINK_INVALID_MESSAGE, VALIDATION: LINK_INVALID_MESSAGE });
        if (message !== null) setState({ kind: "failed", message });
      }
    };
    void verify();
  }, [token, discard, dispatch]);

  if (state.kind === "verifying") {
    return (
      <AuthLayout title="Verificar correo" icon="✉️">
        <Spinner size="lg" label="Confirmando tu correo…" />
      </AuthLayout>
    );
  }

  const loggedIn = status === "authenticated";
  const canResend = loggedIn && user?.emailVerified === false;
  if (state.kind === "failed") {
    return (
      <AuthLayout title="Verificar correo" icon="✉️">
        <FormAlert message={state.message} />
        {canResend ? <ResendVerificationButton fullWidth /> : null}
        {loggedIn ? null : <p>Entra a tu cuenta para pedir otro enlace de verificación.</p>}
        <Button to={loggedIn ? "/" : "/entrar"} variant="secondary" fullWidth>
          {loggedIn ? "Ir al inicio" : "Entrar"}
        </Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Correo verificado" icon="✅">
      <FormAlert tone="success" message={EMAIL_VERIFIED_MESSAGE} />
      <Button to={loggedIn ? "/" : "/entrar"} fullWidth size="lg">
        {loggedIn ? "Ir al inicio" : "Entrar"}
      </Button>
    </AuthLayout>
  );
}
