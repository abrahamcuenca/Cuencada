import type { AdminInviteCreated, UserRole } from "@cuencada/types";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { getApiErrorMessage, isAbortError, parseApiError } from "../../../shared/api/errors";
import { Button } from "../../../shared/ui/Button";
import { Field } from "../../../shared/ui/Field";
import { Select } from "../../../shared/ui/Select";
import { TextInput } from "../../../shared/ui/TextInput";
import styles from "../admin.module.css";
import { useAppDispatch } from "../../../app/hooks";
import { adminApi } from "../api";
import {
  BOUND_INVITE_MAX_DAYS,
  changeInviteDelivery,
  INVITE_FORM_DEFAULTS,
  type InviteDelivery,
  type InviteFormErrors,
  type InviteFormPerson,
  type InviteFormValues,
  normalizeInviteForm,
  OPEN_INVITE_PERSON_NOTE,
  OPEN_INVITE_MAX_DAYS,
  OPEN_INVITE_MAX_HOURS,
  OPEN_INVITE_MAX_USES,
  OPEN_INVITE_SECURITY_HELP,
  validateInviteForm
} from "../lib/inviteForm";
import { ROLE_LABEL } from "../lib/labels";
import { Notice } from "./common";
import { InvitePersonPicker } from "./InvitePersonPicker";

/** Props for {@link InviteForm}. */
export interface InviteFormProps {
  /** Called with the server's answer; `inviteUrl` is set only for copy-link invites. */
  onCreated: (created: AdminInviteCreated) => void;
  onCancel: () => void;
  /** Pre-chosen tree person (the "Invitar" button on a person page): an email invite for them. */
  initialPerson?: InviteFormPerson | null;
}

const ROLE_OPTIONS = [
  { value: "member", label: ROLE_LABEL.member },
  { value: "admin", label: ROLE_LABEL.admin }
] as const;

/**
 * Create-invite form. The contract schema validates before sending, so the
 * admin sees the same rules the server enforces: an admin invite needs an
 * email and goes by email; an open link allows ≤ 10 uses and ≤ 72 hours
 * (defaults 5 uses and 72 hours) and alerts the admins on every use.
 */
export function InviteForm({ onCreated, onCancel, initialPerson = null }: InviteFormProps): ReactNode {
  const [values, setValues] = useState<InviteFormValues>({ ...INVITE_FORM_DEFAULTS, person: initialPerson });
  const [errors, setErrors] = useState<InviteFormErrors>({});
  const dispatch = useAppDispatch();
  const [isLoading, setIsLoading] = useState(false);
  const groupId = useId();

  const update = (patch: Partial<InviteFormValues>): void => {
    setValues((current) => normalizeInviteForm({ ...current, ...patch }));
  };
  const selectDelivery = (delivery: InviteDelivery): void => {
    setValues((current) => normalizeInviteForm(changeInviteDelivery(current, delivery)));
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const result = validateInviteForm(values);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    setIsLoading(true);
    try {
      // [SEC] Untracked: the answer (it may hold the one-time URL) never enters the Redux store.
      const created = await dispatch(adminApi.endpoints.createAdminInvite.initiate(result.request, { track: false })).unwrap();
      onCreated(created);
    } catch (error) {
      if (isAbortError(error)) return;
      // WP-4.2: a refused person (deceased, linked, pending invite) is shown on the picker.
      const personIssue = parseApiError(error)?.error.details?.find((detail) => detail.path === "personId");
      setErrors(personIssue === undefined ? { form: getApiErrorMessage(error) } : { personId: personIssue.message });
    } finally {
      setIsLoading(false);
    }
  };

  const byEmail = values.delivery === "email";
  const isAdmin = values.role === "admin";
  const maxDays = byEmail ? BOUND_INVITE_MAX_DAYS : OPEN_INVITE_MAX_DAYS;

  return (
    <form noValidate onSubmit={(event) => void submit(event)} className={styles.formCard} aria-label="Nueva invitación">
      <Field
        label="Rol"
        hint={isAdmin ? "Las invitaciones de administrador solo se envían por correo y sirven una vez." : undefined}
      >
        {(control) => (
          <Select
            {...control}
            value={values.role}
            options={ROLE_OPTIONS}
            onChange={(event) => update({ role: event.target.value === "admin" ? "admin" : ("member" satisfies UserRole) })}
          />
        )}
      </Field>

      <fieldset className={styles.choice}>
        <legend>¿Cómo la vas a enviar?</legend>
        <DeliveryOption
          name={groupId}
          value="email"
          checked={byEmail}
          title="Por correo"
          hint="Le llega un correo con su enlace personal. Solo sirve para esa dirección."
          onSelect={selectDelivery}
        />
        <DeliveryOption
          name={groupId}
          value="link"
          checked={!byEmail}
          disabled={isAdmin}
          title="Enlace para compartir"
          hint={`Un enlace para el grupo de WhatsApp: hasta ${OPEN_INVITE_MAX_USES} personas y ${OPEN_INVITE_MAX_HOURS} horas.`}
          onSelect={selectDelivery}
        />
      </fieldset>

      {byEmail ? (
        <Field label="Correo" error={errors.email} required>
          {(control) => (
            <TextInput
              {...control}
              type="email"
              inputMode="email"
              autoComplete="off"
              maxLength={254}
              value={values.email}
              onChange={(event) => update({ email: event.target.value })}
            />
          )}
        </Field>
      ) : (
        <Field label="¿Cuántas personas pueden usarlo?" hint={`Máximo ${OPEN_INVITE_MAX_USES}.`} error={errors.maxUses} required>
          {(control) => (
            <TextInput
              {...control}
              type="number"
              inputMode="numeric"
              min={1}
              max={OPEN_INVITE_MAX_USES}
              value={values.maxUses}
              onChange={(event) => update({ maxUses: event.target.value })}
            />
          )}
        </Field>
      )}

      {byEmail ? (
        <InvitePersonPicker
          value={values.person}
          error={errors.personId}
          onChange={(person) => {
            setErrors(({ personId: _cleared, ...rest }) => rest);
            update({ person: person === null ? null : { id: person.id, fullName: person.fullName } });
          }}
        />
      ) : (
        <p className={styles.muted} role="note">
          {OPEN_INVITE_PERSON_NOTE}
        </p>
      )}

      <Field
        label="Vence en (días)"
        hint={byEmail ? `Máximo ${maxDays} días.` : `Máximo ${maxDays} días (${OPEN_INVITE_MAX_HOURS} horas).`}
        error={errors.expiresInDays}
        required
      >
        {(control) => (
          <TextInput
            {...control}
            type="number"
            inputMode="numeric"
            min={1}
            max={maxDays}
            value={values.expiresInDays}
            onChange={(event) => update({ expiresInDays: event.target.value })}
          />
        )}
      </Field>

      {byEmail ? null : (
        <p className={styles.securityNote} role="note">
          {OPEN_INVITE_SECURITY_HELP}
        </p>
      )}


      <Field label="Nota para el equipo" hint="Solo la ven los administradores." error={errors.note} showOptional>
        {(control) => (
          <TextInput {...control} maxLength={200} autoComplete="off" value={values.note} onChange={(event) => update({ note: event.target.value })} />
        )}
      </Field>

      <Notice message={errors.form ?? null} />

      <div className={styles.actions}>
        <Button variant="secondary" onClick={onCancel}>
          Cancelar
        </Button>
        <Button type="submit" loading={isLoading}>
          {byEmail ? "Enviar invitación" : "Crear enlace"}
        </Button>
      </div>
    </form>
  );
}

interface DeliveryOptionProps {
  name: string;
  value: InviteDelivery;
  checked: boolean;
  disabled?: boolean;
  title: string;
  hint: string;
  onSelect: (value: InviteDelivery) => void;
}

function DeliveryOption({ name, value, checked, disabled = false, title, hint, onSelect }: DeliveryOptionProps): ReactNode {
  const hintId = useId();
  return (
    <label className={styles.radio}>
      <input type="radio" name={name} value={value} checked={checked} disabled={disabled} aria-describedby={hintId} onChange={() => onSelect(value)} />
      <span className={styles.radioText}>
        <span className={styles.navLabel}>{title}</span>
        <span id={hintId} className={styles.muted}>
          {hint}
        </span>
      </span>
    </label>
  );
}
