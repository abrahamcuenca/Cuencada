import { type TwoFactorSetup, twoFactorEnableInputSchema, twoFactorSetupInputSchema } from "@cuencada/types";
import { type FormEvent, type ReactNode, useState } from "react";
import { useAppDispatch } from "../../../app/hooks";
import { Button } from "../../../shared/ui/Button";
import { credentialsReceived } from "../authSlice";
import { FormAlert } from "../components/FormAlert";
import { PasswordField } from "../components/PasswordField";
import { describeAuthError, usePendingAction, validateForm } from "../forms";
import { twoFactorApi } from "./api";
import { CodeField, describeTwoFactorError } from "./fields";
import { RecoveryCodesPanel } from "./RecoveryCodesPanel";
import styles from "./twoFactor.module.css";

type Step =
  | { kind: "password" }
  | { kind: "scan"; setup: TwoFactorSetup }
  | { kind: "codes"; codes: string[] };

const STEP_LABELS = ["Contraseña", "Escanear", "Códigos"] as const;

function StepIndicator({ current }: { current: 0 | 1 | 2 }): ReactNode {
  return (
    <ol className={styles.steps} aria-label="Pasos">
      {STEP_LABELS.map((label, index) => (
        <li key={label} className={index === current ? styles.stepCurrent : undefined} aria-current={index === current ? "step" : undefined}>
          {index + 1}. {label}
        </li>
      ))}
    </ol>
  );
}

/** Props of {@link EnrollWizard}. */
export interface EnrollWizardProps {
  /** After "Ya los guardé". */
  onFinished: () => void;
  /** Optional "Cancelar" (not on the admin gate). */
  onCancel?: () => void;
}

/**
 * "Activar" wizard: current password → QR code and manual key → the first
 * code → the 10 recovery codes, shown once. On enable the server re-issues
 * the access token (the session now counts as verified); it replaces the
 * in-memory credentials right away.
 *
 * [SEC] The password, the secret and the codes stay in component state and
 * are sent with untracked mutations; nothing is cached or persisted.
 */
export function EnrollWizard({ onFinished, onCancel }: EnrollWizardProps): ReactNode {
  const dispatch = useAppDispatch();
  const [step, setStep] = useState<Step>({ kind: "password" });
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [formError, setFormError] = useState<string | null>(null);
  const action = usePendingAction();

  const onPassword = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const validation = validateForm(twoFactorSetupInputSchema, { currentPassword: password });
    setFormError(null);
    if (!validation.ok || password.length === 0) {
      setFieldError("Escribe tu contraseña.");
      return;
    }
    setFieldError(undefined);
    void action.run(async () => {
      try {
        const setup = await dispatch(twoFactorApi.endpoints.setupTwoFactor.initiate(validation.data, { track: false })).unwrap();
        setPassword("");
        setStep({ kind: "scan", setup });
      } catch (error) {
        setFormError(describeAuthError(error));
      }
    });
  };

  const onCode = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const validation = validateForm(twoFactorEnableInputSchema, { code });
    setFormError(null);
    if (!validation.ok) {
      setFieldError(validation.errors.code);
      return;
    }
    setFieldError(undefined);
    void action.run(async () => {
      try {
        const enabled = await dispatch(twoFactorApi.endpoints.enableTwoFactor.initiate(validation.data, { track: false })).unwrap();
        dispatch(credentialsReceived({ accessToken: enabled.accessToken, user: enabled.user }));
        setCode("");
        setStep({ kind: "codes", codes: enabled.recoveryCodes });
      } catch (error) {
        setFormError(describeTwoFactorError(error));
      }
    });
  };

  if (step.kind === "codes") {
    return (
      <div className={styles.section}>
        <StepIndicator current={2} />
        <p className={styles.muted}>¡Listo! La verificación en dos pasos está activada.</p>
        <RecoveryCodesPanel codes={step.codes} onDone={onFinished} />
      </div>
    );
  }

  if (step.kind === "scan") {
    return (
      <form className={styles.section} noValidate onSubmit={onCode}>
        <StepIndicator current={1} />
        <p className={styles.muted}>
          Abre tu app de autenticación (Google Authenticator, 1Password, Authy o la de tu teléfono), toca «Agregar» y escanea este código.
        </p>
        <img className={styles.qr} src={step.setup.qrSvgDataUri} alt="Código QR para tu app de autenticación" width={240} height={240} />
        <p className={styles.muted}>¿No puedes escanearlo? Escribe esta clave en la app (cuenta: {step.setup.accountName}):</p>
        <code className={styles.secret} aria-label="Clave para escribir a mano">
          {step.setup.manualKey}
        </code>
        <CodeField value={code} onChange={setCode} error={fieldError} hint="Escribe el código que muestra la app para confirmar." />
        <FormAlert message={formError} />
        <Button type="submit" fullWidth size="lg" loading={action.pending}>
          Activar
        </Button>
        {onCancel === undefined ? null : (
          <Button variant="ghost" fullWidth onClick={onCancel}>
            Cancelar
          </Button>
        )}
      </form>
    );
  }

  return (
    <form className={styles.section} noValidate onSubmit={onPassword}>
      <StepIndicator current={0} />
      <p className={styles.muted}>Por seguridad, confirma tu contraseña antes de empezar.</p>
      <PasswordField label="Contraseña actual" name="currentPassword" autoComplete="current-password" value={password} onChange={setPassword} error={fieldError} />
      <FormAlert message={formError} />
      <Button type="submit" fullWidth size="lg" loading={action.pending}>
        Continuar
      </Button>
      {onCancel === undefined ? null : (
        <Button variant="ghost" fullWidth onClick={onCancel}>
          Cancelar
        </Button>
      )}
    </form>
  );
}
