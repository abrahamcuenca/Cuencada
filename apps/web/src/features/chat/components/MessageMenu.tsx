import { type ReactNode, useState } from "react";
import { Button } from "../../../shared/ui/Button";
import { Dialog } from "../../../shared/ui/Dialog";
import styles from "../chat.module.css";
import type { ThreadMessage } from "../lib/thread";

/** Props for {@link MessageMenu}. */
export interface MessageMenuProps {
  /** The message the menu is open for, or `null` when closed. */
  message: ThreadMessage | null;
  canDelete: boolean;
  /** Whether the delete request is in flight. */
  deleting: boolean;
  onClose: () => void;
  onCopy: ((message: ThreadMessage) => void) | null;
  onConfirmDelete: (message: ThreadMessage) => void;
}

/**
 * The long-press / ⋯ menu as a bottom sheet ("Copiar texto", "Eliminar"),
 * then an `alertdialog` that confirms the deletion.
 */
export function MessageMenu({ message, canDelete, deleting, onClose, onCopy, onConfirmDelete }: MessageMenuProps): ReactNode {
  const [confirming, setConfirming] = useState(false);
  const close = (): void => {
    setConfirming(false);
    onClose();
  };

  return (
    <>
      <Dialog open={message !== null && !confirming} onClose={close} title="Mensaje">
        {message === null ? null : (
          <div className={styles.menu}>
            <p className={styles.quote}>{message.body}</p>
            {onCopy === null ? null : (
              <Button
                variant="secondary"
                fullWidth
                onClick={() => {
                  onCopy(message);
                  close();
                }}
              >
                Copiar texto
              </Button>
            )}
            {canDelete ? (
              <Button variant="danger" fullWidth onClick={() => setConfirming(true)}>
                Eliminar
              </Button>
            ) : null}
          </div>
        )}
      </Dialog>
      <Dialog
        open={message !== null && confirming}
        onClose={close}
        role="alertdialog"
        closeOnBackdrop={false}
        title="¿Eliminar este mensaje?"
        description="Se mostrará como «Mensaje eliminado» para toda la familia. No se puede deshacer."
        footer={
          <>
            <Button
              variant="danger"
              fullWidth
              loading={deleting}
              onClick={() => {
                if (message !== null) onConfirmDelete(message);
              }}
            >
              Eliminar
            </Button>
            <Button variant="secondary" fullWidth onClick={close} disabled={deleting}>
              Cancelar
            </Button>
          </>
        }
      />
    </>
  );
}
