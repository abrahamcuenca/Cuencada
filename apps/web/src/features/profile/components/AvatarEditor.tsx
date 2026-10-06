import { type ChangeEvent, type CSSProperties, type ReactNode, useRef } from "react";
import { AvatarCircle } from "../../../shared/ui/AvatarCircle";
import { Button } from "../../../shared/ui/Button";
import { cx } from "../../../shared/ui/cx";
import { useExpiredUrlRefetch } from "../../gallery/lib/useExpiredUrlRefetch";
import { useGetProfileQuery } from "../api";
import { AVATAR_ACCEPT, useAvatarUpload } from "../lib/useAvatarUpload";
import styles from "../profile.module.css";

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
 * The big round avatar with "Cambiar foto": file picker, local preview,
 * a progress ring while it uploads, and the result in a live region.
 */
export function AvatarEditor({ name, avatarUrl }: AvatarEditorProps): ReactNode {
  const input = useRef<HTMLInputElement>(null);
  const upload = useAvatarUpload();
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
      <Button variant="secondary" size="sm" icon="📷" loading={busy} onClick={() => input.current?.click()}>
        Cambiar foto
      </Button>
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
    </div>
  );
}
