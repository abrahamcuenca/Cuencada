import type { ReactNode } from "react";
import { Button } from "../../../../shared/ui/Button";
import { Dialog } from "../../../../shared/ui/Dialog";

/** Props for {@link ConfirmDialog}. */
export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/** Destructive confirmation: `alertdialog`, no backdrop dismiss, the danger action last (thumb zone). */
export function ConfirmDialog({ open, title, description, confirmLabel, busy, onConfirm, onClose }: ConfirmDialogProps): ReactNode {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      role="alertdialog"
      closeOnBackdrop={false}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="danger" loading={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
}
