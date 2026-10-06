import { type MediaItem, type MediaReportReason, MediaReportReason as Reasons } from "@cuencada/types";
import { type FormEvent, useState } from "react";
import { getApiErrorCode, getApiErrorMessage, isAbortError } from "../../../shared/api/errors";
import { Button } from "../../../shared/ui/Button";
import { Dialog } from "../../../shared/ui/Dialog";
import { Field } from "../../../shared/ui/Field";
import { Select, type SelectOption } from "../../../shared/ui/Select";
import { TextArea } from "../../../shared/ui/TextArea";
import { useToast } from "../../../shared/ui/Toast";
import { useDeleteMediaMutation, useReportMediaMutation, useUpdateMediaCaptionMutation } from "../api";

const CAPTION_MAX = 500;

/** Spanish labels for report reasons (wireframe 7.1). */
export const REPORT_REASON_LABELS: Record<MediaReportReason, string> = {
  inappropriate: "No debería estar aquí",
  privacy: "Aparezco yo y no quiero",
  duplicate: "Está repetida",
  other: "Otro motivo"
};

const REASON_OPTIONS: SelectOption[] = Object.values(Reasons).map((value) => ({ value, label: REPORT_REASON_LABELS[value] }));

function isReason(value: string): value is MediaReportReason {
  return Object.values<string>(Reasons).includes(value);
}

function noun(item: Pick<MediaItem, "kind">): string {
  return item.kind === "video" ? "este video" : "esta foto";
}

/** Props shared by the item dialogs. */
export interface ItemDialogProps {
  item: MediaItem;
  open: boolean;
  onClose: () => void;
}

/** Owner (or admin) edits the caption. */
export function EditCaptionDialog({ item, open, onClose }: ItemDialogProps): React.ReactNode {
  const [caption, setCaption] = useState(item.caption ?? "");
  const [error, setError] = useState<string | null>(null);
  const [update, { isLoading }] = useUpdateMediaCaptionMutation();
  const toast = useToast();

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const trimmed = caption.trim();
    if (trimmed.length > CAPTION_MAX) {
      setError(`Máximo ${CAPTION_MAX} caracteres.`);
      return;
    }
    try {
      await update({ id: item.id, caption: trimmed === "" ? null : trimmed }).unwrap();
      toast.show({ message: "Descripción guardada.", tone: "success" });
      onClose();
    } catch (failure) {
      if (isAbortError(failure)) return;
      setError(getApiErrorMessage(failure));
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Editar descripción">
      <form id={`caption-${item.id}`} noValidate onSubmit={(event) => void submit(event)}>
        <Field label="Descripción" hint="Cuenta qué pasó o quién aparece." error={error} showOptional>
          {(p) => <TextArea {...p} value={caption} maxLength={CAPTION_MAX} rows={3} onChange={(e) => setCaption(e.target.value)} />}
        </Field>
        <Button type="submit" fullWidth loading={isLoading}>
          Guardar
        </Button>
      </form>
    </Dialog>
  );
}

/** Owner (or admin) deletes an item after confirming. */
export function DeleteMediaDialog({ item, open, onClose, onDeleted }: ItemDialogProps & { onDeleted: () => void }): React.ReactNode {
  const [remove, { isLoading }] = useDeleteMediaMutation();
  const toast = useToast();

  const confirm = async (): Promise<void> => {
    try {
      await remove({ id: item.id, year: item.year }).unwrap();
      toast.show({ message: item.kind === "video" ? "Video eliminado." : "Foto eliminada.", tone: "success" });
      onDeleted();
    } catch (failure) {
      if (isAbortError(failure)) return;
      toast.show({ message: getApiErrorMessage(failure), tone: "danger" });
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      role="alertdialog"
      closeOnBackdrop={false}
      title={`¿Eliminar ${noun(item)}?`}
      description="Se quitará del álbum para toda la familia."
      footer={
        <>
          <Button variant="ghost" fullWidth onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="danger" fullWidth loading={isLoading} onClick={() => void confirm()}>
            Eliminar
          </Button>
        </>
      }
    />
  );
}

/** Any member reports an item with a reason. */
export function ReportDialog({ item, open, onClose }: ItemDialogProps): React.ReactNode {
  const [reason, setReason] = useState<MediaReportReason | "">("");
  const [details, setDetails] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [report, { isLoading }] = useReportMediaMutation();
  const toast = useToast();

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (reason === "") {
      setError("Elige un motivo.");
      return;
    }
    const trimmed = details.trim();
    try {
      await report({ id: item.id, body: { reason, details: trimmed === "" ? null : trimmed.slice(0, CAPTION_MAX) } }).unwrap();
      toast.show({ message: "Gracias. Un administrador la revisará.", tone: "success" });
      onClose();
    } catch (failure) {
      if (isAbortError(failure)) return;
      if (getApiErrorCode(failure) === "CONFLICT") {
        toast.show({ message: `Ya habías reportado ${noun(item)}. Un administrador la revisará.`, tone: "info" });
        onClose();
        return;
      }
      setError(getApiErrorMessage(failure));
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={`¿Por qué quieres reportar ${noun(item)}?`}>
      <form noValidate onSubmit={(event) => void submit(event)}>
        <Field label="Motivo" error={error} required>
          {(p) => (
            <Select
              {...p}
              value={reason}
              placeholder="Elige un motivo"
              options={REASON_OPTIONS}
              onChange={(e) => {
                const value = e.target.value;
                setReason(isReason(value) ? value : "");
                setError(null);
              }}
            />
          )}
        </Field>
        <Field label="Detalles" hint="Solo los administradores lo verán." showOptional>
          {(p) => <TextArea {...p} value={details} maxLength={CAPTION_MAX} rows={2} onChange={(e) => setDetails(e.target.value)} />}
        </Field>
        <Button type="submit" fullWidth loading={isLoading}>
          Enviar reporte
        </Button>
      </form>
    </Dialog>
  );
}
