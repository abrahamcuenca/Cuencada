import {
  type AdminCreatePersonRequest,
  type MemberCreatePersonRequest,
  type PersonSummary,
  type RelateKind,
  type RelationshipKind,
  adminCreatePersonInputSchema,
  memberCreatePersonInputSchema
} from "@cuencada/types";
import { type FormEvent, type ReactNode, useState } from "react";
import { isAbortError } from "../../../shared/api/errors";
import { Button } from "../../../shared/ui/Button";
import { Dialog } from "../../../shared/ui/Dialog";
import { useToast } from "../../../shared/ui/Toast";
import { useCreatePersonMutation, useCreateRelationshipMutation } from "../admin/api";
import { relationshipErrorMessage } from "../admin/components/RelationshipManager";
import { useCreateFamilyPersonMutation } from "../api";
import styles from "../family.module.css";
import { type FieldErrors, issuesToFieldErrors, serverErrorToFieldErrors } from "../lib/forms";
import { PERSON_FIELD_NAMES, type PersonFormValues, emptyPersonValues, toPersonFields } from "../lib/personForm";
import { ADD_RELATIVE_LABELS, MEMBER_LINK_NOTE, type RelativeRole } from "./addRelative";
import { PersonFields } from "./PersonFields";
import { PersonSearch } from "./PersonSearch";

/** "The new person is … of the anchor" (`relateTo.kind`). */
const RELATE_KIND: Record<RelativeRole, RelateKind> = {
  parent: "parent_of",
  partner: "partner_of",
  child: "child_of"
};

/** The edge an admin creates when linking an existing person. */
function edgeFor(role: RelativeRole, anchorId: string, otherId: string): { kind: RelationshipKind; fromPersonId: string; toPersonId: string } {
  if (role === "parent") return { kind: "parent_of", fromPersonId: otherId, toPersonId: anchorId };
  if (role === "child") return { kind: "parent_of", fromPersonId: anchorId, toPersonId: otherId };
  return { kind: "partner_of", fromPersonId: anchorId, toPersonId: otherId };
}

/** Props for {@link AddRelativeDialog}. */
export interface AddRelativeDialogProps {
  /** The person the relative is added to. */
  anchor: { id: string; fullName: string };
  /** The group, or `null` when closed. */
  role: RelativeRole | null;
  /** Admins may also link someone already in the tree. */
  isAdmin: boolean;
  /** People already related (not offered in the admin search). */
  relatedIds: ReadonlySet<string>;
  onClose: () => void;
}

/**
 * One bottom sheet to add a parent, partner or child.
 *
 * - **Admins:** search the tree to link an existing person, **or** "Crear
 *   nueva persona", pre-filled with what they typed.
 * - **Members:** "Crear nueva persona" only (the server attaches it to
 *   someone in their own-family circle), with a note to ask an admin to
 *   connect people who are already in the tree.
 */
export function AddRelativeDialog({ anchor, role, isAdmin, relatedIds, onClose }: AddRelativeDialogProps): ReactNode {
  return (
    <Dialog
      open={role !== null}
      onClose={onClose}
      title={role === null ? "" : ADD_RELATIVE_LABELS[role]}
      description={`De ${anchor.fullName}.`}
    >
      {role === null ? null : (
        <AddRelativeBody key={`${anchor.id}:${role}`} anchor={anchor} role={role} isAdmin={isAdmin} relatedIds={relatedIds} onClose={onClose} />
      )}
    </Dialog>
  );
}

function AddRelativeBody({ anchor, role, isAdmin, relatedIds, onClose }: AddRelativeDialogProps & { role: RelativeRole }): ReactNode {
  const [mode, setMode] = useState<"search" | "create">(isAdmin ? "search" : "create");
  const [typed, setTyped] = useState("");
  const [values, setValues] = useState<PersonFormValues>(() => emptyPersonValues());
  const [errors, setErrors] = useState<FieldErrors>({});
  const [linkError, setLinkError] = useState<string | null>(null);
  const [createAdmin, adminState] = useCreatePersonMutation();
  const [createMember, memberState] = useCreateFamilyPersonMutation();
  const [link, linkState] = useCreateRelationshipMutation();
  const toast = useToast();

  const startCreate = (): void => {
    setValues(emptyPersonValues(typed.trim()));
    setErrors({});
    setMode("create");
  };

  const pick = async (other: PersonSummary): Promise<void> => {
    setLinkError(null);
    try {
      await link(edgeFor(role, anchor.id, other.id)).unwrap();
      toast.show({ message: `Agregamos a ${other.fullName}.`, tone: "success" });
      onClose();
    } catch (error) {
      if (!isAbortError(error)) setLinkError(relationshipErrorMessage(error));
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const relateTo = { personId: anchor.id, kind: RELATE_KIND[role] };
    const fields = toPersonFields(values);
    const body: MemberCreatePersonRequest | AdminCreatePersonRequest = { ...fields, relateTo };
    const parsed = (isAdmin ? adminCreatePersonInputSchema : memberCreatePersonInputSchema).safeParse(body);
    if (!parsed.success) {
      setErrors(issuesToFieldErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    try {
      const created = isAdmin ? await createAdmin(body).unwrap() : await createMember({ ...fields, relateTo }).unwrap();
      toast.show({ message: `Agregamos a ${created.fullName}.`, tone: "success" });
      onClose();
    } catch (error) {
      if (isAbortError(error)) return;
      setErrors(serverErrorToFieldErrors(error, "No pudimos agregar a la persona. Inténtalo otra vez.", PERSON_FIELD_NAMES));
    }
  };

  if (mode === "search") {
    return (
      <div className={styles.form}>
        <PersonSearch
          label="Buscar persona"
          actionLabel="Elegir a"
          excludeIds={relatedIds}
          excludedReason="Ya está relacionada"
          autoFocus
          clearOnPick={false}
          onQueryChange={setTyped}
          onPick={(other) => void pick(other)}
        />
        {linkState.isLoading ? <p className={styles.searchStatus}>Guardando…</p> : null}
        {linkError !== null ? (
          <p role="alert" className={styles.formError}>
            {linkError}
          </p>
        ) : null}
        <div className={styles.orDivider} aria-hidden="true">
          o
        </div>
        <Button variant="secondary" icon="+" onClick={startCreate}>
          Crear nueva persona
        </Button>
      </div>
    );
  }

  return (
    <form className={styles.form} noValidate onSubmit={(event) => void submit(event)}>
      {isAdmin ? null : <p className={styles.note}>{MEMBER_LINK_NOTE}</p>}
      <PersonFields values={values} errors={errors} onChange={setValues} autoFocusName />
      {errors._form ? (
        <p role="alert" className={styles.formError}>
          {errors._form}
        </p>
      ) : null}
      <div className={styles.formActions}>
        <Button variant="secondary" onClick={isAdmin ? () => setMode("search") : onClose}>
          {isAdmin ? "Volver a buscar" : "Cancelar"}
        </Button>
        <Button type="submit" loading={adminState.isLoading || memberState.isLoading}>
          Crear nueva persona
        </Button>
      </div>
    </form>
  );
}
