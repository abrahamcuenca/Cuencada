import type { AdminInviteCreated, UserRole } from "@cuencada/types";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { getApiErrorMessage, isAbortError } from "../../../shared/api/errors";
import { Button } from "../../../shared/ui/Button";
import { Field } from "../../../shared/ui/Field";
import { Select } from "../../../shared/ui/Select";
import { TextInput } from "../../../shared/ui/TextInput";
import styles from "../admin.module.css";
import { useCreateAdminInviteMutation } from "../api";
import {
  BOUND_INVITE_MAX_DAYS,
  INVITE_FORM_DEFAULTS,
  type InviteDelivery,
  type InviteFormErrors,
  type InviteFormValues,
  normalizeInviteForm,
  OPEN_INVITE_MAX_DAYS,
  OPEN_INVITE_MAX_USES,
  validateInviteForm
} from "../lib/inviteForm";
import { ROLE_LABEL } from "../lib/labels";
import { Notice } from "./common";

/** Props for {@link InviteForm}. */
export interface InviteFormProps {
  /** Called with the server's answer; `inviteUrl` is set only for copy-link invites. */
  onCreated: (created: AdminInviteCreated) => void;
  onCancel: () => void;
}

const ROLE_OPTIONS = [
  { value: "member", label: ROLE_LABEL.member },
  { value: "admin", label: ROLE_LABEL.admin }
] as const;

/**
 * Create-invite form. The contract schema validates before sending, so the
 * admin sees the same rules the server enforces: an admin invite needs an
 * email and goes by email; an open link allows ≤ 20 uses and ≤ 14 days.
 */
export function InviteForm({ onCreated, onCancel }: InviteFormProps): ReactNode {
  const [values, setValues] = useState<InviteFormValues>(INVITE_FORM_DEFAULTS);
  const [errors, setErrors] = useState<InviteFormErrors>({});
  const [create, { isLoading, reset }] = useCreateAdminInviteMutation();
  const groupId = useId();

  const update = (patch: Partial<InviteFormValues>): void => {
    setValues((current) => normalizeInviteForm({ ...current, ...patch }));
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const result = validateInviteForm(values);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    try {
      const created = await create(result.request).unwrap();
      // Drop the mutation result (it may hold the one-time URL) from the store right away.
      reset();
      onCreated(created);
    } catch (error) {
      if (isAbortError(error)) return;
      setErrors({ form: getApiErrorMessage(error) });
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
          onSelect={(delivery) => update({ delivery })}
        />
        <DeliveryOption
          name={groupId}
          value="link"
          checked={!byEmail}
          disabled={isAdmin}
          title="Enlace para compartir"
          hint={`Un enlace para el grupo de WhatsApp: hasta ${OPEN_INVITE_MAX_USES} personas y ${OPEN_INVITE_MAX_DAYS} días.`}
          onSelect={(delivery) => update({ delivery })}
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

      <Field label="Vence en (días)" hint={`Máximo ${maxDays} días.`} error={errors.expiresInDays} required>
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
