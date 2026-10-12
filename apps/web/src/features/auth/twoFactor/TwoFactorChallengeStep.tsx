import { type AuthTokenResponse, type TwoFactorChallenge, twoFactorVerifyInputSchema } from "@cuencada/types";
import { type FormEvent, type ReactNode, useState } from "react";
import { useAppDispatch } from "../../../app/hooks";
import { getApiErrorCode } from "../../../shared/api/errors";
import { Button } from "../../../shared/ui/Button";
import { Checkbox } from "../../../shared/ui/Checkbox";
import { FormAlert } from "../components/FormAlert";
import { usePendingAction, validateForm } from "../forms";
import { twoFactorApi } from "./api";
import { CodeField, describeTwoFactorError, RecoveryCodeField } from "./fields";
import styles from "./twoFactor.module.css";

/** Props of {@link TwoFactorChallengeStep}. */
export interface TwoFactorChallengeStepProps {
  /** From the login or magic-link response. Kept in memory only (never storage or the URL). */
  challenge: TwoFactorChallenge;
  /** The session the code unlocked. */
  onVerified: (response: AuthTokenResponse) => void;
  /** The challenge expired, was used up or burned: go back to the login form. */
  onRestart: () => void;
}

/**
 * The code step after a password or a magic link (WP-7): six digits from the
 * app, or a recovery code; "Confiar en este dispositivo 30 días" for members
 * (the server refuses it for administrators and says so with
 * `trustDeviceAllowed: false`).
 */
export function TwoFactorChallengeStep({ challenge, onVerified, onRestart }: TwoFactorChallengeStepProps): ReactNode {
  const dispatch = useAppDispatch();
  const [mode, setMode] = useState<"code" | "recovery">("code");
  const [code, setCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [trustDevice, setTrustDevice] = useState(false);
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [formError, setFormError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const action = usePendingAction();

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const base = { challengeToken: challenge.challengeToken, trustDevice: challenge.trustDeviceAllowed && trustDevice };
    const validation =
      mode === "code"
        ? validateForm(twoFactorVerifyInputSchema, { ...base, code })
        : validateForm(twoFactorVerifyInputSchema, { ...base, recoveryCode });
    setFormError(null);
    if (!validation.ok) {
      const errors: Partial<Record<string, string | undefined>> = validation.errors;
      setFieldError(errors.code ?? errors.recoveryCode ?? "Revisa el código.");
      return;
    }
    setFieldError(undefined);
    void action.run(async () => {
      try {
        const response = await dispatch(twoFactorApi.endpoints.verifyTwoFactor.initiate(validation.data, { track: false })).unwrap();
        setCode("");
        setRecoveryCode("");
        onVerified(response);
      } catch (error) {
        if (getApiErrorCode(error) === "TOKEN_INVALID") setExpired(true);
        setFormError(describeTwoFactorError(error));
      }
    });
  };

  if (expired) {
    return (
      <div className={styles.section}>
        <FormAlert message={formError} />
        <Button fullWidth size="lg" onClick={onRestart}>
          Volver a iniciar sesión
        </Button>
      </div>
    );
  }

  return (
    <form className={styles.section} noValidate onSubmit={onSubmit}>
      <p className={styles.muted}>
        {mode === "code"
          ? "Escribe el código de 6 números que muestra tu app de autenticación."
          : "Escribe uno de tus códigos de recuperación. Te avisaremos por correo que lo usaste."}
      </p>
      {mode === "code" ? (
        <CodeField value={code} onChange={setCode} error={fieldError} autoFocus />
      ) : (
        <RecoveryCodeField value={recoveryCode} onChange={setRecoveryCode} error={fieldError} />
      )}
      <button
        type="button"
        className={styles.linkButton}
        onClick={() => {
          setMode(mode === "code" ? "recovery" : "code");
          setFieldError(undefined);
          setFormError(null);
        }}
      >
        {mode === "code" ? "Usar un código de recuperación" : "Usar el código de mi app"}
      </button>
      {challenge.trustDeviceAllowed ? (
        <Checkbox
          label="Confiar en este dispositivo 30 días"
          hint="No te pediremos el código en este navegador. No lo actives en un dispositivo compartido."
          checked={trustDevice}
          onChange={(event) => setTrustDevice(event.target.checked)}
        />
      ) : null}
      <FormAlert message={formError} />
      <Button type="submit" fullWidth size="lg" loading={action.pending}>
        Verificar
      </Button>
      <Button variant="ghost" fullWidth onClick={onRestart}>
        Cancelar
      </Button>
    </form>
  );
}
