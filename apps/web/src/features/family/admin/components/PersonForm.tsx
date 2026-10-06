import { type CreatePersonRequest, type Person, type UpdatePersonRequest, createPersonInputSchema, updatePersonInputSchema } from "@cuencada/types";
import { type FormEvent, type ReactNode, useState } from "react";
import { Button } from "../../../../shared/ui/Button";
import { Checkbox } from "../../../../shared/ui/Checkbox";
import { Field } from "../../../../shared/ui/Field";
import { TextInput } from "../../../../shared/ui/TextInput";
import familyStyles from "../../family.module.css";
import { type FieldErrors, issuesToFieldErrors, toNullableText, toNullableYear } from "../../lib/forms";
import styles from "../admin.module.css";
import { type LinkedAccount, UserLinkField } from "./UserLinkField";

/** Every field the admin form edits (`createPersonInputSchema` / `updatePersonInputSchema`). */
export const PERSON_FORM_FIELDS = ["fullName", "nickname", "familyBranch", "birthYear", "deathYear", "deceased", "userId"] as const;

interface Values {
  fullName: string;
  nickname: string;
  familyBranch: string;
  birthYear: string;
  deathYear: string;
  deceased: boolean;
  account: LinkedAccount | null;
}

type TextKey = "fullName" | "nickname" | "familyBranch" | "birthYear" | "deathYear";

function initialValues(person: Person | null): Values {
  return {
    fullName: person?.fullName ?? "",
    nickname: person?.nickname ?? "",
    familyBranch: person?.familyBranch ?? "",
    birthYear: person?.birthYear == null ? "" : String(person.birthYear),
    deathYear: person?.deathYear == null ? "" : String(person.deathYear),
    deceased: person?.deceased ?? false,
    account: person?.userId == null ? null : { userId: person.userId, label: null }
  };
}

function toCreateBody(values: Values): CreatePersonRequest {
  return {
    fullName: values.fullName,
    nickname: toNullableText(values.nickname),
    familyBranch: toNullableText(values.familyBranch),
    birthYear: toNullableYear(values.birthYear),
    deathYear: toNullableYear(values.deathYear),
    // A death year implies the person died, even if the box was left unticked.
    deceased: values.deceased || toNullableYear(values.deathYear) !== null,
    userId: values.account?.userId ?? null
  };
}

/** Only the fields that changed, so two admins editing different fields don't overwrite each other. */
function toPatch(person: Person, values: Values): UpdatePersonRequest {
  const full = toCreateBody(values);
  const patch: UpdatePersonRequest = {};
  if (full.fullName.trim() !== person.fullName) patch.fullName = full.fullName;
  if (full.nickname !== person.nickname) patch.nickname = full.nickname ?? null;
  if (full.familyBranch !== person.familyBranch) patch.familyBranch = full.familyBranch ?? null;
  if (full.birthYear !== person.birthYear) patch.birthYear = full.birthYear ?? null;
  if (full.deathYear !== person.deathYear) patch.deathYear = full.deathYear ?? null;
  if (full.deceased !== person.deceased) patch.deceased = full.deceased ?? false;
  if (full.userId !== person.userId) patch.userId = full.userId ?? null;
  return patch;
}

/** What the form hands to its owner: a validated create body or patch. */
export type PersonFormSubmit = { mode: "create"; body: CreatePersonRequest } | { mode: "update"; patch: UpdatePersonRequest };

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
 * Create/edit a person: names, nickname, branch, years, deceased and the
 * linked account. Validated with the contract schemas before sending.
 */
export function PersonForm({ person, submitLabel, onSubmit, onCancel }: PersonFormProps): ReactNode {
  const [values, setValues] = useState<Values>(() => initialValues(person));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);

  const setText = (name: TextKey, value: string): void => setValues((current) => ({ ...current, [name]: value }));

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    let request: PersonFormSubmit;
    if (person === null) {
      const body = toCreateBody(values);
      const parsed = createPersonInputSchema.safeParse(body);
      if (!parsed.success) {
        setErrors(issuesToFieldErrors(parsed.error.issues));
        return;
      }
      request = { mode: "create", body };
    } else {
      const patch = toPatch(person, values);
      if (Object.keys(patch).length === 0) {
        setErrors({ _form: "No hay cambios que guardar." });
        return;
      }
      const parsed = updatePersonInputSchema.safeParse(patch);
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
      <Field label="Nombre completo" required error={errors.fullName}>
        {(control) => (
          <TextInput {...control} value={values.fullName} maxLength={200} autoComplete="off" onChange={(e) => setText("fullName", e.target.value)} />
        )}
      </Field>
      <div className={styles.grid2}>
        <Field label="Apodo" error={errors.nickname} showOptional>
          {(control) => (
            <TextInput {...control} value={values.nickname} maxLength={80} autoComplete="off" onChange={(e) => setText("nickname", e.target.value)} />
          )}
        </Field>
        <Field label="Rama familiar" error={errors.familyBranch} showOptional>
          {(control) => (
            <TextInput
              {...control}
              value={values.familyBranch}
              maxLength={120}
              autoComplete="off"
              onChange={(e) => setText("familyBranch", e.target.value)}
            />
          )}
        </Field>
        <Field label="Año de nacimiento" error={errors.birthYear} showOptional>
          {(control) => (
            <TextInput
              {...control}
              value={values.birthYear}
              inputMode="numeric"
              maxLength={4}
              onChange={(e) => setText("birthYear", e.target.value)}
            />
          )}
        </Field>
        <Field label="Año de fallecimiento" error={errors.deathYear} showOptional>
          {(control) => (
            <TextInput
              {...control}
              value={values.deathYear}
              inputMode="numeric"
              maxLength={4}
              onChange={(e) => setText("deathYear", e.target.value)}
            />
          )}
        </Field>
      </div>
      <Checkbox
        label="Ya falleció"
        hint="Márcalo aunque no sepas el año. En el árbol se muestra con «†»."
        checked={values.deceased}
        error={errors.deceased}
        onChange={(event) => {
          const { checked } = event.target;
          setValues((current) => ({ ...current, deceased: checked }));
        }}
      />
      <UserLinkField
        personId={person?.id ?? null}
        value={values.account}
        error={errors.userId}
        onChange={(account) => setValues((current) => ({ ...current, account }))}
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
