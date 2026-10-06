import { useId } from "react";
import { Button } from "../../../shared/ui/Button";
import { IconButton } from "../../../shared/ui/IconButton";
import { cx } from "../../../shared/ui/cx";
import styles from "../gallery.module.css";
import { CANCELABLE_PHASES, type UploadEntry, type UploadPhase } from "../upload/uploadManager";
import { useUploadManager } from "../upload/useUploadManager";

const DONE: ReadonlySet<UploadPhase> = new Set(["ready", "review"]);
const FINISHED: ReadonlySet<UploadPhase> = new Set(["ready", "review", "processing_failed"]);

function statusText(entry: UploadEntry): string {
  switch (entry.phase) {
    case "queued":
      return "En espera…";
    case "creating":
      return "Preparando…";
    case "uploading":
      return `Subiendo ${Math.round(entry.progress * 100)}%`;
    case "confirming":
      return "Verificando…";
    case "processing":
      return "Procesando…";
    case "ready":
      return "✅ Lista";
    case "review":
      return "✅ Enviada. Un administrador la revisará.";
    case "failed":
      return `⚠️ No se pudo subir. ${entry.error ?? ""}`.trim();
    case "processing_failed":
      return `⚠️ ${entry.error ?? "No pudimos procesar este archivo."}`;
  }
}

/** Props for {@link UploadPanel}. */
export interface UploadPanelProps {
  /** The year being viewed; uploads for other years are labelled. */
  year: number;
}

/**
 * Sticky card above the BottomNav (docked bottom-right on desktop) with
 * per-file progress, cancel and retry. Renders nothing when the list is empty.
 */
export function UploadPanel({ year }: UploadPanelProps): React.ReactNode {
  const { manager, uploads } = useUploadManager();
  const titleId = useId();
  if (uploads.length === 0) return null;

  const done = uploads.filter((u) => DONE.has(u.phase)).length;
  const failed = uploads.filter((u) => u.phase === "failed" || u.phase === "processing_failed").length;
  const finished = uploads.filter((u) => FINISHED.has(u.phase)).length;
  const failures = uploads
    .filter((u) => u.phase === "failed" || u.phase === "processing_failed")
    .map((u) => (u.phase === "failed" ? `No se pudo subir ${u.fileName}.` : `No se pudo procesar ${u.fileName}.`))
    .join(" ");

  return (
    <section className={styles.panel} aria-labelledby={titleId}>
      {/* Per-file failures are announced by name; the visible rows carry the details. */}
      <output aria-live="polite" className="visually-hidden">
        {failures}
      </output>
      <div className={styles.panelHeader}>
        <h2 id={titleId} className={styles.panelTitle} aria-live="polite">
          {done} de {uploads.length} {uploads.length === 1 ? "lista" : "listas"}
          {failed > 0 ? ` · ${failed} con error` : ""}
        </h2>
        {finished > 0 ? (
          <Button size="sm" variant="ghost" onClick={() => manager.clearFinished()}>
            Quitar terminadas
          </Button>
        ) : null}
      </div>
      <ul className={styles.uploadList}>
        {uploads.map((entry) => {
          const isError = entry.phase === "failed" || entry.phase === "processing_failed";
          const isTransferring = entry.phase === "uploading";
          const canCancel = CANCELABLE_PHASES.has(entry.phase);
          return (
            <li key={entry.id} className={styles.uploadRow}>
              <div className={styles.uploadInfo}>
                <p className={styles.uploadName} title={entry.fileName}>
                  {entry.kind === "video" ? "🎬 " : "📷 "}
                  {entry.fileName}
                  {entry.year !== year ? ` (${entry.year})` : ""}
                </p>
                {isTransferring ? (
                  <progress
                    className={styles.progress}
                    max={100}
                    value={Math.round(entry.progress * 100)}
                    aria-label={`Progreso de ${entry.fileName}`}
                  />
                ) : null}
                <p className={cx(styles.uploadStatus, isError && styles.statusError, DONE.has(entry.phase) && styles.statusDone)}>
                  {statusText(entry)}
                </p>
              </div>
              <div className={styles.rowActions}>
                {entry.phase === "failed" ? (
                  <Button size="sm" variant="secondary" onClick={() => manager.retry(entry.id)}>
                    Reintentar
                  </Button>
                ) : null}
                {canCancel ? (
                  <IconButton label={`Cancelar ${entry.fileName}`} icon="✕" variant="plain" onClick={() => manager.cancel(entry.id)} />
                ) : FINISHED.has(entry.phase) ? (
                  <IconButton label={`Quitar ${entry.fileName} de la lista`} icon="✕" variant="plain" onClick={() => manager.dismiss(entry.id)} />
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
