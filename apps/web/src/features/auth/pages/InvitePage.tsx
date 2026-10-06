import { emailSchema, type InviteInspectResponse, inviteAcceptInputSchema, maskEmail } from "@cuencada/types";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAppDispatch } from "../../../app/hooks";
import { formatDate } from "../../../shared/lib/dates";
import { Button } from "../../../shared/ui/Button";
import { Field } from "../../../shared/ui/Field";
import { Spinner } from "../../../shared/ui/Spinner";
import { TextInput } from "../../../shared/ui/TextInput";
import { useToast } from "../../../shared/ui/Toast";
import { authApi } from "../api";
import styles from "../auth.module.css";
import { credentialsReceived } from "../authSlice";
import { AuthLayout } from "../components/AuthLayout";
import { FormAlert } from "../components/FormAlert";
import { PasswordField } from "../components/PasswordField";
import {
  breachedPasswordError,
  confirmError,
  describeAuthError,
  type FieldErrors,
  hasErrors,
  INVITE_INVALID_MESSAGE,
  LINK_MISSING_MESSAGE,
  useFocusFirstInvalid,
  usePendingAction,
  validateForm
} from "../forms";
import { SessionConflict, SessionGateWaiting, useSessionGate } from "../components/SessionConflict";
import { PORTAL_TIME_ZONE } from "../sessionDisplay";
import { useConsumableFragmentToken } from "../useFragmentToken";

type InviteField = "email" | "displayName" | "password" | "confirm";

type InspectState =
  | { kind: "loading" }
  | { kind: "ready"; invite: InviteInspectResponse }
  | { kind: "accepted" }
  | { kind: "invalid"; message: string };

/** Typed email does not match the masked address of an email-bound invite. */
export const INVITE_EMAIL_MISMATCH_MESSAGE = "Este no es el correo al que llegó la invitación. Escríbelo completo, tal como aparece en el correo.";
/** 400 `INVITE_INVALID` on accept for a bound invite: mismatch or dead invite, deliberately indistinguishable. */
export const INVITE_ACCEPT_REJECTED_MESSAGE =
  "No pudimos aceptar la invitación. Revisa que el correo sea exactamente al que te invitaron; si lo es, pide una invitación nueva.";
/** 409 `CONFLICT`: the email already has an account. */
export const INVITE_EMAIL_TAKEN_MESSAGE = "Ya existe una cuenta con ese correo. Entra con tu contraseña o recupérala.";

/**
 * Client-side hint only: does `email` produce the invite's mask? The server
 * still compares the full normalized address.
 */
function matchesMask(email: string, emailMasked: string): boolean {
  const parsed = emailSchema.safeParse(email);
  return parsed.success && maskEmail(parsed.data) === emailMasked;
}

/** The account form shown once the invite was inspected. */
/** Props of {@link AcceptInviteForm}. */
interface AcceptInviteFormProps {
  invite: InviteInspectResponse;
  token: string;
  /** The account exists and the session is in the store. */
  onAccepted: () => void;
  /** The server says the invite is dead. */
  onInvalid: (message: string) => void;
}

function AcceptInviteForm({ invite, token, onAccepted, onInvalid }: AcceptInviteFormProps): ReactNode {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const focusInvalid = useFocusFirstInvalid(formRef);
  const { pending, run } = usePendingAction();

  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState(invite.suggestedDisplayName ?? "");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<FieldErrors<InviteField>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (pending) return;
    const validation = validateForm(inviteAcceptInputSchema, { token, email, displayName, password });
    const nextErrors: FieldErrors<InviteField> = {
      email: validation.errors.email,
      displayName: validation.errors.displayName,
      password: validation.errors.password,
      confirm: confirmError(password, confirm)
    };
    if (nextErrors.email === undefined && invite.emailMasked !== null && !matchesMask(email, invite.emailMasked)) {
      nextErrors.email = INVITE_EMAIL_MISMATCH_MESSAGE;
    }
    setErrors(nextErrors);
    setFormError(null);
    if (!validation.ok || hasErrors(nextErrors)) {
      focusInvalid();
      return;
    }

    const body = validation.data;
    void run(async () => {
      try {
        const response = await dispatch(authApi.endpoints.acceptInvite.initiate(body, { track: false })).unwrap();
        dispatch(credentialsReceived({ accessToken: response.accessToken, user: response.user }));
        toast.show({ message: "¡Bienvenida/o a la familia!", tone: "success" });
        onAccepted();
        void navigate("/", { replace: true });
      } catch (error) {
        // The invite is not consumed by a breached password: stay on the form.
        const breached = breachedPasswordError(error, "password");
        if (breached !== undefined) {
          setErrors({ password: breached });
          focusInvalid();
          return;
        }
        const message = describeAuthError(error, {
          INVITE_INVALID: invite.emailMasked === null ? INVITE_INVALID_MESSAGE : INVITE_ACCEPT_REJECTED_MESSAGE,
          CONFLICT: INVITE_EMAIL_TAKEN_MESSAGE
        });
        if (message === null) return;
        // An open invite has no email to get wrong: INVITE_INVALID means it is dead.
        if (invite.emailMasked === null && message === INVITE_INVALID_MESSAGE) {
          onInvalid(message);
          return;
        }
        setFormError(message);
      }
    });
  };

  return (
    <form ref={formRef} className={styles.form} noValidate onSubmit={onSubmit}>
      <Field label="Nombre completo" hint="Así te verá la familia en el portal." error={errors.displayName} required>
        {(control) => (
          <TextInput
            {...control}
            name="displayName"
            type="text"
            autoComplete="name"
            autoCapitalize="words"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        )}
      </Field>
      <Field
        label="Correo electrónico"
        hint={invite.emailMasked === null ? "Será tu usuario para entrar." : "Escríbelo completo, tal como aparece en el correo de la invitación."}
        error={errors.email}
        required
      >
        {(control) => (
          <TextInput
            {...control}
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        )}
      </Field>
      <PasswordField label="Crea una contraseña" toggleNoun="contraseña nueva" name="password" autoComplete="new-password" showStrength value={password} onChange={setPassword} error={errors.password} />
      <PasswordField label="Confirma tu contraseña" toggleNoun="confirmación" name="confirm" autoComplete="new-password" value={confirm} onChange={setConfirm} error={errors.confirm} />
      <FormAlert message={formError} />
      {formError === INVITE_EMAIL_TAKEN_MESSAGE ? (
        <Link className={styles.link} to="/entrar">
          Ir a Entrar
        </Link>
      ) : null}
      <div className={styles.actions}>
        <Button type="submit" fullWidth size="lg" loading={pending}>
          Crear mi cuenta
        </Button>
      </div>
    </form>
  );
}

/**
 * `/invitacion#t=…`: inspects the invite, then creates the account and logs in.
 *
 * Only the **masked** bound email is ever shown; the invitee must type the
 * full address, which the server compares. The token is dropped from memory
 * after a successful accept or once the server says it is invalid.
 */
export function InvitePage(): ReactNode {
  const dispatch = useAppDispatch();
  const gate = useSessionGate();
  const { token, discard } = useConsumableFragmentToken();
  const started = useRef(false);
  const [state, setState] = useState<InspectState>(() =>
    token === null ? { kind: "invalid", message: LINK_MISSING_MESSAGE } : { kind: "loading" }
  );
  // Kept so the form can still accept after the hook state changes; cleared with `discard`.
  const tokenRef = useRef(token);

  useEffect(() => {
    if (token === null || started.current) return;
    started.current = true;

    const inspect = async (): Promise<void> => {
      try {
        const invite = await dispatch(authApi.endpoints.inspectInvite.initiate({ token }, { track: false })).unwrap();
        setState({ kind: "ready", invite });
      } catch (error) {
        const message = describeAuthError(error, { INVITE_INVALID: INVITE_INVALID_MESSAGE, VALIDATION: INVITE_INVALID_MESSAGE });
        if (message === null) return;
        if (message === INVITE_INVALID_MESSAGE) {
          tokenRef.current = null;
          discard();
        }
        setState({ kind: "invalid", message });
      }
    };
    void inspect();
  }, [token, discard, dispatch]);

  const end = (next: InspectState): void => {
    tokenRef.current = null;
    discard();
    setState(next);
  };

  if (state.kind === "loading" || state.kind === "accepted") {
    return (
      <AuthLayout title="Te invitaron a la Cuencada" icon="💌">
        <Spinner size="lg" label={state.kind === "loading" ? "Revisando tu invitación…" : "¡Listo! Te llevamos al inicio…"} />
      </AuthLayout>
    );
  }

  const currentToken = tokenRef.current;
  if (state.kind === "invalid" || currentToken === null) {
    return (
      <AuthLayout title="Invitación no válida" icon="💌">
        <FormAlert message={state.kind === "invalid" ? state.message : INVITE_INVALID_MESSAGE} />
        <p className={styles.note}>Si ya tienes cuenta, puedes entrar directamente.</p>
        <Button to="/entrar" variant="secondary" fullWidth>
          Ir a Entrar
        </Button>
      </AuthLayout>
    );
  }

  // [SEC] Accepting logs in as the new account: never while someone else is logged in (Security M1).
  if (gate === "waiting") return <SessionGateWaiting title="Te invitaron a la Cuencada" />;
  if (gate === "conflict") {
    return (
      <SessionConflict
        title="Te invitaron a la Cuencada"
        action="crear tu cuenta con esta invitación"
        onLoggedOut={() => {}}
        onKeep={() => {
          tokenRef.current = null;
          discard();
        }}
      />
    );
  }

  const { invite } = state;
  const inviter = invite.invitedByName ?? "La familia";
  return (
    <AuthLayout
      title="Te invitaron a la Cuencada"
      icon="💌"
      lead={`${inviter} te invitó a unirte al portal de la familia. La invitación vence el ${formatDate(invite.expiresAt, PORTAL_TIME_ZONE)}.`}
    >
      {invite.emailMasked !== null ? (
        <p className={styles.readonlyEmail}>
          Invitación para <span translate="no">{invite.emailMasked}</span>
        </p>
      ) : null}
      <AcceptInviteForm
        invite={invite}
        token={currentToken}
        onAccepted={() => end({ kind: "accepted" })}
        onInvalid={(message) => end({ kind: "invalid", message })}
      />
    </AuthLayout>
  );
}
