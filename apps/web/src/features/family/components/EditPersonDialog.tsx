import { type PersonDetails, memberUpdatePersonInputSchema } from "@cuencada/types";
import { type FormEvent, type ReactNode, useState } from "react";
import { isAbortError } from "../../../shared/api/errors";
import { Button } from "../../../shared/ui/Button";
import { Dialog } from "../../../shared/ui/Dialog";
import { useToast } from "../../../shared/ui/Toast";
import { useUpdatePersonMutation } from "../admin/api";
import { useUpdateFamilyPersonMutation } from "../api";
import styles from "../family.module.css";
import { type FieldErrors, issuesToFieldErrors, serverErrorToFieldErrors } from "../lib/forms";
import { PERSON_FIELD_NAMES, type PersonFormValues, changedPersonFields, personValues } from "../lib/personForm";
import { PersonFields } from "./PersonFields";

/** Props for {@link EditPersonDialog}. */
export interface EditPersonDialogProps {
  person: PersonDetails;
  open: boolean;
  isAdmin: boolean;
  /** Sheet title; defaults to "Editar a {name}". */
  title?: string;
  onClose: () => void;
}

/**
 * "Editar": a bottom sheet with the person's data. Sends only the changed
 * fields (`PATCH /family/people/:id`, or the admin route for admins); the
 * server re-checks the circle and the merged dates.
 */
export function EditPersonDialog({ person, open, isAdmin, title, onClose }: EditPersonDialogProps): ReactNode {
  const [values, setValues] = useState<PersonFormValues>(() => personValues(person));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [updateMember, memberState] = useUpdateFamilyPersonMutation();
  const [updateAdmin, adminState] = useUpdatePersonMutation();
  const toast = useToast();

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const patch = changedPersonFields(person, values);
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    const parsed = memberUpdatePersonInputSchema.safeParse(patch);
    if (!parsed.success) {
      setErrors(issuesToFieldErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    try {
      if (isAdmin) await updateAdmin({ id: person.id, patch }).unwrap();
      else await updateMember({ id: person.id, patch }).unwrap();
      toast.show({ message: "Guardamos los cambios.", tone: "success" });
      onClose();
    } catch (error) {
      if (isAbortError(error)) return;
      setErrors(serverErrorToFieldErrors(error, "No pudimos guardar los cambios. Inténtalo otra vez.", PERSON_FIELD_NAMES));
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={title ?? `Editar a ${person.fullName}`}>
      <form className={styles.form} noValidate onSubmit={(event) => void submit(event)}>
        <PersonFields values={values} errors={errors} onChange={setValues} />
        {errors._form ? (
          <p role="alert" className={styles.formError}>
            {errors._form}
          </p>
        ) : null}
        <div className={styles.formActions}>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" loading={memberState.isLoading || adminState.isLoading}>
            Guardar
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
