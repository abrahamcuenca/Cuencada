import { PERSON_BIO_MAX_LENGTH, PERSON_BIRTHPLACE_MAX_LENGTH } from "@cuencada/types";
import type { ReactNode } from "react";
import { Checkbox } from "../../../shared/ui/Checkbox";
import { Field } from "../../../shared/ui/Field";
import { TextArea } from "../../../shared/ui/TextArea";
import { TextInput } from "../../../shared/ui/TextInput";
import styles from "../family.module.css";
import type { FieldErrors } from "../lib/forms";
import { type PersonFormValues, type PersonTextField, editPersonField, setDeceased } from "../lib/personForm";

/** Props for {@link PersonFields}. */
export interface PersonFieldsProps {
  values: PersonFormValues;
  errors: FieldErrors;
  onChange: (values: PersonFormValues) => void;
  /** Focus the name field when the sheet opens. */
  autoFocusName?: boolean;
}

/**
 * The person's data, phone-first: name, nickname, branch; birth as a year
 * or a full date; "Ya falleció" reveals the death year/date; birthplace and
 * a short bio. Clearing a year clears its date (the year follows the date).
 */
export function PersonFields({ values, errors, onChange, autoFocusName = false }: PersonFieldsProps): ReactNode {
  const set = (field: PersonTextField, value: string): void => onChange(editPersonField(values, field, value));
  return (
    <>
      <Field label="Nombre completo" required error={errors.fullName}>
        {(control) => (
          <TextInput
            {...control}
            value={values.fullName}
            maxLength={200}
            autoComplete="off"
            autoFocus={autoFocusName}
            onChange={(event) => set("fullName", event.target.value)}
          />
        )}
      </Field>
      <div className={styles.fieldPair}>
        <Field label="Apodo" error={errors.nickname} showOptional>
          {(control) => (
            <TextInput {...control} value={values.nickname} maxLength={80} autoComplete="off" onChange={(event) => set("nickname", event.target.value)} />
          )}
        </Field>
        <Field label="Rama familiar" error={errors.familyBranch} showOptional>
          {(control) => (
            <TextInput
              {...control}
              value={values.familyBranch}
              maxLength={120}
              autoComplete="off"
              onChange={(event) => set("familyBranch", event.target.value)}
            />
          )}
        </Field>
      </div>
      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>Nacimiento</legend>
        <p className={styles.fieldsetHint}>Si no sabes la fecha exacta, escribe solo el año.</p>
        <div className={styles.fieldPair}>
          <Field label="Año de nacimiento" error={errors.birthYear} showOptional>
            {(control) => (
              <TextInput
                {...control}
                value={values.birthYear}
                inputMode="numeric"
                maxLength={4}
                onChange={(event) => set("birthYear", event.target.value)}
              />
            )}
          </Field>
          <Field label="Fecha de nacimiento" error={errors.birthDate} showOptional>
            {(control) => (
              <TextInput
                {...control}
                type="date"
                min="1800-01-01"
                max="2200-12-31"
                value={values.birthDate}
                onChange={(event) => set("birthDate", event.target.value)}
              />
            )}
          </Field>
        </div>
        <Field label="Lugar de nacimiento" error={errors.birthplace} showOptional>
          {(control) => (
            <TextInput
              {...control}
              value={values.birthplace}
              maxLength={PERSON_BIRTHPLACE_MAX_LENGTH}
              autoComplete="off"
              onChange={(event) => set("birthplace", event.target.value)}
            />
          )}
        </Field>
      </fieldset>
      <Checkbox
        label="Ya falleció"
        hint="Márcalo aunque no sepas el año. En el árbol se muestra con «†»."
        checked={values.deceased}
        error={errors.deceased}
        onChange={(event) => onChange(setDeceased(values, event.target.checked))}
      />
      {values.deceased ? (
        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>Fallecimiento</legend>
          <div className={styles.fieldPair}>
            <Field label="Año de fallecimiento" error={errors.deathYear} showOptional>
              {(control) => (
                <TextInput
                  {...control}
                  value={values.deathYear}
                  inputMode="numeric"
                  maxLength={4}
                  onChange={(event) => set("deathYear", event.target.value)}
                />
              )}
            </Field>
            <Field label="Fecha de fallecimiento" error={errors.deathDate} showOptional>
              {(control) => (
                <TextInput
                  {...control}
                  type="date"
                  min="1800-01-01"
                  max="2200-12-31"
                  value={values.deathDate}
                  onChange={(event) => set("deathDate", event.target.value)}
                />
              )}
            </Field>
          </div>
        </fieldset>
      ) : null}
      <Field label="Biografía" hint="Unas líneas: a qué se dedicó, dónde vivió…" error={errors.bio} showOptional>
        {(control) => (
          <TextArea {...control} value={values.bio} rows={3} maxLength={PERSON_BIO_MAX_LENGTH} onChange={(event) => set("bio", event.target.value)} />
        )}
      </Field>
    </>
  );
}
