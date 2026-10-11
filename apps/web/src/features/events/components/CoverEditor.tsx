/**
 * The event cover controls (WP-5.4, organizers and admins): pick a photo →
 * frame it in the WP-4.3 `ImageCropper` at 16:9 → the avatar upload flow
 * (`usePhotoUpload`: intent validated and origin-checked [SEC], credential-less
 * PUT, confirm), pointed at the event's cover endpoints. No new upload path.
 */
import { EVENT_COVER_ASPECT, type EventDetail } from "@cuencada/types";
import { type ChangeEvent, type ReactNode, useMemo, useRef, useState } from "react";
import { isAbortError } from "../../../shared/api/errors";
import { Button } from "../../../shared/ui/Button";
import { Dialog } from "../../../shared/ui/Dialog";
import { useToast } from "../../../shared/ui/Toast";
import { useCropStep } from "../../family/photo/useCropStep";
import { AVATAR_ACCEPT, type PhotoUploadEndpoints, usePhotoUpload } from "../../profile/lib/useAvatarUpload";
import { useConfirmCoverMutation, useCreateCoverUploadMutation, useDeleteCoverMutation } from "../api";
import styles from "../events.module.css";
import { eventErrorMessage } from "../lib/format";

/** Title of the cropper when framing a cover. */
export const COVER_CROPPER_TITLE = "Portada del evento";

function statusText(phase: string, progress: number): string {
  if (phase === "uploading") return `Subiendo portada… ${Math.round(progress * 100)} %`;
  if (phase === "confirming") return "Guardando portada…";
  if (phase === "done") return "Portada actualizada.";
  return "";
}

/** "Agregar/Cambiar portada" and "Quitar portada" for an event. Render only when `event.canManage`. */
export function CoverEditor({ event }: { event: Pick<EventDetail, "id" | "coverUrl"> }): ReactNode {
  const input = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const [createUpload] = useCreateCoverUploadMutation();
  const [confirmCover] = useConfirmCoverMutation();
  const [removeCover, { isLoading: removing }] = useDeleteCoverMutation();
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const endpoints = useMemo<PhotoUploadEndpoints>(
    () => ({
      createUpload: (body) => createUpload({ id: event.id, body }),
      confirm: (uploadId) => confirmCover({ id: event.id, uploadId })
    }),
    [createUpload, confirmCover, event.id]
  );
  const upload = usePhotoUpload(endpoints);
  const crop = useCropStep(upload.start, COVER_CROPPER_TITLE, { aspect: EVENT_COVER_ASPECT });
  const busy = upload.phase === "uploading" || upload.phase === "confirming";
  const error = crop.pickError ?? upload.error;
  const hasCover = event.coverUrl !== null;

  const onPick = (changeEvent: ChangeEvent<HTMLInputElement>): void => {
    const file = changeEvent.target.files?.[0];
    changeEvent.target.value = "";
    if (file) crop.pick(file);
  };

  const onRemove = (): void => {
    removeCover({ id: event.id })
      .unwrap()
      .then(() => {
        setConfirmingRemove(false);
        toast.show({ message: "Quitaste la portada.", tone: "success" });
      })
      .catch((cause: unknown) => {
        if (isAbortError(cause)) return;
        setConfirmingRemove(false);
        toast.show({ message: eventErrorMessage(cause), tone: "danger" });
      });
  };

  return (
    <div className={styles.coverEditor}>
      <input
        ref={input}
        type="file"
        accept={AVATAR_ACCEPT}
        className="visually-hidden"
        tabIndex={-1}
        aria-hidden="true"
        data-testid="event-cover-file-input"
        onChange={onPick}
      />
      <div className={styles.inlineActions}>
        <Button variant="secondary" size="sm" icon="🖼️" loading={busy} disabled={removing} onClick={() => input.current?.click()}>
          {hasCover ? "Cambiar portada" : "Agregar portada"}
        </Button>
        {hasCover && !busy ? (
          <Button variant="ghost" size="sm" loading={removing} onClick={() => setConfirmingRemove(true)}>
            Quitar portada
          </Button>
        ) : null}
      </div>
      <output className={styles.status} aria-live="polite">
        {statusText(upload.phase, upload.progress)}
      </output>
      {error !== null ? (
        <p className={styles.fieldError} role="alert">
          <span aria-hidden="true">⚠️ </span>
          {error}
        </p>
      ) : null}
      {crop.cropper}
      <Dialog
        open={confirmingRemove}
        onClose={() => setConfirmingRemove(false)}
        role="alertdialog"
        closeOnBackdrop={false}
        title="¿Quitar la portada?"
        description="El evento mostrará un fondo de color. Puedes subir otra cuando quieras."
        footer={
          <>
            <Button variant="danger" fullWidth loading={removing} onClick={onRemove}>
              Quitar portada
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
