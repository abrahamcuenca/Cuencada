import { type ChangeEvent, type Ref, useImperativeHandle, useRef, useState } from "react";
import { Button } from "../../../shared/ui/Button";
import { Dialog } from "../../../shared/ui/Dialog";
import { Field } from "../../../shared/ui/Field";
import { TextInput } from "../../../shared/ui/TextInput";
import { cx } from "../../../shared/ui/cx";
import styles from "../gallery.module.css";
import { type FileCheck, formatBytes, UPLOAD_ACCEPT, validateUploadFile } from "../lib/validateFile";
import { useUploadManager } from "../upload/useUploadManager";

/** Imperative handle so other buttons (the empty state) can open the picker. */
export interface UploaderHandle {
  openPicker: () => void;
}

/** Props for {@link Uploader}. */
export interface UploaderProps {
  year: number;
  /** Render the big trigger button (off when another control opens the picker). */
  showButton?: boolean;
  ref?: Ref<UploaderHandle>;
}

const CAPTION_MAX = 500;

/**
 * "Subir fotos y videos": the native picker (camera roll on phones), then a
 * sheet to review the files, see per-file errors and add optional captions
 * before they are queued.
 */
export function Uploader({ year, showButton = true, ref }: UploaderProps): React.ReactNode {
  const input = useRef<HTMLInputElement>(null);
  const { manager } = useUploadManager();
  const [checks, setChecks] = useState<FileCheck[]>([]);
  const [captions, setCaptions] = useState<string[]>([]);

  const openPicker = (): void => input.current?.click();
  useImperativeHandle(ref, () => ({ openPicker }));

  const onChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(event.target.files ?? []);
    // Allow picking the same file again later.
    event.target.value = "";
    if (files.length === 0) return;
    const next = files.map(validateUploadFile);
    setChecks(next);
    setCaptions(next.map(() => ""));
  };

  const close = (): void => {
    setChecks([]);
    setCaptions([]);
  };

  const accepted = checks.flatMap((check, i) => (check.ok ? [{ file: check, caption: captions[i]?.trim() || null }] : []));
  const rejectedCount = checks.length - accepted.length;

  const start = (): void => {
    manager.enqueue(year, accepted);
    close();
  };

  const title =
    accepted.length === 0
      ? "No se puede subir"
      : accepted.length === 1
        ? "Subir 1 archivo"
        : `Subir ${accepted.length} archivos`;

  return (
    <>
      <input
        ref={input}
        type="file"
        accept={UPLOAD_ACCEPT}
        multiple
        className={styles.fileInput}
        tabIndex={-1}
        aria-hidden="true"
        data-testid="gallery-file-input"
        onChange={onChange}
      />
      {showButton ? (
        <Button size="lg" icon="📤" className={styles.uploadButton} onClick={openPicker}>
          Subir fotos y videos
        </Button>
      ) : null}
      <Dialog
        open={checks.length > 0}
        onClose={close}
        title={title}
        description={
          rejectedCount > 0
            ? "Algunos archivos no se pueden subir. Los demás sí."
            : "Agrega una descripción si quieres. Puedes seguir viendo el álbum mientras se suben."
        }
        footer={
          accepted.length > 0 ? (
            <>
              <Button variant="ghost" fullWidth onClick={close}>
                Cancelar
              </Button>
              <Button fullWidth onClick={start}>
                {accepted.length === 1 ? "Subir" : `Subir ${accepted.length}`}
              </Button>
            </>
          ) : (
            <Button fullWidth onClick={close}>
              Entendido
            </Button>
          )
        }
      >
        <ul className={styles.stageList}>
          {checks.map((check, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the staged list is replaced as a whole, never reordered.
            <li key={i} className={cx(styles.stageItem, !check.ok && styles.rejected)}>
              <p className={styles.fileName}>{check.fileName}</p>
              <p className={styles.fileMeta}>{formatBytes(check.file.size)}</p>
              {check.ok ? (
                <Field label="Descripción" showOptional>
                  {(p) => (
                    <TextInput
                      {...p}
                      type="text"
                      autoComplete="off"
                      enterKeyHint="next"
                      maxLength={CAPTION_MAX}
                      value={captions[i] ?? ""}
                      onChange={(e) => {
                        const value = e.target.value;
                        setCaptions((list) => list.map((c, j) => (j === i ? value : c)));
                      }}
                    />
                  )}
                </Field>
              ) : (
                <p className={styles.errorText} role="alert">
                  {check.reason}
                </p>
              )}
            </li>
          ))}
        </ul>
      </Dialog>
    </>
  );
}
