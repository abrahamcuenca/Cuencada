import type { MediaItem } from "@cuencada/types";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { getApiErrorCode, isAbortError } from "../../../shared/api/errors";
import { Button } from "../../../shared/ui/Button";
import { Dialog } from "../../../shared/ui/Dialog";
import { IconButton } from "../../../shared/ui/IconButton";
import { Lightbox, type LightboxItem } from "../../../shared/ui/Lightbox";
import styles from "../gallery.module.css";
import { mediaAlt, uploadedByLine } from "../lib/mediaText";
import { useMediaDetailQuery } from "../social/api";
import type { SocialSheet, TagPoint } from "../social/types";
import { DeleteMediaDialog, EditCaptionDialog, ReportDialog } from "./ItemDialogs";
import { isViewable } from "./MediaGrid";

// WP-6.2: the social layer is its own chunk, fetched the first time a photo opens.
const loadSocial = () => import("../social/LightboxSocial");
const SocialFooter = lazy(async () => ({ default: (await loadSocial()).SocialFooter }));
const SocialOverlay = lazy(async () => ({ default: (await loadSocial()).SocialOverlay }));
const SocialSheets = lazy(async () => ({ default: (await loadSocial()).SocialSheets }));

type OpenDialog = "caption" | "delete" | "report" | null;

/** Shown for a `?foto=` id that is missing or not visible to the caller (the same for both). */
export const PHOTO_NOT_FOUND_TITLE = "No encontramos esa foto";

/** Props for {@link GalleryLightbox}. */
export interface GalleryLightboxProps {
  /** Viewable items only (ready, with a `displayUrl`). */
  items: readonly MediaItem[];
  /**
   * Id of the open item, or `null`. An id that is not in `items` (a
   * `?foto=<id>` deep link to a photo not loaded yet) is fetched on its own
   * through `GET /api/media/:id/detail`.
   */
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
 * The open item's source: the loaded list, or (deep link) the per-item detail.
 *
 * @returns The items the lightbox shows and whether the deep-linked photo was not found.
 */
function useLightboxSource(items: readonly MediaItem[], openId: string | null): { source: readonly MediaItem[]; notFound: boolean } {
  const inList = openId !== null && items.some((item) => item.id === openId);
  const needsDetail = openId !== null && !inList;
  const { data, error, isError } = useMediaDetailQuery(openId ?? "", { skip: !needsDetail });
  return useMemo(() => {
    if (!needsDetail) return { source: items, notFound: false };
    if (data && data.item.id === openId) {
      return isViewable(data.item) ? { source: [data.item], notFound: false } : { source: [], notFound: true };
    }
    const notFound = isError && !isAbortError(error) && getApiErrorCode(error) === "NOT_FOUND";
    return { source: [], notFound };
  }, [needsDetail, items, data, openId, isError, error]);
}

/**
 * The shared `Lightbox` plus item actions: edit and delete follow the
 * server-computed `canEdit`/`canDelete` (uploader or admin); anyone but the
 * uploader reports. WP-6.2 adds the social layer (hearts, tags, comments;
 * lazy) and the `?foto=<id>` deep link. Server rules still apply: these
 * buttons are UX only. WP-6.3 reuses this component unchanged.
 */
export function GalleryLightbox({ items, openId, onOpenIdChange, onMediaError }: GalleryLightboxProps): React.ReactNode {
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const [sheet, setSheet] = useState<SocialSheet | null>(null);
  const [placing, setPlacing] = useState(false);
  const [point, setPoint] = useState<TagPoint | null>(null);
  const { source, notFound } = useLightboxSource(items, openId);
  const lightboxItems = useMemo(() => source.map(toLightboxItem), [source]);
  const found = openId === null ? -1 : source.findIndex((item) => item.id === openId);
  const index = found === -1 ? null : found;
  const current = index === null ? undefined : source[index];
  const currentId = current?.id;

  // A new photo starts with no sheet, no pending placement and no picked point.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on item change only.
  useEffect(() => {
    setSheet(null);
    setPlacing(false);
    setPoint(null);
  }, [currentId]);

  const close = useCallback((): void => {
    setDialog(null);
    setSheet(null);
    onOpenIdChange(null);
  }, [onOpenIdChange]);

  const actions = current ? (
    <>
      {current.canEdit ? (
        <IconButton label="Editar descripción" icon="✏️" variant="inverse" onClick={() => setDialog("caption")} />
      ) : null}
      {current.canDelete ? (
        <IconButton label="Eliminar" icon="🗑️" variant="inverse" onClick={() => setDialog("delete")} />
      ) : null}
      {current.isMine ? null : <IconButton label="Reportar" icon="⚑" variant="inverse" onClick={() => setDialog("report")} />}
    </>
  ) : null;

  const footer = current ? (
    <Suspense fallback={null}>
      <SocialFooter
        item={current}
        onOpenSheet={setSheet}
        placing={placing}
        onCancelPlacing={() => {
          setPlacing(false);
          setSheet("tag");
        }}
      />
    </Suspense>
  ) : null;

  const overlay = current ? (
    <Suspense fallback={null}>
      <SocialOverlay
        item={current}
        placing={placing}
        onPlace={(picked) => {
          setPoint(picked);
          setPlacing(false);
          setSheet("tag");
        }}
      />
    </Suspense>
  ) : null;

  return (
    // React propagates media `error` events, so one handler covers the Lightbox's <img>/<video>.
    <div onError={onMediaError}>
      <Lightbox
        items={lightboxItems}
        index={index}
        onIndexChange={(next) => onOpenIdChange(source[next]?.id ?? null)}
        onClose={close}
        actions={actions}
        footer={footer}
        overlay={overlay}
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
          <Suspense fallback={null}>
            <SocialSheets
              item={current}
              sheet={sheet}
              onClose={() => setSheet(null)}
              point={point}
              onStartPlacing={() => {
                setSheet(null);
                setPlacing(true);
              }}
              onClearPoint={() => setPoint(null)}
            />
          </Suspense>
        </>
      ) : null}
      <Dialog
        open={notFound}
        onClose={() => onOpenIdChange(null)}
        title={PHOTO_NOT_FOUND_TITLE}
        description="Puede que la hayan quitado o que no tengas acceso a ella."
        footer={
          <Button fullWidth onClick={() => onOpenIdChange(null)}>
            Entendido
          </Button>
        }
      />
    </div>
  );
}
