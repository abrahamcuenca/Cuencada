import type { ReactNode } from "react";
import { Card } from "../../../shared/ui/Card";
import styles from "./content.module.css";

/**
 * "Nuestra canción": the native audio player. `preload="none"` so the MP3 is
 * downloaded only when someone presses play (it is several MB on 4G).
 */
export function SongPlayer({ src, title }: { src: string; title: string }): ReactNode {
  return (
    <Card className={styles.song}>
      <p>Escucha la canción oficial de la reunión familiar.</p>
      {/* biome-ignore lint/a11y/useMediaCaption: a song without a lyrics track yet; the contract has no captions URL (Request R4 in WP-T2-FE). */}
      <audio controls preload="none" src={src} className={styles.audio} aria-label={`Canción oficial de la ${title}`}>
        Tu navegador no puede reproducir este audio.
      </audio>
    </Card>
  );
}
