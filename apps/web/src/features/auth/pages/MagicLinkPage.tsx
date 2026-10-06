import { type ReactNode, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAppDispatch } from "../../../app/hooks";
import { Button } from "../../../shared/ui/Button";
import { Spinner } from "../../../shared/ui/Spinner";
import { authApi } from "../api";
import styles from "../auth.module.css";
import { credentialsReceived } from "../authSlice";
import { AuthLayout } from "../components/AuthLayout";
import { FormAlert } from "../components/FormAlert";
import { SessionConflict, SessionGateWaiting, useSessionGate } from "../components/SessionConflict";
import { describeAuthError, LINK_INVALID_MESSAGE, LINK_MISSING_MESSAGE } from "../forms";
import { CHANGE_PASSWORD_PATH } from "../guards";
import { DEFAULT_AFTER_LOGIN_PATH } from "../redirect";
import { useConsumableFragmentToken } from "../useFragmentToken";

type LinkState = { kind: "ready" } | { kind: "consuming" } | { kind: "success" } | { kind: "failed"; message: string };

/** Heading of the confirm step. */
export const MAGIC_LINK_TITLE = "Entrar a la Cuencada";

/**
 * `/entrar/enlace#t=…`: exchanges the magic-link token for a session.
 *
 * [SEC] Never on load (Security M1):
 * - anonymous visitors tap "Entrar" first, so a link scanner that runs
 *   JavaScript cannot burn the single-use token and the login is deliberate;
 * - a logged-in user sees the "ya tienes la sesión abierta" interstitial and
 *   must log out explicitly before the token is used, so a forwarded link can
 *   never silently switch accounts.
 * The token is dropped from memory after the POST, whatever the outcome.
 */
export function MagicLinkPage(): ReactNode {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const gate = useSessionGate();
  const { token, discard } = useConsumableFragmentToken();
  const started = useRef(false);
  const [state, setState] = useState<LinkState>(() => (token === null ? { kind: "failed", message: LINK_MISSING_MESSAGE } : { kind: "ready" }));

  const consume = (): void => {
    if (token === null || started.current) return;
    started.current = true;
    setState({ kind: "consuming" });

    const run = async (): Promise<void> => {
      try {
        const response = await dispatch(authApi.endpoints.consumeMagicLink.initiate({ token }, { track: false })).unwrap();
        discard();
        setState({ kind: "success" });
        dispatch(credentialsReceived({ accessToken: response.accessToken, user: response.user }));
        void navigate(response.user.mustChangePassword ? CHANGE_PASSWORD_PATH : DEFAULT_AFTER_LOGIN_PATH, { replace: true });
      } catch (error) {
        discard();
        const message = describeAuthError(error, { TOKEN_INVALID: LINK_INVALID_MESSAGE, VALIDATION: LINK_INVALID_MESSAGE });
        if (message !== null) setState({ kind: "failed", message });
      }
    };
    void run();
  };

  if (state.kind === "failed") {
    return (
      <AuthLayout title="No pudimos abrir tu enlace" icon="🔗">
        <FormAlert message={state.message} />
        <div className={styles.actions}>
          <Button to="/entrar" fullWidth size="lg">
            Pedir otro enlace
          </Button>
        </div>
      </AuthLayout>
    );
  }

  if (state.kind === "consuming" || state.kind === "success") {
    return (
      <AuthLayout title={state.kind === "success" ? "¡Listo!" : "Entrando…"}>
        <Spinner size="lg" label={state.kind === "success" ? "Sesión iniciada. Te llevamos al inicio…" : "Validando tu enlace…"} />
      </AuthLayout>
    );
  }

  if (gate === "waiting") return <SessionGateWaiting title={MAGIC_LINK_TITLE} />;
  if (gate === "conflict") {
    return <SessionConflict title={MAGIC_LINK_TITLE} action="entrar con este enlace" onLoggedOut={consume} onKeep={discard} />;
  }

  return (
    <AuthLayout title={MAGIC_LINK_TITLE} icon="🔑" lead="Toca el botón para entrar con el enlace que pediste. Solo funciona una vez.">
      <div className={styles.actions}>
        <Button fullWidth size="lg" onClick={consume}>
          Entrar
        </Button>
      </div>
      <p className={styles.note}>¿No pediste este enlace? Cierra esta página; nadie entrará a tu cuenta sin él.</p>
    </AuthLayout>
  );
}
