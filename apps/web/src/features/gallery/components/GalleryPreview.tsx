import { Link } from "react-router-dom";
import { useAppSelector } from "../../../app/hooks";
import { Button } from "../../../shared/ui/Button";
import { Skeleton } from "../../../shared/ui/Skeleton";
import { selectCurrentUser, selectPasswordChangeRequired } from "../../auth/authSlice";
import { PREVIEW_SIZE, useMediaHeadQuery } from "../api";
import styles from "../gallery.module.css";
import { mediaAlt } from "../lib/mediaText";
import { useExpiredUrlRefetch } from "../lib/useExpiredUrlRefetch";

/** Props for {@link GalleryPreview}. */
export interface GalleryPreviewProps {
  year: number;
  /** Heading level of "Álbum vivo" in the host page (default h2). */
  headingLevel?: 2 | 3;
}

/**
 * The latest {@link PREVIEW_SIZE} photos of a year plus "Ver álbum", for the
 * year page (T2). Members only: renders nothing for visitors (the host shows
 * its own lock state), so it never calls the API anonymously.
 *
 * @example
 * <GalleryPreview year={2026} />
 */
export function GalleryPreview({ year, headingLevel = 2 }: GalleryPreviewProps): React.ReactNode {
  const user = useAppSelector(selectCurrentUser);
  const passwordChangeRequired = useAppSelector(selectPasswordChangeRequired);
  const blocked = user === null || passwordChangeRequired;
  const { data, isLoading, isError, refetch } = useMediaHeadQuery({ year, limit: PREVIEW_SIZE }, { skip: blocked });
  const onMediaError = useExpiredUrlRefetch(refetch);
  if (blocked) return null;

  const Heading = headingLevel === 3 ? "h3" : "h2";
  const items = (data?.items ?? []).filter((item) => item.uploadStatus === "ready" && item.thumbUrl !== null);
  const albumPath = `/galeria/${year}`;

  return (
    <section className={styles.preview} aria-labelledby={`gallery-preview-${year}`}>
      <Heading id={`gallery-preview-${year}`}>📸 Álbum vivo</Heading>
      {isLoading ? (
        <ul className={styles.previewGrid} aria-hidden="true">
          {Array.from({ length: PREVIEW_SIZE }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders never reorder.
            <li key={i} className={styles.tile}>
              <Skeleton shape="block" height="100%" className={styles.skeletonTile} />
            </li>
          ))}
        </ul>
      ) : isError ? (
        <p className={styles.hint}>No pudimos cargar las fotos.</p>
      ) : items.length === 0 ? (
        <p className={styles.hint}>Aún no hay fotos de este año. ¡Sé el primero en subir!</p>
      ) : (
        <ul className={styles.previewGrid}>
          {items.map((item) => (
            <li key={item.id} className={styles.tile}>
              <Link to={albumPath} aria-label={`${mediaAlt(item)} (abrir álbum)`}>
                <img
                  src={item.thumbUrl ?? ""}
                  alt=""
                  width={400}
                  height={400}
                  loading="lazy"
                  decoding="async"
                  className={styles.thumb}
                  onError={onMediaError}
                />
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Button to={albumPath} variant="secondary" iconEnd="→">
        {items.length === 0 && !isLoading ? "Subir fotos" : "Ver álbum"}
      </Button>
    </section>
  );
}
