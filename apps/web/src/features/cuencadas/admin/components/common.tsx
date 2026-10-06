import type { ReactNode } from "react";
import { getApiErrorMessage, isAbortError } from "../../../../shared/api/errors";
import { Button } from "../../../../shared/ui/Button";
import { Dialog } from "../../../../shared/ui/Dialog";
import { IconButton } from "../../../../shared/ui/IconButton";
import type { ToastApi } from "../../../../shared/ui/Toast";
import styles from "../admin.module.css";

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

/** Destructive confirmation: `alertdialog`, no backdrop dismiss, danger action last (thumb zone). */
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

/** Props for {@link MoveButtons}. */
export interface MoveButtonsProps {
  label: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (direction: -1 | 1) => void;
  disabled?: boolean;
}

/** Up/down reorder buttons (no drag dependency), each a 44px target with a spoken label. */
export function MoveButtons({ label, canMoveUp, canMoveDown, onMove, disabled = false }: MoveButtonsProps): ReactNode {
  return (
    <div className={styles.moveButtons}>
      <IconButton label={`Subir «${label}»`} icon="↑" disabled={disabled || !canMoveUp} onClick={() => onMove(-1)} />
      <IconButton label={`Bajar «${label}»`} icon="↓" disabled={disabled || !canMoveDown} onClick={() => onMove(1)} />
    </div>
  );
}

/**
 * Swaps the item at `index` with its neighbour.
 *
 * @param ids - The current order.
 * @param index - Position of the item to move.
 * @param direction - `-1` up, `1` down.
 * @returns The new order, or `null` when the move is out of bounds.
 */
export function moveId(ids: readonly string[], index: number, direction: -1 | 1): string[] | null {
  const target = index + direction;
  const current = ids[index];
  const other = ids[target];
  if (current === undefined || other === undefined) return null;
  const next = [...ids];
  next[index] = other;
  next[target] = current;
  return next;
}

/**
 * Shows a danger toast for a failed mutation, except for aborts (a logout
 * already moved the user).
 *
 * @param toast - From `useToast()`.
 * @param error - What `.unwrap()` rejected with.
 */
export function toastError(toast: ToastApi, error: unknown): void {
  if (isAbortError(error)) return;
  toast.show({ message: getApiErrorMessage(error), tone: "danger" });
}
