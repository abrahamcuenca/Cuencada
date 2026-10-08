import { CONTACT_LABELS, type ContactKind, type OwnProfile } from "@cuencada/types";
import { type FormEvent, type ReactNode, useId, useMemo, useRef, useState } from "react";
import { getApiErrorCode, getApiErrorMessage, isAbortError } from "../../../shared/api/errors";
import { Button } from "../../../shared/ui/Button";
import { Checkbox, Switch } from "../../../shared/ui/Checkbox";
import { cx } from "../../../shared/ui/cx";
import { Field } from "../../../shared/ui/Field";
import { Select } from "../../../shared/ui/Select";
import { TextInput } from "../../../shared/ui/TextInput";
import { useToast } from "../../../shared/ui/Toast";
import { useUpdateContactsMutation } from "../api";
import {
  buildContactsPatch,
  CONTACT_FIELDS,
  type ContactFormErrors,
  type ContactFormValues,
  COUNTRY_CODES,
  composePhone,
  HANDLE_FIELDS,
  HANDLE_URL_ERROR,
  type HandleField,
  hasContactChanges,
  looksLikeProfileUrl,
  type PhoneParts,
  type StoredPhones,
  toContactFormValues,
  websiteWarning
} from "../lib/contactForm";
import { CONTACT_SECTION_ID } from "../paths";
import styles from "../profile.module.css";

/** Toast after the contacts are saved. */
export const CONTACTS_SAVED_MESSAGE = "Contacto guardado.";

/** Banner when the stored phone has no country code (legacy free-form value). */
export const PHONE_CONFIRM_TITLE = "Confirma tu teléfono con la lada de tu país";

const COUNTRY_OPTIONS = COUNTRY_CODES.map((country) => ({ value: country.code, label: country.label }));

/** Per-network hint under each handle field. */
const HANDLE_HINTS: Record<HandleField, string> = {
  instagram: "Solo tu usuario, por ejemplo prima.ejemplo.",
  facebook: "Lo que va después de facebook.com/, por ejemplo prima.ejemplo.",
  tiktok: "Solo tu usuario, por ejemplo prima_ejemplo.",
  linkedin: "Lo que va después de linkedin.com/in/, por ejemplo prima-ejemplo.",
  github: "Solo tu usuario, por ejemplo prima-ejemplo."
};

/** Props for {@link ContactSection}. */
export interface ContactSectionProps {
  profile: OwnProfile;
}

/**
 * "Mi perfil" → "Contacto" (WP-4.4): email switch, phone with a country
 * picker (default +52), WhatsApp ("Usar mi teléfono"), social handles and a
 * website, each with its own "Mostrar a la familia" switch (default off).
 * Saves only what changed through `PATCH /api/profile/me/contacts`.
 */
export function ContactSection({ profile }: ContactSectionProps): ReactNode {
  const toast = useToast();
  const titleId = useId();
  const [updateContacts, { isLoading: saving }] = useUpdateContactsMutation();
  const [draft, setDraft] = useState<ContactFormValues | null>(null);
  const [errors, setErrors] = useState<ContactFormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const submitting = useRef(false);

  const baseline = useMemo(() => toContactFormValues(profile), [profile]);
  const values = draft ?? baseline;
  const stored: StoredPhones = { phone: profile.phone, whatsapp: profile.contacts?.whatsapp ?? null };
  const dirty = hasContactChanges(baseline, values, stored);

  const update = (next: Partial<ContactFormValues>, clear: readonly string[] = []): void => {
    setDraft({ ...values, ...next });
    if (clear.some((field) => field in errors)) {
      setErrors((current) => {
        const copy: Record<string, string | undefined> = { ...current };
        for (const field of clear) delete copy[field];
        return copy;
      });
    }
  };
  const setVisible = (kind: ContactKind, visible: boolean): void => update({ visibility: { ...values.visibility, [kind]: visible } });

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (submitting.current) return;
    setFormError(null);
    const result = buildContactsPatch(baseline, values, stored);
    if (!result.ok) {
      setErrors(result.errors);
      const first = CONTACT_FIELDS.find((field) => result.errors[field] !== undefined);
      if (first) formRef.current?.querySelector<HTMLElement>(`[name="${first}"]`)?.focus();
      return;
    }
    setErrors({});
    if (result.patch === null) return;
    submitting.current = true;
    updateContacts(result.patch)
      .unwrap()
      .then(() => {
        setDraft(null);
        toast.show({ message: CONTACTS_SAVED_MESSAGE, tone: "success" });
      })
      .catch((cause: unknown) => {
        if (isAbortError(cause)) return;
        setFormError(
          getApiErrorCode(cause) === "RATE_LIMITED" ? "Demasiados intentos. Espera unos minutos y vuelve a intentarlo." : getApiErrorMessage(cause)
        );
      })
      .finally(() => {
        submitting.current = false;
      });
  };

  const visibilitySwitch = (kind: ContactKind): ReactNode => (
    <Switch
      name={`visible-${kind}`}
      label="Mostrar a la familia"
      // Nine switches share the visible label: the accessible name says which contact (label-in-name kept).
      aria-label={`Mostrar a la familia (${CONTACT_LABELS[kind]})`}
      checked={values.visibility[kind]}
      onChange={(event) => setVisible(kind, event.target.checked)}
    />
  );

  const whatsappFromPhone = composePhone(values.phone);
  const site = websiteWarning(values.website);

  return (
    <form
      ref={formRef}
      id={CONTACT_SECTION_ID}
      className={cx(styles.form, styles.contactForm)}
      noValidate
      onSubmit={onSubmit}
      aria-labelledby={titleId}
    >
      {/* Focus target of /perfil#contacto (useScrollToSection). */}
      <h2 id={titleId} className={styles.sectionTitle} tabIndex={-1} data-section-heading>
        Contacto
      </h2>
      <p className={styles.sectionHint}>
        Lo que actives lo podrán ver todos los familiares con cuenta verificada, en el directorio y en el árbol. Nadie más lo ve. Todo empieza
        oculto: enciende "Mostrar a la familia" en cada dato que quieras compartir.
      </p>

      {profile.phoneNeedsConfirmation === true ? (
        <div className={styles.banner}>
          <p className={styles.bannerTitle}>{PHONE_CONFIRM_TITLE}</p>
          <p className={styles.bannerText}>
            Tu teléfono está guardado sin lada, así que la familia no puede llamarte ni escribirte desde el directorio. Revisa el país y guarda.
          </p>
        </div>
      ) : null}

      <div className={styles.contactCard}>
        <p className={styles.contactLabel}>Correo</p>
        <p className={styles.contactValue} translate="no">
          {profile.email}
        </p>
        {visibilitySwitch("email")}
      </div>

      <div className={styles.contactCard}>
        <PhoneField
          name="phone"
          label="Teléfono"
          hint="Elige el país y escribe tu número."
          parts={values.phone}
          error={errors.phone}
          onChange={(phone) => update({ phone }, ["phone", ...(values.whatsappSameAsPhone ? ["whatsapp"] : [])])}
        />
        {visibilitySwitch("phone")}
      </div>

      <div className={styles.contactCard}>
        <p className={styles.contactLabel}>WhatsApp</p>
        <Checkbox
          name="whatsappSameAsPhone"
          label="Usar mi teléfono"
          hint={values.whatsappSameAsPhone ? (whatsappFromPhone ?? "Escribe tu teléfono arriba.") : undefined}
          checked={values.whatsappSameAsPhone}
          onChange={(event) =>
            update(
              {
                whatsappSameAsPhone: event.target.checked,
                // Pre-fill from the phone when switching to a separate number.
                whatsapp: !event.target.checked && values.whatsapp.number.trim() === "" ? values.phone : values.whatsapp
              },
              ["whatsapp"]
            )
          }
        />
        {values.whatsappSameAsPhone ? (
          errors.whatsapp !== undefined ? (
            <p className={styles.fieldError}>
              <span aria-hidden="true">⚠️ </span>
              {errors.whatsapp}
            </p>
          ) : null
        ) : (
          <PhoneField
            name="whatsapp"
            label="Número de WhatsApp"
            parts={values.whatsapp}
            error={errors.whatsapp}
            onChange={(whatsapp) => update({ whatsapp }, ["whatsapp"])}
          />
        )}
        {visibilitySwitch("whatsapp")}
      </div>

      {HANDLE_FIELDS.map((field) => {
        const live = looksLikeProfileUrl(values[field]) ? HANDLE_URL_ERROR : undefined;
        return (
          <div key={field} className={styles.contactCard}>
            <Field label={CONTACT_LABELS[field]} hint={HANDLE_HINTS[field]} error={errors[field] ?? live} showOptional>
              {(control) => (
                <div className={styles.handleWrap}>
                  <span aria-hidden="true" className={styles.handlePrefix}>
                    @
                  </span>
                  <TextInput
                    {...control}
                    name={field}
                    className={styles.handleInput}
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    maxLength={120}
                    value={values[field]}
                    onChange={(event) => update({ [field]: event.target.value }, [field])}
                  />
                </div>
              )}
            </Field>
            {visibilitySwitch(field)}
          </div>
        );
      })}

      <div className={styles.contactCard}>
        <Field
          label="Sitio web"
          hint={
            <>
              Una dirección que empiece con https://
              {site !== null ? <span className={styles.softWarning}> {site}</span> : null}
            </>
          }
          error={errors.website}
          showOptional
        >
          {(control) => (
            <TextInput
              {...control}
              name="website"
              type="url"
              inputMode="url"
              autoComplete="url"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="https://"
              maxLength={200}
              value={values.website}
              onChange={(event) => update({ website: event.target.value }, ["website"])}
            />
          )}
        </Field>
        {visibilitySwitch("website")}
      </div>

      <div className={styles.formAlert} role="alert">
        {formError !== null ? (
          <p className={styles.formError}>
            <span aria-hidden="true">⚠️ </span>
            {formError}
          </p>
        ) : null}
      </div>

      <div className={cx(styles.saveBar, dirty && styles.saveBarDirty)}>
        <Button type="submit" fullWidth loading={saving} disabled={!dirty}>
          Guardar contacto
        </Button>
      </div>
    </form>
  );
}

interface PhoneFieldProps {
  name: "phone" | "whatsapp";
  label: string;
  hint?: string;
  parts: PhoneParts;
  error: string | undefined;
  onChange: (parts: PhoneParts) => void;
}

/** Country picker (default +52) + number. A number typed with its own `+lada` wins over the picker. */
function PhoneField({ name, label, hint, parts, error, onChange }: PhoneFieldProps): ReactNode {
  return (
    <Field label={label} hint={hint} error={error} showOptional>
      {(control) => (
        <div className={styles.phoneRow}>
          <div className={styles.countryPicker}>
            <Select
              name={`${name}-country`}
              aria-label={`País (lada) de ${label.toLowerCase()}`}
              options={COUNTRY_OPTIONS}
              value={parts.country}
              onChange={(event) => onChange({ ...parts, country: event.target.value })}
            />
          </div>
          <TextInput
            {...control}
            name={name}
            className={styles.phoneNumber}
            type="tel"
            inputMode="tel"
            autoComplete={name === "phone" ? "tel-national" : "off"}
            maxLength={30}
            value={parts.number}
            onChange={(event) => onChange({ ...parts, number: event.target.value })}
          />
        </div>
      )}
    </Field>
  );
}
