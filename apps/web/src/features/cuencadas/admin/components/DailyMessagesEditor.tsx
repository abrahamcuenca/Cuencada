import {
  DAILY_MESSAGES_IMPORT_MAX_CHARS,
  type DailyMessage,
  DailyMessagesImportMode,
  parseDailyMessagesText
} from "@cuencada/types";
import { type FormEvent, type ReactNode, useState } from "react";
import { parseApiError } from "../../../../shared/api/errors";
import { formatDate } from "../../../../shared/lib/dates";
import { Button } from "../../../../shared/ui/Button";
import { Card } from "../../../../shared/ui/Card";
import { EmptyState } from "../../../../shared/ui/EmptyState";
import { IconButton } from "../../../../shared/ui/IconButton";
import { Skeleton } from "../../../../shared/ui/Skeleton";
import { useToast } from "../../../../shared/ui/Toast";
import { useDeleteDailyMessageMutation, useImportDailyMessagesMutation, useListDailyMessagesQuery } from "../api";
import { type LineError, toLineErrors } from "../forms";
import styles from "../admin.module.css";
import { ConfirmDialog, toastError } from "./common";
import { SelectField, TextField } from "./fields";

// Short labels: a native select truncates long options at 375px; the details go in the hint.
const MODE_OPTIONS = [
  { value: DailyMessagesImportMode.Merge, label: "Agregar o actualizar" },
  { value: DailyMessagesImportMode.Replace, label: "Reemplazar todo" }
] as const;

const PLACEHOLDER = "2026-09-13|¡Bienvenidos a Mérida!\n2026-09-14|Hoy toca cenote: no olvides tu traje de baño.";

/** Import outcome shown under the textarea. */
type ImportFeedback = { kind: "errors"; errors: LineError[]; total: number } | { kind: "message"; text: string } | null;

/** Props for {@link DailyMessagesEditor}. */
export interface DailyMessagesEditorProps {
  cuencadaId: string;
  timeZone: string;
}

/**
 * "Mensajes del día": paste a `mensajes.txt`-style text (`YYYY-MM-DD|mensaje`
 * per line) to import it. The text is checked first with the same parser the
 * server uses (`parseDailyMessagesText`), and every invalid line is listed
 * with its number; the import is all-or-nothing, so nothing is sent until
 * every line is valid. Server-side line errors are shown the same way.
 */
export function DailyMessagesEditor({ cuencadaId, timeZone }: DailyMessagesEditorProps): ReactNode {
  const toast = useToast();
  const messages = useListDailyMessagesQuery(cuencadaId);
  const [importMessages, importState] = useImportDailyMessagesMutation();
  const [remove, removeState] = useDeleteDailyMessageMutation();
  const [text, setText] = useState("");
  const [mode, setMode] = useState<string>(DailyMessagesImportMode.Merge);
  const [feedback, setFeedback] = useState<ImportFeedback>(null);
  const [toDelete, setToDelete] = useState<DailyMessage | null>(null);
  const lines = text.split(/\r?\n/);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (text.trim() === "") {
      setFeedback({ kind: "message", text: "Pega al menos una línea con el formato AAAA-MM-DD|mensaje." });
      return;
    }
    if (text.length > DAILY_MESSAGES_IMPORT_MAX_CHARS) {
      setFeedback({ kind: "message", text: "El texto es demasiado grande. Divídelo en partes." });
      return;
    }
    const parsed = parseDailyMessagesText(text);
    if (parsed.errorCount > 0) {
      setFeedback({ kind: "errors", errors: toLineErrors(parsed.errors), total: parsed.errorCount });
      return;
    }
    if (parsed.entries.length === 0) {
      setFeedback({ kind: "message", text: "No encontramos mensajes: las líneas vacías y las que empiezan con # se ignoran." });
      return;
    }
    const importMode = mode === DailyMessagesImportMode.Replace ? DailyMessagesImportMode.Replace : DailyMessagesImportMode.Merge;
    importMessages({ cuencadaId, body: { text, mode: importMode } })
      .unwrap()
      .then((result) => {
        setText("");
        setFeedback(null);
        toast.show({
          message: `Listo: ${result.created} nuevos, ${result.updated} actualizados${result.deleted > 0 ? `, ${result.deleted} eliminados` : ""}.`,
          tone: "success"
        });
      })
      .catch((error: unknown) => {
        const details = parseApiError(error)?.error.details ?? [];
        if (details.length > 0) {
          setFeedback({ kind: "errors", errors: toLineErrors(details), total: details.length });
          return;
        }
        toastError(toast, error);
      });
  };

  const confirmDelete = (): void => {
    if (toDelete === null) return;
    remove({ cuencadaId, date: toDelete.date })
      .unwrap()
      .then(() => {
        toast.show({ message: "Mensaje eliminado.", tone: "success" });
        setToDelete(null);
      })
      .catch((error: unknown) => toastError(toast, error));
  };

  return (
    <div className={styles.editor}>
      <Card padding="sm">
        <form noValidate onSubmit={submit} className={styles.form} aria-label="Importar mensajes del día">
          <TextField
            name="text"
            label="Pega los mensajes"
            required
            hint="Una línea por día: AAAA-MM-DD|mensaje. Las líneas vacías y las que empiezan con # se ignoran."
            value={text}
            onChange={(_name, value) => {
              setText(value);
              setFeedback(null);
            }}
            errors={feedback?.kind === "errors" ? { text: `Hay ${feedback.total === 1 ? "1 línea" : `${feedback.total} líneas`} con error. No se importó nada.` } : {}}
            multiline
          />
          {text === "" ? <p className={styles.muted}>Ejemplo: {PLACEHOLDER.split("\n")[0]}</p> : null}
          {feedback?.kind === "errors" ? <LineErrorList errors={feedback.errors} lines={lines} /> : null}
          {feedback?.kind === "message" ? (
            <p role="alert" className={styles.formError}>
              {feedback.text}
            </p>
          ) : null}
          <SelectField
            name="mode"
            label="Al importar"
            value={mode}
            options={MODE_OPTIONS}
            onChange={(_name, value) => setMode(value)}
            errors={{}}
            hint={
              mode === DailyMessagesImportMode.Replace
                ? "Se borrarán los mensajes que no estén en el texto."
                : "Agrega los días nuevos y actualiza los que ya existen; conserva los demás."
            }
          />
          <div className={styles.formActions}>
            <Button type="submit" loading={importState.isLoading}>
              Importar mensajes
            </Button>
          </div>
        </form>
      </Card>

      <h4 className={styles.subTitle}>Mensajes guardados</h4>
      {messages.data === undefined ? (
        messages.error === undefined ? (
          <Skeleton shape="block" height="6rem" />
        ) : (
          <p role="alert" className={styles.formError}>
            No pudimos cargar los mensajes.
          </p>
        )
      ) : messages.data.length === 0 ? (
        <EmptyState icon="💌" headingLevel={3} title="Sin mensajes" description="Pega el texto de arriba para importarlos." />
      ) : (
        <ul className={styles.rows}>
          {messages.data.map((message) => (
            <li key={message.id}>
              <Card padding="sm" className={styles.row}>
                <div className={styles.rowMain}>
                  <p className={styles.rowMeta}>{formatDate(message.date, timeZone, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</p>
                  <p className={styles.messageText}>{message.message}</p>
                </div>
                <IconButton
                  label={`Eliminar el mensaje del ${formatDate(message.date, timeZone)}`}
                  icon="🗑️"
                  onClick={() => setToDelete(message)}
                />
              </Card>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={toDelete !== null}
        title="¿Eliminar este mensaje?"
        description={toDelete ? `El mensaje del ${formatDate(toDelete.date, timeZone)} ya no se mostrará.` : ""}
        confirmLabel="Eliminar"
        busy={removeState.isLoading}
        onConfirm={confirmDelete}
        onClose={() => setToDelete(null)}
      />
    </div>
  );
}

/** Per-line import errors: "Línea 3 · Fecha inválida" plus the offending text. */
function LineErrorList({ errors, lines }: { errors: readonly LineError[]; lines: readonly string[] }): ReactNode {
  return (
    <ul className={styles.lineErrors} aria-label="Líneas con error">
      {errors.map((error) => {
        const content = error.line === null ? undefined : lines[error.line - 1];
        return (
          <li key={`${error.line ?? "resumen"}-${error.message}`}>
            {error.line === null ? null : <strong>Línea {error.line}: </strong>}
            {error.message}
            {content ? <code className={styles.lineContent}>{content.length > 80 ? `${content.slice(0, 80)}…` : content}</code> : null}
          </li>
        );
      })}
    </ul>
  );
}
