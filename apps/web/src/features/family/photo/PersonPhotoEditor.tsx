/**
 * Tree-photo controls for one person (WP-4.3): "Agregar/Cambiar foto" (file
 * picker → `ImageCropper` → upload) and "Quitar foto" behind a confirmation.
 * Render it only when `person.canEditPhoto` (the server checks again).
 */
import type { PersonDetails } from "@cuencada/types";
import { type ChangeEvent, type ReactNode, useRef, useState } from "react";
import { getApiErrorMessage, isAbortError } from "../../../shared/api/errors";
import { Button } from "../../../shared/ui/Button";
import { Dialog } from "../../../shared/ui/Dialog";
import { useToast } from "../../../shared/ui/Toast";
import { AVATAR_ACCEPT } from "../../profile/lib/useAvatarUpload";
import { useDeletePersonPhotoMutation } from "../api";
import styles from "./PersonPhotoEditor.module.css";
import { useCropStep } from "./useCropStep";
import { usePersonPhotoUpload } from "./usePersonPhotoUpload";

/** Toast after the tree photo was removed. */
export const PERSON_PHOTO_REMOVED = "Quitaste la foto del árbol.";

/** Props for {@link PersonPhotoEditor}. */
export interface PersonPhotoEditorProps {
  person: Pick<PersonDetails, "id" | "fullName" | "photoSource" | "isLinked">;
}

function statusText(phase: string, progress: number): string {
  if (phase === "uploading") return `Subiendo foto… ${Math.round(progress * 100)} %`;
  if (phase === "confirming") return "Guardando foto…";
  if (phase === "done") return "Foto actualizada.";
  return "";
}

/** Upload, crop or remove a person's tree photo. */
export function PersonPhotoEditor({ person }: PersonPhotoEditorProps): ReactNode {
  const input = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const upload = usePersonPhotoUpload(person.id);
  const crop = useCropStep(upload.start);
  const [removePhoto, { isLoading: removing }] = useDeletePersonPhotoMutation();
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const busy = upload.phase === "uploading" || upload.phase === "confirming";
  const hasTreePhoto = person.photoSource === "person";
  const error = crop.pickError ?? upload.error;

  const onPick = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) crop.pick(file);
  };

  const onRemove = (): void => {
    if (removing) return;
    removePhoto(person.id)
      .unwrap()
      .then(() => {
        setConfirmingRemove(false);
        toast.show({ message: PERSON_PHOTO_REMOVED, tone: "success" });
      })
      .catch((cause: unknown) => {
        if (isAbortError(cause)) return;
        setConfirmingRemove(false);
        toast.show({ message: getApiErrorMessage(cause), tone: "danger" });
      });
  };

  return (
    <div className={styles.editor}>
      <input
        ref={input}
        type="file"
        accept={AVATAR_ACCEPT}
        className="visually-hidden"
        tabIndex={-1}
        aria-hidden="true"
        data-testid="person-photo-file-input"
        onChange={onPick}
      />
      <div className={styles.actions}>
        <Button variant="secondary" size="sm" icon="📷" loading={busy} disabled={removing} onClick={() => input.current?.click()}>
          {hasTreePhoto ? "Cambiar foto" : "Agregar foto"}
        </Button>
        {hasTreePhoto && !busy ? (
          <Button variant="ghost" size="sm" loading={removing} onClick={() => setConfirmingRemove(true)}>
            Quitar foto
          </Button>
        ) : null}
      </div>
      <output className={styles.status} aria-live="polite">
        {statusText(upload.phase, upload.progress)}
      </output>
      {error !== null ? (
        <p className={styles.error} role="alert">
          <span aria-hidden="true">⚠️ </span>
          {error}
        </p>
      ) : null}
      {person.isLinked ? <p className={styles.hint}>Si tiene foto de perfil, esa se muestra primero.</p> : null}
      {crop.cropper}
      <Dialog
        open={confirmingRemove}
        onClose={() => setConfirmingRemove(false)}
        role="alertdialog"
        closeOnBackdrop={false}
        title="¿Quitar la foto del árbol?"
        description={`El árbol mostrará las iniciales de ${person.fullName}. Puedes subir otra cuando quieras.`}
        footer={
          <>
            <Button variant="danger" fullWidth loading={removing} onClick={onRemove}>
              Quitar foto
            </Button>
            <Button variant="secondary" fullWidth onClick={() => setConfirmingRemove(false)}>
              Cancelar
            </Button>
          </>
        }
      />
    </div>
  );
}
