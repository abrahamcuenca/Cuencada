import type { MediaItem } from "@cuencada/types";
import { useMemo, useState } from "react";
import { useAppSelector } from "../../../app/hooks";
import { IconButton } from "../../../shared/ui/IconButton";
import { Lightbox, type LightboxItem } from "../../../shared/ui/Lightbox";
import { selectIsAdmin } from "../../auth/authSlice";
import styles from "../gallery.module.css";
import { mediaAlt, uploadedByLine } from "../lib/mediaText";
import { DeleteMediaDialog, EditCaptionDialog, ReportDialog } from "./ItemDialogs";

type OpenDialog = "caption" | "delete" | "report" | null;

/** Props for {@link GalleryLightbox}. */
export interface GalleryLightboxProps {
  /** Viewable items only (ready, with a `displayUrl`). */
  items: readonly MediaItem[];
  /** Id of the open item, or `null`. */
  openId: string | null;
  onOpenIdChange: (id: string | null) => void;
  /** An image or video failed to load (expired presigned URL). */
  onMediaError: () => void;
}

function toLightboxItem(item: MediaItem): LightboxItem {
  const caption = (
    <div className={styles.caption}>
      {item.caption ? <p>{item.caption}</p> : null}
      <p className={styles.captionMeta}>{uploadedByLine(item)}</p>
    </div>
  );
  const base = { id: item.id, src: item.displayUrl ?? "", alt: mediaAlt(item), caption };
  if (item.kind === "video") {
    return item.thumbUrl ? { ...base, type: "video", poster: item.thumbUrl } : { ...base, type: "video" };
  }
  return item.width !== null && item.height !== null ? { ...base, type: "image", width: item.width, height: item.height } : { ...base, type: "image" };
}

/**
 * The shared `Lightbox` plus item actions: the owner (or an admin) edits the
 * caption and deletes; anyone else reports. Server rules still apply: these
 * buttons are UX only.
 */
export function GalleryLightbox({ items, openId, onOpenIdChange, onMediaError }: GalleryLightboxProps): React.ReactNode {
  const isAdmin = useAppSelector(selectIsAdmin);
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const lightboxItems = useMemo(() => items.map(toLightboxItem), [items]);
  const found = openId === null ? -1 : items.findIndex((item) => item.id === openId);
  const index = found === -1 ? null : found;
  const current = index === null ? undefined : items[index];
  const canManage = current !== undefined && (current.isMine || isAdmin);

  const actions = current ? (
    <>
      {canManage ? (
        <>
          <IconButton label="Editar descripción" icon="✏️" variant="inverse" onClick={() => setDialog("caption")} />
          <IconButton label="Eliminar" icon="🗑️" variant="inverse" onClick={() => setDialog("delete")} />
        </>
      ) : null}
      {current.isMine ? null : <IconButton label="Reportar" icon="⚑" variant="inverse" onClick={() => setDialog("report")} />}
    </>
  ) : null;

  return (
    // React propagates media `error` events, so one handler covers the Lightbox's <img>/<video>.
    <div onError={onMediaError}>
      <Lightbox
        items={lightboxItems}
        index={index}
        onIndexChange={(next) => onOpenIdChange(items[next]?.id ?? null)}
        onClose={() => {
          setDialog(null);
          onOpenIdChange(null);
        }}
        actions={actions}
      />
      {current ? (
        <>
          <EditCaptionDialog key={`c-${current.id}`} item={current} open={dialog === "caption"} onClose={() => setDialog(null)} />
          <DeleteMediaDialog
            item={current}
            open={dialog === "delete"}
            onClose={() => setDialog(null)}
            onDeleted={() => {
              setDialog(null);
              onOpenIdChange(null);
            }}
          />
          <ReportDialog key={`r-${current.id}`} item={current} open={dialog === "report"} onClose={() => setDialog(null)} />
        </>
      ) : null}
    </div>
  );
}
