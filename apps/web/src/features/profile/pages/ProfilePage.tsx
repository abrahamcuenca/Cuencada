import { type FormEvent, type ReactNode, useMemo, useRef, useState } from "react";
import { getApiErrorCode, getApiErrorMessage, isAbortError } from "../../../shared/api/errors";
import { Button } from "../../../shared/ui/Button";
import { Switch } from "../../../shared/ui/Checkbox";
import { cx } from "../../../shared/ui/cx";
import { EmptyState } from "../../../shared/ui/EmptyState";
import { Field } from "../../../shared/ui/Field";
import { Skeleton } from "../../../shared/ui/Skeleton";
import { TextArea } from "../../../shared/ui/TextArea";
import { TextInput } from "../../../shared/ui/TextInput";
import { useToast } from "../../../shared/ui/Toast";
import { useGetProfileQuery, useUpdateProfileMutation } from "../api";
import { AvatarEditor } from "../components/AvatarEditor";
import {
  buildProfilePatch,
  detectSupport,
  dirtyFields,
  isFieldSupported,
  PROFILE_SWITCH_FIELDS,
  PROFILE_TEXT_FIELDS,
  type ProfileField,
  type ProfileFormErrors,
  type ProfileFormValues,
  type ProfileSwitchField,
  type ProfileTextField,
  type ProfileWithListing,
  toFormValues
} from "../lib/profileForm";
import styles from "../profile.module.css";

/** Toast after a successful save (wireframe copy). */
export const PROFILE_SAVED_MESSAGE = "Cambios guardados.";

/**
 * `/perfil`: the caller's own profile. Avatar, personal data and the privacy
 * switches; "Guardar cambios" sends only the fields that changed.
 */
export function ProfilePage(): ReactNode {
  const { data, error, isLoading, refetch } = useGetProfileQuery();

  if (data) {
    // Safe: an OwnProfile plus an optional field that is checked before use (see profileForm.ts).
    return <ProfileForm profile={data as ProfileWithListing} />;
  }
  return (
    <div className={cx("cu-container", styles.page)} aria-busy={isLoading}>
      <h1 className={styles.title}>Mi perfil</h1>
      {error && !isAbortError(error) ? (
        <EmptyState
          icon="📡"
          title="No pudimos cargar tu perfil"
          description="Revisa tu conexión e inténtalo de nuevo."
          action={
            <Button variant="secondary" onClick={() => void refetch()}>
              Reintentar
            </Button>
          }
        />
      ) : (
        <ProfileSkeleton />
      )}
    </div>
  );
}

function ProfileSkeleton(): ReactNode {
  return (
    <div className={styles.skeleton}>
      <Skeleton shape="circle" width={96} height={96} />
      <Skeleton shape="text" width="70%" />
      <Skeleton shape="block" height={48} />
      <Skeleton shape="block" height={48} />
      <Skeleton shape="block" height={48} />
    </div>
  );
}

interface TextFieldSpec {
  label: string;
  hint?: string;
  required?: boolean;
  type?: string;
  inputMode?: "text" | "tel" | "numeric";
  autoComplete: string;
  maxLength: number;
}

const TEXT_FIELDS: Record<ProfileTextField, TextFieldSpec> = {
  fullName: { label: "Nombre completo", required: true, autoComplete: "name", maxLength: 200 },
  displayName: { label: "Cómo te dicen", hint: "Así te verá la familia en el chat y en las fotos.", required: true, autoComplete: "nickname", maxLength: 80 },
  familyBranch: { label: "Rama familiar", hint: "Por ejemplo: Familia de Jorge.", autoComplete: "off", maxLength: 120 },
  city: { label: "Ciudad", autoComplete: "address-level2", maxLength: 120 },
  phone: {
    label: "Teléfono / WhatsApp",
    hint: "Con lada, por ejemplo +52 999 123 4567.",
    type: "tel",
    inputMode: "tel",
    autoComplete: "tel",
    maxLength: 30
  },
  bio: { label: "Sobre mí", hint: "Unas líneas para que la familia te conozca.", autoComplete: "off", maxLength: 500 }
};

interface SwitchSpec {
  label: string;
  hint: (profile: ProfileWithListing) => string;
}

const SWITCH_FIELDS: Record<ProfileSwitchField, SwitchSpec> = {
  showEmail: {
    label: "Mostrar mi correo a la familia",
    hint: (profile) => `Tu correo (${profile.email}) aparecerá en tu ficha del directorio.`
  },
  showPhone: { label: "Mostrar mi teléfono a la familia", hint: () => "Podrán llamarte o escribirte por WhatsApp desde el directorio." },
  showCity: { label: "Mostrar mi ciudad a la familia", hint: () => "Aparecerá en tu ficha y podrán encontrarte al buscar por ciudad." },
  listedInDirectory: {
    label: "Aparecer en el directorio",
    hint: () => "Si lo apagas, no aparecerás en el directorio ni en su búsqueda. Seguirás en el árbol familiar."
  }
};

/** The loaded profile form. Holds only the user's edits on top of the server values. */
function ProfileForm({ profile }: { profile: ProfileWithListing }): ReactNode {
  const toast = useToast();
  const [updateProfile, { isLoading: saving }] = useUpdateProfileMutation();
  const [edits, setEdits] = useState<Partial<ProfileFormValues>>({});
  const [errors, setErrors] = useState<ProfileFormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const submitting = useRef(false);

  const support = useMemo(() => detectSupport(profile), [profile]);
  const baseline = useMemo(() => toFormValues(profile), [profile]);
  const values: ProfileFormValues = { ...baseline, ...edits };
  const dirty = dirtyFields(baseline, values, support).length > 0;

  const setValue = <TField extends ProfileField>(field: TField, value: ProfileFormValues[TField]): void => {
    setEdits((current) => ({ ...current, [field]: value }));
    if (errors[field] !== undefined) {
      setErrors((current) => {
        const next = { ...current };
        delete next[field];
        return next;
      });
    }
  };

  const focusFirstError = (found: ProfileFormErrors): void => {
    const first = PROFILE_TEXT_FIELDS.find((field) => found[field] !== undefined);
    if (first) formRef.current?.querySelector<HTMLElement>(`[name="${first}"]`)?.focus();
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (submitting.current) return;
    setFormError(null);
    const result = buildProfilePatch(baseline, values, support);
    if (!result.ok) {
      setErrors(result.errors);
      focusFirstError(result.errors);
      return;
    }
    setErrors({});
    if (result.patch === null) return;

    submitting.current = true;
    updateProfile(result.patch)
      .unwrap()
      .then(() => {
        setEdits({});
        toast.show({ message: PROFILE_SAVED_MESSAGE, tone: "success" });
      })
      .catch((cause: unknown) => {
        if (isAbortError(cause)) return;
        const message =
          getApiErrorCode(cause) === "RATE_LIMITED" ? "Demasiados intentos. Espera unos minutos y vuelve a intentarlo." : getApiErrorMessage(cause);
        setFormError(message);
      })
      .finally(() => {
        submitting.current = false;
      });
  };

  const name = values.fullName.trim() || profile.fullName || profile.displayName;

  return (
    <div className={cx("cu-container", styles.page)}>
      <h1 className={styles.title}>Mi perfil</h1>
      <div className={styles.layout}>
        <section className={styles.identity} aria-label="Foto de perfil">
          <AvatarEditor name={name} avatarUrl={profile.avatarUrl} />
          <p className={styles.identityName}>{profile.fullName || profile.displayName}</p>
          {profile.familyBranch ? <p className={styles.identityMeta}>Rama: {profile.familyBranch}</p> : null}
        </section>

        <form ref={formRef} className={styles.form} noValidate onSubmit={onSubmit} aria-label="Datos de perfil">
          <h2 className={styles.sectionTitle}>Tus datos</h2>
          {PROFILE_TEXT_FIELDS.map((field) => {
            const spec = TEXT_FIELDS[field];
            return (
              <Field
                key={field}
                label={spec.label}
                hint={spec.hint}
                error={errors[field]}
                required={spec.required === true}
                showOptional={spec.required !== true}
              >
                {(control) =>
                  field === "bio" ? (
                    <TextArea {...control} name={field} rows={4} maxLength={spec.maxLength} value={values.bio} onChange={(event) => setValue("bio", event.target.value)} />
                  ) : (
                    <TextInput
                      {...control}
                      name={field}
                      type={spec.type ?? "text"}
                      inputMode={spec.inputMode}
                      autoComplete={spec.autoComplete}
                      maxLength={spec.maxLength}
                      value={values[field]}
                      onChange={(event) => setValue(field, event.target.value)}
                    />
                  )
                }
              </Field>
            );
          })}

          <h2 className={styles.sectionTitle}>¿Quién puede ver mis datos?</h2>
          <p className={styles.sectionHint}>
            Tus datos solo los ve la familia con sesión iniciada. Lo que no muestres queda oculto, también en la búsqueda del directorio.
          </p>
          <div className={styles.switches}>
            {PROFILE_SWITCH_FIELDS.filter((field) => isFieldSupported(field, support)).map((field) => (
              <Switch
                key={field}
                name={field}
                label={SWITCH_FIELDS[field].label}
                hint={SWITCH_FIELDS[field].hint(profile)}
                checked={values[field]}
                onChange={(event) => setValue(field, event.target.checked)}
              />
            ))}
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
              Guardar cambios
            </Button>
          </div>
        </form>
      </div>

      <Button to="/perfil/sesiones" variant="ghost" icon="🔐" iconEnd="›" className={styles.sessionsLink}>
        Sesiones y seguridad
      </Button>
    </div>
  );
}
