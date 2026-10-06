import { type Person, type SelfEditPersonRequest, selfEditPersonInputSchema } from "@cuencada/types";
import { type FormEvent, type ReactNode, useState } from "react";
import { isAbortError } from "../../../shared/api/errors";
import { Button } from "../../../shared/ui/Button";
import { Dialog } from "../../../shared/ui/Dialog";
import { Field } from "../../../shared/ui/Field";
import { TextInput } from "../../../shared/ui/TextInput";
import { useToast } from "../../../shared/ui/Toast";
import { useUpdateMyPersonMutation } from "../api";
import styles from "../family.module.css";
import { type FieldErrors, issuesToFieldErrors, serverErrorToFieldErrors, toNullableText, toNullableYear } from "../lib/forms";

/** The only fields `PATCH /family/me` accepts (`selfEditPersonInputSchema`). */
export const SELF_EDIT_FIELDS = ["nickname", "familyBranch", "birthYear"] as const;
type SelfEditField = (typeof SELF_EDIT_FIELDS)[number];
type Values = Record<SelfEditField, string>;

function initialValues(person: Person): Values {
  return {
    nickname: person.nickname ?? "",
    familyBranch: person.familyBranch ?? "",
    birthYear: person.birthYear === null ? "" : String(person.birthYear)
  };
}

/** Only the fields that changed, so the PATCH never rewrites what the member did not touch. */
function changedFields(person: Person, values: Values): SelfEditPersonRequest {
  const body: SelfEditPersonRequest = {};
  const nickname = toNullableText(values.nickname);
  if (nickname !== person.nickname) body.nickname = nickname;
  const familyBranch = toNullableText(values.familyBranch);
  if (familyBranch !== person.familyBranch) body.familyBranch = familyBranch;
  const birthYear = toNullableYear(values.birthYear);
  if (birthYear !== person.birthYear) body.birthYear = birthYear;
  return body;
}

/** Props for {@link SelfEditDialog}. */
export interface SelfEditDialogProps {
  person: Person;
  open: boolean;
  onClose: () => void;
}

/**
 * "Editar mis datos": a member edits the limited fields of their own node
 * (apodo, rama, año de nacimiento). Name, death and relationships stay
 * with the admins, and the server enforces that.
 */
export function SelfEditDialog({ person, open, onClose }: SelfEditDialogProps): ReactNode {
  const [values, setValues] = useState<Values>(() => initialValues(person));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [update, { isLoading }] = useUpdateMyPersonMutation();
  const toast = useToast();

  const setField = (name: SelfEditField, value: string): void => setValues((current) => ({ ...current, [name]: value }));

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const body = changedFields(person, values);
    if (Object.keys(body).length === 0) {
      onClose();
      return;
    }
    const parsed = selfEditPersonInputSchema.safeParse(body);
    if (!parsed.success) {
      setErrors(issuesToFieldErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    try {
      await update(body).unwrap();
      toast.show({ message: "Guardamos tus datos.", tone: "success" });
      onClose();
    } catch (error) {
      if (isAbortError(error)) return;
      setErrors(serverErrorToFieldErrors(error, "No pudimos guardar tus datos. Inténtalo otra vez.", SELF_EDIT_FIELDS));
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Editar mis datos" description="Tu nombre, tus fechas y tus relaciones los corrige un administrador.">
      <form className={styles.form} noValidate onSubmit={(event) => void submit(event)}>
        <Field label="Apodo" error={errors.nickname} showOptional>
          {(control) => (
            <TextInput
              {...control}
              value={values.nickname}
              maxLength={80}
              autoComplete="nickname"
              onChange={(e) => setField("nickname", e.target.value)}
            />
          )}
        </Field>
        <Field label="Rama familiar" hint="Por ejemplo, Herrera Navarro." error={errors.familyBranch} showOptional>
          {(control) => (
            <TextInput {...control} value={values.familyBranch} maxLength={120} onChange={(e) => setField("familyBranch", e.target.value)} />
          )}
        </Field>
        <Field label="Año de nacimiento" error={errors.birthYear} showOptional>
          {(control) => (
            <TextInput
              {...control}
              value={values.birthYear}
              inputMode="numeric"
              maxLength={4}
              autoComplete="bday-year"
              onChange={(e) => setField("birthYear", e.target.value)}
            />
          )}
        </Field>
        {errors._form ? (
          <p role="alert" className={styles.formError}>
            {errors._form}
          </p>
        ) : null}
        <div className={styles.formActions}>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" loading={isLoading}>
            Guardar
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
