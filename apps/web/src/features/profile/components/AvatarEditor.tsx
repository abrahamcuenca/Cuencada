import { type ChangeEvent, type CSSProperties, type ReactNode, useRef, useState } from "react";
import { getApiErrorMessage, isAbortError } from "../../../shared/api/errors";
import { AvatarCircle } from "../../../shared/ui/AvatarCircle";
import { Button } from "../../../shared/ui/Button";
import { cx } from "../../../shared/ui/cx";
import { Dialog } from "../../../shared/ui/Dialog";
import { useToast } from "../../../shared/ui/Toast";
import { useExpiredUrlRefetch } from "../../gallery";
import { useDeleteAvatarMutation, useGetProfileQuery } from "../api";
import { AVATAR_ACCEPT, useAvatarUpload } from "../lib/useAvatarUpload";
import styles from "../profile.module.css";

/** Toast after the photo was removed. */
export const AVATAR_REMOVED_MESSAGE = "Quitaste tu foto.";

/** Props for {@link AvatarEditor}. */
export interface AvatarEditorProps {
  name: string;
  avatarUrl: string | null;
}

/** Spoken/visible status line for the current phase. */
function statusText(phase: string, progress: number): string {
  if (phase === "uploading") return `Subiendo foto… ${Math.round(progress * 100)} %`;
  if (phase === "confirming") return "Guardando foto…";
  if (phase === "done") return "Foto actualizada.";
  return "";
}

/**
 * The big round avatar with "Cambiar foto" (file picker, local preview, a
 * progress ring while it uploads, the result in a live region) and
 * "Quitar foto" behind a confirmation.
 */
export function AvatarEditor({ name, avatarUrl }: AvatarEditorProps): ReactNode {
  const input = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const upload = useAvatarUpload();
  const [deleteAvatar, { isLoading: removing }] = useDeleteAvatarMutation();
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  // `avatarUrl` is a 1h presigned GET: when it fails to load, fetch a fresh profile once.
  const { refetch } = useGetProfileQuery();
  const onImageError = useExpiredUrlRefetch(refetch);
  const busy = upload.phase === "uploading" || upload.phase === "confirming";
  const ringPercent = upload.phase === "confirming" ? 100 : Math.round(upload.progress * 100);
  // Safe: CSSProperties has no index signature for custom properties; the value is a plain percentage.
  const ringStyle = busy ? ({ "--avatar-progress": `${ringPercent}%` } as CSSProperties) : undefined;

  const onPick = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    // Reset so picking the same file again (after an error) fires `change`.
    event.target.value = "";
    if (file) upload.start(file);
  };

  const onRemove = (): void => {
    if (removing) return;
    deleteAvatar()
      .unwrap()
      .then(() => {
        setConfirmingRemove(false);
        toast.show({ message: AVATAR_REMOVED_MESSAGE, tone: "success" });
      })
      .catch((cause: unknown) => {
        if (isAbortError(cause)) return;
        setConfirmingRemove(false);
        toast.show({ message: getApiErrorMessage(cause), tone: "danger" });
      });
  };

  return (
    <div className={styles.avatarEditor}>
      <div className={cx(styles.avatarRing, busy && styles.avatarRingBusy)} style={ringStyle} onError={upload.previewUrl === null ? onImageError : undefined}>
        <AvatarCircle name={name} src={upload.previewUrl ?? avatarUrl ?? undefined} size="xl" />
      </div>
      <input
        ref={input}
        type="file"
        accept={AVATAR_ACCEPT}
        className="visually-hidden"
        tabIndex={-1}
        aria-hidden="true"
        data-testid="avatar-file-input"
        onChange={onPick}
      />
      <div className={styles.avatarActions}>
        <Button variant="secondary" size="sm" icon="📷" loading={busy} disabled={removing} onClick={() => input.current?.click()}>
          Cambiar foto
        </Button>
        {avatarUrl !== null && !busy ? (
          <Button variant="ghost" size="sm" loading={removing} onClick={() => setConfirmingRemove(true)}>
            Quitar foto
          </Button>
        ) : null}
      </div>
      <output className={styles.avatarStatus} aria-live="polite">
        {statusText(upload.phase, upload.progress)}
      </output>
      {upload.error !== null ? (
        <p className={styles.avatarError} role="alert">
          <span aria-hidden="true">⚠️ </span>
          {upload.error}
        </p>
      ) : null}
      <p className={styles.avatarHint}>JPG, PNG o WebP, hasta 10 MB.</p>

      <Dialog
        open={confirmingRemove}
        onClose={() => setConfirmingRemove(false)}
        role="alertdialog"
        closeOnBackdrop={false}
        title="¿Quitar tu foto?"
        description="La familia verá tus iniciales en lugar de tu foto. Puedes subir otra cuando quieras."
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
