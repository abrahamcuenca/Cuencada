import { type ReactNode, useId, useState } from "react";
import { Button } from "../../../../shared/ui/Button";
import { TextInput } from "../../../../shared/ui/TextInput";
import familyStyles from "../../family.module.css";
import { useDebouncedValue } from "../../lib/hooks";
import styles from "../admin.module.css";
import { useSearchUsersForPersonLinkQuery } from "../api";

/** The account linked to a person. `label` is known only after picking it in this session. */
export interface LinkedAccount {
  userId: string;
  label: string | null;
}

/** Props for {@link UserLinkField}. */
export interface UserLinkFieldProps {
  /** The person being edited (`null` while creating). */
  personId: string | null;
  /** Their full name, used to look up the already linked account's name and email. */
  personName?: string | null;
  value: LinkedAccount | null;
  error?: string | undefined;
  onChange: (value: LinkedAccount | null) => void;
}

/**
 * "Nombre (correo)" of the account already linked to the person, found with
 * the admin users search by the person's name (`GET /admin/users` has no
 * by-id lookup; see the backlog).
 * `null` while loading or when the account's name differs from the person's.
 */
function useLinkedAccountLabel(value: LinkedAccount | null, personName: string | null): string | null {
  const q = personName?.trim().slice(0, 100) ?? "";
  const lookup = value !== null && value.label === null && q.length >= 2;
  const users = useSearchUsersForPersonLinkQuery({ q, limit: 25 }, { skip: !lookup });
  if (!lookup || value === null) return null;
  const match = users.currentData?.items.find((user) => user.id === value.userId);
  return match ? `${match.displayName} (${match.email})` : null;
}

/**
 * Links a person to a user account (`userId`, unique on the server: 409 if
 * that account already has a person). Accounts already linked to someone
 * else are shown but cannot be picked.
 */
export function UserLinkField({ personId, personName = null, value, error, onChange }: UserLinkFieldProps): ReactNode {
  const [picking, setPicking] = useState(false);
  const [text, setText] = useState("");
  const q = useDebouncedValue(text.trim());
  const inputId = useId();
  const errorId = useId();
  const enabled = picking && q.length >= 2;
  const users = useSearchUsersForPersonLinkQuery({ q, limit: 8 }, { skip: !enabled });
  const items = enabled ? (users.currentData?.items ?? []) : [];
  const linkedLabel = useLinkedAccountLabel(value, personName);

  return (
    <fieldset className={styles.linkBox} aria-describedby={error ? errorId : undefined}>
      <legend className={familyStyles.searchLabel}>Cuenta vinculada (opcional)</legend>
      {value === null ? (
        <p className={styles.muted}>Sin cuenta vinculada. Vincúlala para que la persona pueda editar sus datos.</p>
      ) : (
        <p>
          Vinculada a <strong>{value.label ?? linkedLabel ?? "una cuenta del portal"}</strong>.
        </p>
      )}
      <div className={styles.actions}>
        {picking ? null : (
          <Button variant="secondary" size="sm" onClick={() => setPicking(true)}>
            {value === null ? "Vincular cuenta" : "Cambiar cuenta"}
          </Button>
        )}
        {value === null ? null : (
          <Button variant="ghost" size="sm" onClick={() => onChange(null)}>
            Desvincular
          </Button>
        )}
      </div>
      {picking ? (
        <div className={familyStyles.search}>
          <label htmlFor={inputId} className={familyStyles.searchLabel}>
            Buscar cuenta por nombre o correo
          </label>
          <TextInput id={inputId} type="search" value={text} maxLength={100} autoComplete="off" onChange={(e) => setText(e.target.value)} />
          {enabled && users.error !== undefined ? <p className={familyStyles.searchStatus}>No pudimos buscar cuentas.</p> : null}
          {enabled && !users.isFetching && users.error === undefined && items.length === 0 ? (
            <p className={familyStyles.searchStatus}>No encontramos cuentas con «{q}».</p>
          ) : null}
          {items.length > 0 ? (
            <ul className={familyStyles.searchResults} aria-label="Cuentas">
              {items.map((user) => {
                const taken = user.personId !== null && user.personId !== personId;
                return (
                  <li key={user.id}>
                    <button
                      type="button"
                      className={familyStyles.searchResult}
                      disabled={taken}
                      onClick={() => {
                        onChange({
                          userId: user.id,
                          label: `${user.displayName} (${user.email})`
                        });
                        setPicking(false);
                        setText("");
                      }}
                    >
                      <span className={familyStyles.searchResultName}>
                        {user.displayName} · {user.email}
                      </span>
                      {taken ? <span className={familyStyles.searchResultNote}>Ya vinculada a otra persona</span> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
          <Button variant="ghost" size="sm" onClick={() => setPicking(false)}>
            Cancelar
          </Button>
        </div>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className={familyStyles.formError}>
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
