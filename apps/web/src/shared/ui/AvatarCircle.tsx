import { useState } from "react";
import styles from "./AvatarCircle.module.css";
import { cx } from "./cx";

/** Diameter of an avatar: sm 32, md 48, lg 64 (legacy attendee circle), xl 96 (profile). */
export type AvatarSize = "sm" | "md" | "lg" | "xl";

/** Props for {@link AvatarCircle}. */
export interface AvatarCircleProps {
  /** Full name; used for initials, colour and the accessible name. */
  name: string;
  /** Photo URL (presigned thumbnail). Falls back to initials if missing or broken. */
  src?: string | undefined;
  size?: AvatarSize;
  /** Gold ring, e.g. "confirmed attendee" or "you". */
  highlight?: boolean;
  /** Set when a neighbouring element already shows the name (avoids double announcement). */
  decorative?: boolean;
  className?: string | undefined;
}

const PARTICLES = new Set(["de", "del", "la", "las", "los", "y", "van", "von"]);

/** Up to two initials from a Spanish full name, skipping particles ("María de la Luz Cuenca" → "MC"). */
export function getInitials(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((w) => w && !PARTICLES.has(w.toLowerCase()));
  const first = words[0]?.[0] ?? "";
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? "") : "";
  return (first + last).toLocaleUpperCase("es-MX") || "?";
}

const TONES = ["green", "gold", "bugambilia", "sky", "clay"] as const;

/** Stable colour bucket for a name so the same person always gets the same tint. */
function toneFor(name: string): (typeof TONES)[number] {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) | 0;
  return TONES[Math.abs(hash) % TONES.length] ?? "green";
}

/** Round avatar with a photo or coloured initials fallback (legacy "attendee circle"). */
export function AvatarCircle({ name, src, size = "md", highlight = false, decorative = false, className }: AvatarCircleProps): React.ReactNode {
  // Remember WHICH src failed, so a new src (e.g. a refreshed presigned URL) is tried again.
  const [failedSrc, setFailedSrc] = useState<string | undefined>(undefined);
  const showImage = Boolean(src) && failedSrc !== src;
  return (
    <span
      className={cx(styles.avatar, styles[size], styles[toneFor(name)], highlight && styles.highlight, className)}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : name}
      aria-hidden={decorative ? true : undefined}
    >
      {showImage ? (
        <img src={src} alt="" loading="lazy" decoding="async" className={styles.image} onError={() => setFailedSrc(src)} />
      ) : (
        <span aria-hidden="true">{getInitials(name)}</span>
      )}
    </span>
  );
}
