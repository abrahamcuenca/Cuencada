import { type ReactNode, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAppDispatch, useAppSelector } from "../../../app/hooks";
import { Button } from "../../../shared/ui/Button";
import { Spinner } from "../../../shared/ui/Spinner";
import { authApi, refreshCurrentUser } from "../api";
import styles from "../auth.module.css";
import { selectAuthStatus, selectCurrentUser } from "../authSlice";
import { AuthLayout } from "../components/AuthLayout";
import { FormAlert } from "../components/FormAlert";
import { SessionGateWaiting, useSessionGate } from "../components/SessionConflict";
import { ResendVerificationButton } from "../components/VerifyEmailBanner";
import { describeAuthError, LINK_INVALID_MESSAGE, LINK_MISSING_MESSAGE } from "../forms";
import { useConsumableFragmentToken } from "../useFragmentToken";

type VerifyState = { kind: "ready" } | { kind: "verifying" } | { kind: "verified" } | { kind: "failed"; message: string };

/** Shown once the email is confirmed. */
export const EMAIL_VERIFIED_MESSAGE = "¡Listo! Confirmamos tu correo electrónico.";

/**
 * `/verificar#t=…`: confirms an email address.
 *
 * [SEC] The token is used only after a tap ("Confirmar mi correo"), so a link
 * scanner cannot burn it. Verifying never creates or switches a session (the
 * API answers 204), so a logged-in user is not logged out: the page names the
 * current account and says the session will not change; if the token belongs
 * to another account, the server decides. When logged in, `GET /me` is
 * refetched so `emailVerified` and the banner update at once.
 */
export function VerifyEmailPage(): ReactNode {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const status = useAppSelector(selectAuthStatus);
  const user = useAppSelector(selectCurrentUser);
  const gate = useSessionGate();
  const { token, discard } = useConsumableFragmentToken();
  const started = useRef(false);
  const [state, setState] = useState<VerifyState>(() => (token === null ? { kind: "failed", message: LINK_MISSING_MESSAGE } : { kind: "ready" }));

  const verify = (): void => {
    if (token === null || started.current) return;
    started.current = true;
    setState({ kind: "verifying" });

    const run = async (): Promise<void> => {
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
    void run();
  };

  const loggedIn = status === "authenticated";

  if (state.kind === "verifying") {
    return (
      <AuthLayout title="Verificar correo" icon="✉️">
        <Spinner size="lg" label="Confirmando tu correo…" />
      </AuthLayout>
    );
  }

  if (state.kind === "failed") {
    const canResend = loggedIn && user?.emailVerified === false;
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

  if (state.kind === "verified") {
    return (
      <AuthLayout title="Correo verificado" icon="✅">
        <FormAlert tone="success" message={EMAIL_VERIFIED_MESSAGE} />
        <Button to={loggedIn ? "/" : "/entrar"} fullWidth size="lg">
          {loggedIn ? "Ir al inicio" : "Entrar"}
        </Button>
      </AuthLayout>
    );
  }

  if (gate === "waiting") return <SessionGateWaiting title="Verificar correo" />;

  return (
    <AuthLayout title="Verificar correo" icon="✉️" lead="Toca el botón para confirmar que este correo es tuyo.">
      {gate === "conflict" ? (
        <p className={styles.notice}>
          Tienes la sesión abierta como <strong translate="no">{user?.displayName ?? "otra cuenta"}</strong>. Confirmar este enlace no cambia
          tu sesión.
        </p>
      ) : null}
      <div className={styles.actions}>
        <Button fullWidth size="lg" onClick={verify}>
          Confirmar mi correo
        </Button>
        <Button
          variant="secondary"
          fullWidth
          onClick={() => {
            discard();
            void navigate("/", { replace: true });
          }}
        >
          Ahora no
        </Button>
      </div>
    </AuthLayout>
  );
}
