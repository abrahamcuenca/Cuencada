import type { AdminInviteCandidate } from "@cuencada/types";
import { type ReactNode, useId, useState } from "react";
import { Button } from "../../../shared/ui/Button";
import { Spinner } from "../../../shared/ui/Spinner";
import { TextInput } from "../../../shared/ui/TextInput";
import { useDebouncedValue } from "../../family/lib/hooks";
import styles from "../admin.module.css";
import { useSearchInviteCandidatesQuery } from "../api";
import { candidateBlockedReason, describeCandidate, type InviteFormPerson } from "../lib/inviteForm";

/** Shortest query sent to the server (same as the tree's search). */
const SEARCH_MIN_CHARS = 2;
const SEARCH_LIMIT = 8;

/** Props for {@link InvitePersonPicker}. */
export interface InvitePersonPickerProps {
  /** The chosen person, or `null`. */
  value: InviteFormPerson | null;
  /** Called with the chosen candidate, or `null` to clear. */
  onChange: (person: AdminInviteCandidate | null) => void;
  error?: string | undefined;
}

/**
 * "Persona en el árbol" (WP-4.2): an optional, debounced search over living
 * people without an account (`GET /admin/invites/people`). Each result shows
 * nickname, birth year and branch so namesakes can be told apart; people with
 * a pending invite are listed but disabled. Same interaction as the tree's
 * `PersonSearch` (that one searches every person and shows no years).
 */
export function InvitePersonPicker({ value, onChange, error }: InvitePersonPickerProps): ReactNode {
  const [text, setText] = useState("");
  const q = useDebouncedValue(text.trim());
  const inputId = useId();
  const hintId = useId();
  const statusId = useId();
  const errorId = useId();
  const enabled = value === null && q.length >= SEARCH_MIN_CHARS;
  const result = useSearchInviteCandidatesQuery({ q, limit: SEARCH_LIMIT }, { skip: !enabled });
  const items = enabled ? (result.currentData?.items ?? []) : [];
  const pending = enabled && (result.isFetching || (result.currentData === undefined && result.error === undefined));

  if (value !== null) {
    return (
      <fieldset className={styles.personPicked}>
        <legend className={styles.navLabel}>Persona en el árbol</legend>
        <p className={styles.personPickedName}>{value.fullName}</p>
        <p className={styles.muted}>Al aceptar, su cuenta queda vinculada a esta persona. Le sugeriremos este nombre.</p>
        {error === undefined ? null : (
          <p className={styles.fieldError} role="alert">
            {error}
          </p>
        )}
        <Button size="sm" variant="secondary" onClick={() => onChange(null)}>
          Quitar persona
        </Button>
      </fieldset>
    );
  }

  let status = "";
  if (enabled && !pending) {
    if (result.error !== undefined) status = "No pudimos buscar. Inténtalo otra vez.";
    else if (items.length === 0) status = `No encontramos a nadie sin cuenta con «${q}».`;
    else status = items.length === 1 ? "1 resultado." : `${items.length} resultados.`;
  }

  return (
    <div className={styles.personPicker}>
      <label htmlFor={inputId} className={styles.navLabel}>
        Persona en el árbol <span className={styles.muted}>(opcional)</span>
      </label>
      <p id={hintId} className={styles.muted}>
        Solo personas vivas que aún no tienen cuenta.
      </p>
      <TextInput
        id={inputId}
        type="search"
        value={text}
        placeholder="Nombre, apodo o rama"
        autoComplete="off"
        enterKeyHint="search"
        maxLength={100}
        aria-describedby={[hintId, statusId, error === undefined ? null : errorId].filter(Boolean).join(" ")}
        aria-invalid={error === undefined ? undefined : true}
        onChange={(event) => setText(event.target.value)}
      />
      <p id={statusId} className={styles.muted} aria-live="polite">
        {pending ? (
          <>
            <Spinner size="inline" decorative /> Buscando…
          </>
        ) : (
          status
        )}
      </p>
      {error === undefined ? null : (
        <p id={errorId} className={styles.fieldError}>
          {error}
        </p>
      )}
      {items.length > 0 ? (
        <ul className={styles.personResults} aria-label="Personas encontradas">
          {items.map((candidate) => {
            const blocked = candidateBlockedReason(candidate);
            const details = describeCandidate(candidate);
            return (
              <li key={candidate.id}>
                <button
                  type="button"
                  className={styles.personResult}
                  disabled={blocked !== null}
                  aria-label={`Elegir a ${candidate.fullName}${details === "" ? "" : `, ${details}`}${blocked === null ? "" : ` (${blocked})`}`}
                  onClick={() => {
                    onChange(candidate);
                    setText("");
                  }}
                >
                  <span className={styles.personResultName}>{candidate.fullName}</span>
                  {details === "" ? null : <span className={styles.muted}>{details}</span>}
                  {blocked === null ? null : <span className={styles.personResultNote}>{blocked}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
