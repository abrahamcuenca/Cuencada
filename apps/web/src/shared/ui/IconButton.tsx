import type { ButtonHTMLAttributes, ReactNode } from "react";
import styles from "./IconButton.module.css";
import { cx } from "./cx";

/** Props for {@link IconButton}. */
export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "children"> {
  /** Required accessible name (the icon itself is hidden from assistive tech). */
  label: string;
  /** Emoji or SVG icon. */
  icon: ReactNode;
  /** `soft` = tinted round button, `plain` = transparent, `inverse` = for dark overlays (lightbox). */
  variant?: "soft" | "plain" | "inverse" | "solid";
  /** 44px (default) or 56px. Never smaller than the tap minimum. */
  size?: "md" | "lg";
}

/** Round, icon-only button with a mandatory accessible label and a 44×44px minimum target. */
export function IconButton({ label, icon, variant = "soft", size = "md", className, type = "button", ...rest }: IconButtonProps): React.ReactNode {
  return (
    <button {...rest} type={type} aria-label={label} title={rest.title ?? label} className={cx(styles.iconButton, styles[variant], styles[size], className)}>
      <span aria-hidden="true" className={styles.glyph}>
        {icon}
      </span>
    </button>
  );
}
