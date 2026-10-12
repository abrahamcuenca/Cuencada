import { TREE_LINK_NOTE_MAX_LENGTH, type PersonSummary } from "@cuencada/types";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { getApiErrorMessage, isAbortError } from "../../../shared/api/errors";
import { Button } from "../../../shared/ui/Button";
import { Dialog } from "../../../shared/ui/Dialog";
import { Field } from "../../../shared/ui/Field";
import { TextArea } from "../../../shared/ui/TextArea";
import { useToast } from "../../../shared/ui/Toast";
import { PersonSearch } from "../components/PersonSearch";
import { displayName } from "../lib/tree";
import { useCreateProposalMutation } from "./api";
import { CONNECT_ROLE_LABELS, type ConnectRole, connectProposal } from "./labels";
import styles from "./oneTree.module.css";

/** Which proposal the dialog makes. */
export type ProposeMode = "same_person" | "relate";

/** Props for {@link ProposeDialog}. */
export interface ProposeDialogProps {
  /** The person on screen. */
  focus: { id: string; fullName: string };
  /** The kind, or `null` when closed. */
  mode: ProposeMode | null;
  onClose: () => void;
}

const TITLES: Record<ProposeMode, string> = {
  same_person: "Es la misma persona…",
  relate: "Conectar con…"
};

/**
 * "Es la misma persona…" / "Conectar con…" (WP-6.4): the member searches
 * the other person, picks the relation (for "Conectar"), adds an optional
 * note and sends a proposal. Nothing in the tree changes until an admin
 * approves it; the member follows it in "Mis propuestas".
 */
export function ProposeDialog({ focus, mode, onClose }: ProposeDialogProps): ReactNode {
  return (
    <Dialog
      open={mode !== null}
      onClose={onClose}
      title={mode === null ? "" : TITLES[mode]}
      description={
        mode === "same_person"
          ? `¿${focus.fullName} aparece dos veces en el árbol? Elige la otra copia.`
          : `¿Con quién está emparentado ${focus.fullName}?`
      }
    >
      {mode === null ? null : <ProposeBody key={`${focus.id}:${mode}`} focus={focus} mode={mode} onClose={onClose} />}
    </Dialog>
  );
}

function ProposeBody({ focus, mode, onClose }: ProposeDialogProps & { mode: ProposeMode }): ReactNode {
  const [other, setOther] = useState<PersonSummary | null>(null);
  const [role, setRole] = useState<ConnectRole>("parent");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [create, state] = useCreateProposalMutation();
  const toast = useToast();
  const roleName = useId();

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (other === null) {
      setError("Elige a la otra persona.");
      return;
    }
    const trimmed = note.trim();
    const body =
      mode === "same_person"
        ? // The picked person is the "real" copy: `to` is who an approval keeps by default.
          { kind: "same_person" as const, fromPersonId: focus.id, toPersonId: other.id }
        : { kind: "relate" as const, ...connectProposal(focus.id, other.id, role) };
    try {
      await create({ ...body, note: trimmed === "" ? null : trimmed }).unwrap();
      toast.show({ message: "Enviamos tu propuesta. Un administrador la revisará; síguela en «Mis propuestas».", tone: "success" });
      onClose();
    } catch (caught) {
      if (isAbortError(caught)) return;
      setError(getApiErrorMessage(caught));
    }
  };

  return (
    <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
      {other === null ? (
        <PersonSearch
          label="Buscar a la otra persona"
          actionLabel="Elegir a"
          autoFocus
          excludeIds={new Set([focus.id])}
          excludedReason="Es esta misma persona"
          onPick={(picked) => {
            setOther(picked);
            setError(null);
          }}
        />
      ) : (
        <div className={styles.picked}>
          <span className={styles.pickedName}>{displayName(other)}</span>
          <Button variant="ghost" size="sm" onClick={() => setOther(null)}>
            Cambiar
          </Button>
        </div>
      )}
      {mode === "relate" && other !== null ? (
        <fieldset className={styles.radios}>
          <legend>
            {other.fullName}, para {focus.fullName}:
          </legend>
          {(Object.keys(CONNECT_ROLE_LABELS) as ConnectRole[]).map((value) => (
            <label key={value} className={styles.radio}>
              <input type="radio" name={roleName} value={value} checked={role === value} onChange={() => setRole(value)} />
              {CONNECT_ROLE_LABELS[value]}
            </label>
          ))}
        </fieldset>
      ) : null}
      <Field label="Nota para el administrador" hint="¿Cómo lo sabes? Por ejemplo: «Es mi abuelo, el papá de mi mamá»." showOptional>
        {(control) => (
          <TextArea {...control} rows={3} maxLength={TREE_LINK_NOTE_MAX_LENGTH} value={note} onChange={(event) => setNote(event.target.value)} />
        )}
      </Field>
      {error !== null ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      <div className={styles.actions}>
        <Button type="submit" loading={state.isLoading} disabled={other === null}>
          Enviar propuesta
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}
