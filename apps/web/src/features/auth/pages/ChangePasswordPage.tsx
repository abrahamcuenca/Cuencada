import { changePasswordInputSchema } from "@cuencada/types";
import { type FormEvent, type ReactNode, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAppDispatch, useAppSelector } from "../../../app/hooks";
import { getApiErrorCode, parseApiError } from "../../../shared/api/errors";
import { reportUnexpected } from "../../../shared/lib/reportUnexpected";
import { Button } from "../../../shared/ui/Button";
import { useToast } from "../../../shared/ui/Toast";
import { authApi } from "../api";
import styles from "../auth.module.css";
import { credentialsReceived, selectPasswordChangeRequired } from "../authSlice";
import { AuthLayout } from "../components/AuthLayout";
import { FormAlert } from "../components/FormAlert";
import { PasswordField } from "../components/PasswordField";
import {
  confirmError,
  describeAuthError,
  type FieldErrors,
  hasErrors,
  useFocusFirstInvalid,
  usePendingAction,
  validateForm
} from "../forms";
import { LOGIN_PATH } from "../guards";
import { redirectPathFromState } from "../redirect";
import { logout } from "../session";

type ChangeField = "currentPassword" | "newPassword" | "confirm";

/** The current password is wrong. */
export const WRONG_CURRENT_PASSWORD_MESSAGE = "La contraseña actual no es correcta.";

/**
 * Whether the server rejected the current password. WP-0.4 answers 400
 * `VALIDATION` with a `details` entry on `currentPassword`; 401
 * `INVALID_CREDENTIALS` is accepted too, defensively. Neither logs the user
 * out: the base query only does that for 401 `UNAUTHENTICATED`.
 */
function isWrongCurrentPassword(error: unknown): boolean {
  const code = getApiErrorCode(error);
  if (code === "INVALID_CREDENTIALS") return true;
  if (code !== "VALIDATION") return false;
  return (parseApiError(error)?.error.details ?? []).some((detail) => detail.path === "currentPassword");
}

/**
 * `/cambiar-contrasena`: the forced change for temporary passwords
 * (`mustChangePassword`) and the voluntary change.
 *
 * The server answers with a new `AuthTokenResponse` (this session rotated,
 * every other session revoked). Dispatching `credentialsReceived` updates the
 * token and clears `passwordChangeRequired`, which lifts the router gate.
 * During the forced change the only other way out is "Cerrar sesión".
 */
export function ChangePasswordPage(): ReactNode {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const forced = useAppSelector(selectPasswordChangeRequired);
  const formRef = useRef<HTMLFormElement>(null);
  const focusInvalid = useFocusFirstInvalid(formRef);
  const { pending, run } = usePendingAction();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<FieldErrors<ChangeField>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (pending) return;
    const validation = validateForm(changePasswordInputSchema, { currentPassword, newPassword });
    const nextErrors: FieldErrors<ChangeField> = { ...validation.errors, confirm: confirmError(newPassword, confirm) };
    setErrors(nextErrors);
    setFormError(null);
    if (!validation.ok || hasErrors(nextErrors)) {
      focusInvalid();
      return;
    }
    const body = validation.data;
    void run(async () => {
      try {
        const response = await dispatch(authApi.endpoints.changePassword.initiate(body, { track: false })).unwrap();
        setCurrentPassword("");
        setNewPassword("");
        setConfirm("");
        dispatch(credentialsReceived({ accessToken: response.accessToken, user: response.user }));
        toast.show({ message: "Contraseña actualizada. Cerramos tus otras sesiones.", tone: "success" });
        void navigate(redirectPathFromState(location.state), { replace: true });
      } catch (error) {
        if (isWrongCurrentPassword(error)) {
          setErrors({ currentPassword: WRONG_CURRENT_PASSWORD_MESSAGE });
          focusInvalid();
          return;
        }
        setFormError(describeAuthError(error));
      }
    });
  };

  const onLogout = (): void => {
    dispatch(logout())
      .then(() => navigate(LOGIN_PATH, { replace: true }))
      .catch(reportUnexpected);
  };

  return (
    <AuthLayout
      title={forced ? "Cambia tu contraseña" : "Cambiar contraseña"}
      icon="🔐"
      lead={
        forced
          ? "Por seguridad, crea una contraseña nueva antes de continuar."
          : "Al guardar, cerraremos tu sesión en los demás dispositivos."
      }
    >
      <form ref={formRef} className={styles.form} noValidate onSubmit={onSubmit}>
        <PasswordField
          label={forced ? "Contraseña temporal" : "Contraseña actual"}
          name="currentPassword"
          autoComplete="current-password"
          value={currentPassword}
          onChange={setCurrentPassword}
          error={errors.currentPassword}
          toggleNoun={forced ? "contraseña temporal" : "contraseña actual"}
        />
        <PasswordField label="Nueva contraseña" name="newPassword" autoComplete="new-password" showStrength value={newPassword} onChange={setNewPassword} error={errors.newPassword} />
        <PasswordField label="Confirma la nueva" toggleNoun="confirmación" name="confirm" autoComplete="new-password" value={confirm} onChange={setConfirm} error={errors.confirm} />
        <FormAlert message={formError} />
        <div className={styles.actions}>
          <Button type="submit" fullWidth size="lg" loading={pending}>
            {forced ? "Guardar y continuar" : "Guardar contraseña"}
          </Button>
          {forced ? (
            <Button variant="secondary" fullWidth disabled={pending} onClick={onLogout}>
              Cerrar sesión
            </Button>
          ) : null}
        </div>
      </form>
    </AuthLayout>
  );
}
