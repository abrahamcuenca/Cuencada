import { loginInputSchema, magicLinkRequestInputSchema } from "@cuencada/types";
import { type FormEvent, type ReactNode, useRef, useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAppDispatch, useAppSelector } from "../../../app/hooks";
import { Button } from "../../../shared/ui/Button";
import { Field } from "../../../shared/ui/Field";
import { TextInput } from "../../../shared/ui/TextInput";
import { authApi } from "../api";
import styles from "../auth.module.css";
import { credentialsReceived, selectAuthStatus, selectPasswordChangeRequired } from "../authSlice";
import { AuthLayout } from "../components/AuthLayout";
import { FormAlert } from "../components/FormAlert";
import { PasswordField } from "../components/PasswordField";
import {
  describeAuthError,
  type FieldErrors,
  INVALID_CREDENTIALS_MESSAGE,
  useFocusFirstInvalid,
  usePendingAction,
  validateForm
} from "../forms";
import { CHANGE_PASSWORD_PATH } from "../guards";
import { redirectPathFromState } from "../redirect";

type LoginField = "email" | "password";

/** Shown after a magic-link request, whatever the server knows about the email. */
function MagicLinkSent({ email, onReset }: { email: string; onReset: () => void }): ReactNode {
  return (
    <div className={styles.notice}>
      <span className={styles.noticeIcon} aria-hidden="true">
        📬
      </span>
      <h2 className={styles.title}>Revisa tu correo</h2>
      <p>Si {email} tiene una cuenta, te enviamos un enlace para entrar. Caduca en unos minutos.</p>
      <Button variant="secondary" fullWidth onClick={onReset}>
        Usar otro correo
      </Button>
    </div>
  );
}

/**
 * `/entrar`: email + password, or a magic link to the same email.
 *
 * - Errors are generic (no account enumeration): wrong password and unknown
 *   email read the same, and the magic-link confirmation never says whether
 *   the account exists.
 * - On success the credentials go to the auth slice and the user is sent to
 *   the validated `state.from` (`redirectPathFromState`), or to
 *   `/cambiar-contrasena` when the password is temporary.
 * - The password is sent with an untracked mutation, so it never sits in the store.
 */
export function LoginPage(): ReactNode {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const location = useLocation();
  const status = useAppSelector(selectAuthStatus);
  const mustChange = useAppSelector(selectPasswordChangeRequired);
  const formRef = useRef<HTMLFormElement>(null);
  const focusInvalid = useFocusFirstInvalid(formRef);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<FieldErrors<LoginField>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const loginAction = usePendingAction();
  const linkAction = usePendingAction();
  const busy = loginAction.pending || linkAction.pending;

  const target = redirectPathFromState(location.state);

  if (status === "authenticated" && !loginAction.pending) {
    return <Navigate to={mustChange ? CHANGE_PASSWORD_PATH : target} replace />;
  }

  const onLogin = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (busy) return;
    const validation = validateForm(loginInputSchema, { email, password });
    setErrors(validation.errors);
    setFormError(null);
    if (!validation.ok) {
      focusInvalid();
      return;
    }

    void loginAction.run(async () => {
      try {
        const response = await dispatch(authApi.endpoints.login.initiate(validation.data, { track: false })).unwrap();
        setPassword("");
        dispatch(credentialsReceived({ accessToken: response.accessToken, user: response.user }));
        void navigate(response.user.mustChangePassword ? CHANGE_PASSWORD_PATH : target, { replace: true });
      } catch (error) {
        setFormError(describeAuthError(error, { INVALID_CREDENTIALS: INVALID_CREDENTIALS_MESSAGE }));
      }
    });
  };

  const onRequestLink = (): void => {
    if (busy) return;
    const validation = validateForm(magicLinkRequestInputSchema, { email });
    setErrors(validation.errors);
    setFormError(null);
    if (!validation.ok) {
      focusInvalid();
      return;
    }

    void linkAction.run(async () => {
      try {
        await dispatch(authApi.endpoints.requestMagicLink.initiate(validation.data, { track: false })).unwrap();
        setPassword("");
        setSentTo(validation.data.email);
      } catch (error) {
        setFormError(describeAuthError(error));
      }
    });
  };

  if (sentTo !== null) {
    return (
      <AuthLayout title="Entrar">
        <MagicLinkSent email={sentTo} onReset={() => setSentTo(null)} />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Entrar" lead="Entra al portal de la Cuencada con tu correo y contraseña, o pide un enlace para entrar sin contraseña.">
      <form ref={formRef} className={styles.form} noValidate onSubmit={onLogin}>
        <Field label="Correo electrónico" error={errors.email} required>
          {(control) => (
            <TextInput
              {...control}
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="nombre@correo.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          )}
        </Field>
        <PasswordField label="Contraseña" name="password" autoComplete="current-password" value={password} onChange={setPassword} error={errors.password} />
        <FormAlert message={formError} />
        <div className={styles.actions}>
          <Button type="submit" fullWidth size="lg" loading={loginAction.pending} disabled={busy}>
            Entrar
          </Button>
          <p className={styles.divider}>o</p>
          <Button variant="secondary" fullWidth loading={linkAction.pending} disabled={busy} onClick={onRequestLink}>
            Recibir enlace por correo
          </Button>
        </div>
      </form>
      <ul className={styles.links}>
        <li>
          <Link className={styles.link} to="/recuperar">
            ¿Olvidaste tu contraseña?
          </Link>
        </li>
      </ul>
      <p className={styles.note}>¿Recibiste una invitación? Ábrela desde tu correo para crear tu cuenta.</p>
    </AuthLayout>
  );
}
