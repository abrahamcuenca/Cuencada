import { passwordResetRequestInputSchema } from "@cuencada/types";
import { type FormEvent, type ReactNode, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAppDispatch } from "../../../app/hooks";
import { Button } from "../../../shared/ui/Button";
import { Field } from "../../../shared/ui/Field";
import { TextInput } from "../../../shared/ui/TextInput";
import { authApi } from "../api";
import styles from "../auth.module.css";
import { AuthLayout } from "../components/AuthLayout";
import { FormAlert } from "../components/FormAlert";
import { describeAuthError, EMAIL_MAY_BE_SLOW_HINT, type FieldErrors, useFocusFirstInvalid, usePendingAction, validateForm } from "../forms";

/** Generic confirmation: never reveals whether the email has an account. */
export const RESET_REQUESTED_MESSAGE = "Si el correo tiene cuenta, te enviamos un enlace para crear una contraseña nueva.";

/** `/recuperar`: asks for a password-reset email. The answer is always generic. */
export function ForgotPasswordPage(): ReactNode {
  const dispatch = useAppDispatch();
  const formRef = useRef<HTMLFormElement>(null);
  const focusInvalid = useFocusFirstInvalid(formRef);
  const { pending, run } = usePendingAction();
  const [email, setEmail] = useState("");
  const [errors, setErrors] = useState<FieldErrors<"email">>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (pending) return;
    const validation = validateForm(passwordResetRequestInputSchema, { email });
    setErrors(validation.errors);
    setFormError(null);
    if (!validation.ok) {
      focusInvalid();
      return;
    }
    void run(async () => {
      try {
        await dispatch(authApi.endpoints.requestPasswordReset.initiate(validation.data, { track: false })).unwrap();
        setSent(true);
      } catch (error) {
        setFormError(describeAuthError(error));
      }
    });
  };

  if (sent) {
    return (
      <AuthLayout title="Revisa tu correo" icon="📬">
        <FormAlert tone="success" message={RESET_REQUESTED_MESSAGE} />
        <p className={styles.note}>{EMAIL_MAY_BE_SLOW_HINT}</p>
        <Button variant="secondary" fullWidth onClick={() => setSent(false)}>
          Pedir otro enlace
        </Button>
        <Button to="/entrar" variant="ghost" fullWidth>
          Volver a Entrar
        </Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="¿Olvidaste tu contraseña?" lead="Escribe tu correo y te enviaremos un enlace para crear una nueva.">
      <form ref={formRef} className={styles.form} noValidate onSubmit={onSubmit}>
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
        <FormAlert message={formError} />
        <div className={styles.actions}>
          <Button type="submit" fullWidth size="lg" loading={pending}>
            Enviar enlace
          </Button>
        </div>
      </form>
      <Link className={styles.link} to="/entrar">
        Volver a Entrar
      </Link>
    </AuthLayout>
  );
}
