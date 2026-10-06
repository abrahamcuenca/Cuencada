import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";
import { Link, type LinkProps } from "react-router-dom";
import styles from "./Button.module.css";
import { Spinner } from "./Spinner";
import { cx } from "./cx";

/** Visual style of a {@link Button}. `primary` is the legacy gold pill. */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "whatsapp" | "danger";
/** Button height: sm = 44px (tap minimum), md = 48px, lg = 56px. */
export type ButtonSize = "sm" | "md" | "lg";

/** Props shared by every rendering of {@link Button}. */
export interface ButtonBaseProps {
  /** Visual style. Defaults to `primary` (gold). */
  variant?: ButtonVariant;
  /** Height/padding. Defaults to `md`. Every size meets the 44×44px target. */
  size?: ButtonSize;
  /** Background the button sits on; `dark` adapts `ghost`/`secondary` for the green hero. */
  surface?: "light" | "dark";
  /** Leading icon (emoji or SVG). Rendered `aria-hidden`. */
  icon?: ReactNode;
  /** Trailing icon. Rendered `aria-hidden`. */
  iconEnd?: ReactNode;
  /** Stretch to the container width (common for primary actions on mobile). */
  fullWidth?: boolean;
  /** Shows a spinner, sets `aria-busy` and disables a `<button>`. */
  loading?: boolean;
  className?: string | undefined;
  children: ReactNode;
}

type Conflicting = keyof ButtonBaseProps | "href" | "to";

/** Renders a native `<button>` (default `type="button"`). */
export interface ButtonAsButtonProps extends ButtonBaseProps, Omit<ButtonHTMLAttributes<HTMLButtonElement>, Conflicting> {
  href?: undefined;
  to?: undefined;
}

/** Renders an `<a href>`; use for external URLs (WhatsApp, OneDrive, Maps). */
export interface ButtonAsAnchorProps extends ButtonBaseProps, Omit<AnchorHTMLAttributes<HTMLAnchorElement>, Conflicting> {
  href: string;
  to?: undefined;
  /** Opens in a new tab with `rel="noopener noreferrer"`. */
  external?: boolean;
}

/** Renders a react-router `<Link to>` for in-app navigation. */
export interface ButtonAsLinkProps extends ButtonBaseProps, Omit<LinkProps, Conflicting> {
  to: LinkProps["to"];
  href?: undefined;
}

/** Props for {@link Button}: a button, an external anchor or a router link. */
export type ButtonProps = ButtonAsButtonProps | ButtonAsAnchorProps | ButtonAsLinkProps;

/**
 * Pill button in the Cuencada style. Polymorphic without `asChild`:
 * pass `to` for a router link, `href` for an anchor, or neither for a `<button>`.
 */
export function Button(props: ButtonProps): React.ReactNode {
  const {
    variant = "primary",
    size = "md",
    surface = "light",
    icon,
    iconEnd,
    fullWidth = false,
    loading = false,
    className,
    children,
    ...rest
  } = props;

  const classes = cx(
    styles.button,
    styles[variant],
    styles[size],
    surface === "dark" && styles.onDark,
    fullWidth && styles.fullWidth,
    loading && styles.loading,
    className
  );
  const content = (
    <>
      {loading ? (
        <Spinner size="inline" decorative />
      ) : icon ? (
        <span aria-hidden="true" className={styles.icon}>
          {icon}
        </span>
      ) : null}
      <span className={styles.label}>{children}</span>
      {iconEnd ? (
        <span aria-hidden="true" className={styles.icon}>
          {iconEnd}
        </span>
      ) : null}
    </>
  );

  if (rest.to !== undefined) {
    const { to, href: _href, ...linkProps } = rest as Omit<ButtonAsLinkProps, keyof ButtonBaseProps>; // narrowed by `to`
    return (
      <Link {...linkProps} to={to} className={classes} aria-busy={loading || undefined}>
        {content}
      </Link>
    );
  }

  if (rest.href !== undefined) {
    const { external = false, to: _to, ...anchorProps } = rest as Omit<ButtonAsAnchorProps, keyof ButtonBaseProps>; // narrowed by `href`
    return (
      <a
        {...anchorProps}
        className={classes}
        aria-busy={loading || undefined}
        {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      >
        {content}
      </a>
    );
  }

  const { type = "button", disabled, href: _href, to: _to, ...buttonProps } = rest as Omit<ButtonAsButtonProps, keyof ButtonBaseProps>; // neither `to` nor `href`
  return (
    <button {...buttonProps} type={type} disabled={disabled || loading} aria-busy={loading || undefined} className={classes}>
      {content}
    </button>
  );
}
