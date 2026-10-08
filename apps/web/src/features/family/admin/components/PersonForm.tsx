import {
  type AdminCreatePersonRequest,
  type AdminUpdatePersonRequest,
  type Person,
  adminCreatePersonInputSchema,
  adminUpdatePersonInputSchema
} from "@cuencada/types";
import { type FormEvent, type ReactNode, useState } from "react";
import { Button } from "../../../../shared/ui/Button";
import { PersonFields } from "../../components/PersonFields";
import familyStyles from "../../family.module.css";
import { type FieldErrors, issuesToFieldErrors } from "../../lib/forms";
import { PERSON_FIELD_NAMES, type PersonFormValues, changedPersonFields, emptyPersonValues, personValues, toPersonFields } from "../../lib/personForm";
import { type LinkedAccount, UserLinkField } from "./UserLinkField";

/** Every field the admin form edits (`adminCreatePersonInputSchema` / `adminUpdatePersonInputSchema`). */
export const PERSON_FORM_FIELDS = [...PERSON_FIELD_NAMES, "userId"] as const;

/** What the form hands to its owner: a validated create body or patch. */
export type PersonFormSubmit = { mode: "create"; body: AdminCreatePersonRequest } | { mode: "update"; patch: AdminUpdatePersonRequest };

/** Props for {@link PersonForm}. */
export interface PersonFormProps {
  /** `null` to create. */
  person: Person | null;
  submitLabel: string;
  /** Resolves with server field errors, or `null` on success. */
  onSubmit: (submit: PersonFormSubmit) => Promise<FieldErrors | null>;
  onCancel?: () => void;
}

/**
 * Create/edit a person (admins): name, nickname, branch, birth and death as
 * a year or a full date, birthplace, bio, "Ya falleció" and the linked
 * account. Validated with the contract schemas before sending; the server
 * re-checks the merged dates.
 */
export function PersonForm({ person, submitLabel, onSubmit, onCancel }: PersonFormProps): ReactNode {
  const [values, setValues] = useState<PersonFormValues>(() => (person === null ? emptyPersonValues() : personValues(person)));
  const [account, setAccount] = useState<LinkedAccount | null>(() =>
    person?.userId == null ? null : { userId: person.userId, label: null }
  );
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    let request: PersonFormSubmit;
    const userId = account?.userId ?? null;
    if (person === null) {
      const body: AdminCreatePersonRequest = { ...toPersonFields(values), userId };
      const parsed = adminCreatePersonInputSchema.safeParse(body);
      if (!parsed.success) {
        setErrors(issuesToFieldErrors(parsed.error.issues));
        return;
      }
      request = { mode: "create", body };
    } else {
      const patch: AdminUpdatePersonRequest = { ...changedPersonFields(person, values) };
      if (userId !== person.userId) patch.userId = userId;
      if (Object.keys(patch).length === 0) {
        setErrors({ _form: "No hay cambios que guardar." });
        return;
      }
      const parsed = adminUpdatePersonInputSchema.safeParse(patch);
      if (!parsed.success) {
        setErrors(issuesToFieldErrors(parsed.error.issues));
        return;
      }
      request = { mode: "update", patch };
    }
    setErrors({});
    setBusy(true);
    const serverErrors = await onSubmit(request);
    setBusy(false);
    if (serverErrors !== null) setErrors(serverErrors);
  };

  return (
    <form className={familyStyles.form} noValidate onSubmit={(event) => void submit(event)}>
      <PersonFields values={values} errors={errors} onChange={setValues} />
      <UserLinkField
        personId={person?.id ?? null}
        personName={person?.fullName ?? null}
        value={account}
        error={errors.userId}
        onChange={setAccount}
      />
      {errors._form ? (
        <p role="alert" className={familyStyles.formError}>
          {errors._form}
        </p>
      ) : null}
      <div className={familyStyles.formActions}>
        {onCancel ? (
          <Button variant="secondary" onClick={onCancel}>
            Cancelar
          </Button>
        ) : null}
        <Button type="submit" loading={busy}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
