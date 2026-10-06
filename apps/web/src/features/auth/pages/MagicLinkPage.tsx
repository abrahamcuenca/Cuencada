import { type ReactNode, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAppDispatch } from "../../../app/hooks";
import { Button } from "../../../shared/ui/Button";
import { Spinner } from "../../../shared/ui/Spinner";
import { authApi } from "../api";
import styles from "../auth.module.css";
import { credentialsReceived } from "../authSlice";
import { AuthLayout } from "../components/AuthLayout";
import { FormAlert } from "../components/FormAlert";
import { describeAuthError, LINK_INVALID_MESSAGE, LINK_MISSING_MESSAGE } from "../forms";
import { CHANGE_PASSWORD_PATH } from "../guards";
import { DEFAULT_AFTER_LOGIN_PATH } from "../redirect";
import { useConsumableFragmentToken } from "../useFragmentToken";

type ConsumeState = { kind: "consuming" } | { kind: "success" } | { kind: "failed"; message: string };

/**
 * `/entrar/enlace#t=…`: exchanges the magic-link token for a session.
 *
 * The token is POSTed once (a ref guards against StrictMode's double effect,
 * which would burn the single-use token and report a false failure), then
 * dropped from memory whatever the outcome.
 */
export function MagicLinkPage(): ReactNode {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const { token, discard } = useConsumableFragmentToken();
  const started = useRef(false);
  const [state, setState] = useState<ConsumeState>(() =>
    token === null ? { kind: "failed", message: LINK_MISSING_MESSAGE } : { kind: "consuming" }
  );

  useEffect(() => {
    if (token === null || started.current) return;
    started.current = true;

    const consume = async (): Promise<void> => {
      try {
        const response = await dispatch(authApi.endpoints.consumeMagicLink.initiate({ token }, { track: false })).unwrap();
        discard();
        dispatch(credentialsReceived({ accessToken: response.accessToken, user: response.user }));
        setState({ kind: "success" });
        void navigate(response.user.mustChangePassword ? CHANGE_PASSWORD_PATH : DEFAULT_AFTER_LOGIN_PATH, { replace: true });
      } catch (error) {
        discard();
        const message = describeAuthError(error, { TOKEN_INVALID: LINK_INVALID_MESSAGE, VALIDATION: LINK_INVALID_MESSAGE });
        if (message !== null) setState({ kind: "failed", message });
      }
    };
    void consume();
  }, [token, discard, dispatch, navigate]);

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

  return (
    <AuthLayout title={state.kind === "success" ? "¡Listo!" : "Entrando…"}>
      <Spinner size="lg" label={state.kind === "success" ? "Sesión iniciada. Te llevamos al inicio…" : "Validando tu enlace…"} />
    </AuthLayout>
  );
}
