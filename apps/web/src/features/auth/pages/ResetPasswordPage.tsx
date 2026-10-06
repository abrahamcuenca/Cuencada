import { passwordResetConfirmInputSchema } from "@cuencada/types";
import { type FormEvent, type ReactNode, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAppDispatch, useAppSelector } from "../../../app/hooks";
import { Button } from "../../../shared/ui/Button";
import { Spinner } from "../../../shared/ui/Spinner";
import { useToast } from "../../../shared/ui/Toast";
import { authApi } from "../api";
import styles from "../auth.module.css";
import { loggedOut, selectAuthStatus } from "../authSlice";
import { broadcastLogout } from "../authSync";
import { SessionConflict, SessionGateWaiting, useSessionGate } from "../components/SessionConflict";
import { AuthLayout } from "../components/AuthLayout";
import { FormAlert } from "../components/FormAlert";
import { PasswordField } from "../components/PasswordField";
import {
  confirmError,
  describeAuthError,
  type FieldErrors,
  hasErrors,
  LINK_INVALID_MESSAGE,
  LINK_MISSING_MESSAGE,
  useFocusFirstInvalid,
  usePendingAction,
  validateForm
} from "../forms";
import { useConsumableFragmentToken } from "../useFragmentToken";

type ResetField = "newPassword" | "confirm";

/** Dead or missing reset link, with a way to ask for a new one. */
function ResetLinkInvalid({ message }: { message: string }): ReactNode {
  return (
    <AuthLayout title="Enlace no válido" icon="🔗">
      <FormAlert message={message} />
      <Button to="/recuperar" fullWidth size="lg">
        Pedir otro enlace
      </Button>
    </AuthLayout>
  );
}

/**
 * `/restablecer#t=…`: sets a new password with the reset token. The server
 * revokes every session (204), so the user then logs in. The token is
 * dropped from memory after success or once the server rejects it.
 */
export function ResetPasswordPage(): ReactNode {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const toast = useToast();
  const { token, discard } = useConsumableFragmentToken();
  const formRef = useRef<HTMLFormElement>(null);
  const focusInvalid = useFocusFirstInvalid(formRef);
  const { pending, run } = usePendingAction();
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<FieldErrors<ResetField>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [deadLink, setDeadLink] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const status = useAppSelector(selectAuthStatus);
  const gate = useSessionGate();

  if (done) {
    return (
      <AuthLayout title="Contraseña actualizada" icon="🔑">
        <Spinner size="lg" label="Te llevamos a Entrar…" />
      </AuthLayout>
    );
  }
  if (deadLink !== null) return <ResetLinkInvalid message={deadLink} />;
  if (token === null) return <ResetLinkInvalid message={LINK_MISSING_MESSAGE} />;
  // [SEC] Never reset another account's password from inside a live session without an explicit choice.
  if (gate === "waiting") return <SessionGateWaiting title="Nueva contraseña" />;
  if (gate === "conflict") {
    return <SessionConflict title="Nueva contraseña" action="cambiar la contraseña con este enlace" onLoggedOut={() => {}} onKeep={discard} />;
  }

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (pending) return;
    const validation = validateForm(passwordResetConfirmInputSchema, { token, newPassword });
    const nextErrors: FieldErrors<ResetField> = { newPassword: validation.errors.newPassword, confirm: confirmError(newPassword, confirm) };
    setErrors(nextErrors);
    setFormError(null);
    if (!validation.ok || hasErrors(nextErrors)) {
      focusInvalid();
      return;
    }
    const body = validation.data;
    void run(async () => {
      try {
        await dispatch(authApi.endpoints.confirmPasswordReset.initiate(body, { track: false })).unwrap();
        setDone(true);
        discard();
        // The server revoked every session, including this tab's (and the other tabs').
        if (status === "authenticated") {
          dispatch(loggedOut());
          broadcastLogout();
        }
        toast.show({ message: "Contraseña actualizada. Ya puedes entrar.", tone: "success" });
        void navigate("/entrar", { replace: true });
      } catch (error) {
        const message = describeAuthError(error, { TOKEN_INVALID: LINK_INVALID_MESSAGE });
        if (message === LINK_INVALID_MESSAGE) {
          discard();
          setDeadLink(message);
          return;
        }
        setFormError(message);
      }
    });
  };

  return (
    <AuthLayout title="Nueva contraseña" icon="🔑" lead="Crea una contraseña nueva para tu cuenta. Cerraremos tus sesiones abiertas por seguridad.">
      <form ref={formRef} className={styles.form} noValidate onSubmit={onSubmit}>
        <PasswordField label="Nueva contraseña" name="newPassword" autoComplete="new-password" showStrength value={newPassword} onChange={setNewPassword} error={errors.newPassword} />
        <PasswordField label="Confirma tu contraseña" toggleNoun="confirmación" name="confirm" autoComplete="new-password" value={confirm} onChange={setConfirm} error={errors.confirm} />
        <FormAlert message={formError} />
        <div className={styles.actions}>
          <Button type="submit" fullWidth size="lg" loading={pending}>
            Guardar contraseña
          </Button>
        </div>
      </form>
    </AuthLayout>
  );
}
