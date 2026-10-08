import type { CurrentUser } from "@cuencada/types";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { selectPasswordChangeRequired } from "../features/auth/authSlice";
import { logout } from "../features/auth/session";
import { PROFILE_CONTACT_PATH, PROFILE_PATH } from "../features/profile/paths";
import { reportUnexpected } from "../shared/lib/reportUnexpected";
import { AvatarCircle } from "../shared/ui/AvatarCircle";
import styles from "./accountMenu.module.css";
import { useAppDispatch, useAppSelector } from "./hooks";

/** Accessible-name prefix of the account button ("Mi cuenta: Prima"). */
export const ACCOUNT_MENU_LABEL = "Mi cuenta";

interface AccountLink {
  to: string;
  label: string;
  icon: string;
}

const MEMBER_LINKS: readonly AccountLink[] = [
  { to: PROFILE_PATH, label: "Mi perfil", icon: "🙂" },
  { to: PROFILE_CONTACT_PATH, label: "Contacto", icon: "📇" },
  { to: "/perfil/sesiones", label: "Sesiones y seguridad", icon: "🔐" }
];

/** The admin console entry. Lives only here, not in the TopNav links (no duplicate, WP-4.7). */
const ADMIN_LINK: AccountLink = { to: "/admin", label: "Panel", icon: "⭐" };

/**
 * @param user - The logged-in user.
 * @returns The first word of the display name (e.g. "Prima"), for the account button.
 */
export function firstName(user: Pick<CurrentUser, "displayName" | "email">): string {
  const first = user.displayName.trim().split(/\s+/)[0];
  return first !== undefined && first !== "" ? first : "Tú";
}

/**
 * The account entry of the TopNav for members and admins (WP-4.7): the
 * user's avatar (or initials) and first name; it opens a disclosure list with
 * Mi perfil, Contacto (`/perfil#contacto`), Sesiones y seguridad, Panel
 * (admins) and Cerrar sesión.
 *
 * Keyboard: Enter/Space toggle; ArrowDown/ArrowUp open and move between the
 * entries; Home/End jump; Escape closes and returns focus to the button.
 * A click outside, focus leaving the menu, or a navigation closes it.
 * During a forced password change only "Cerrar sesión" is offered (every
 * other page would bounce back to the change).
 *
 * "Panel" is a UX hint only; the server enforces the role.
 */
export function AccountMenu({ user }: { user: CurrentUser }): ReactNode {
  const dispatch = useAppDispatch();
  const mustChange = useAppSelector(selectPasswordChangeRequired);
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  /** Entry to focus once the list renders: "first", "last" or none (pointer open). */
  const pendingFocus = useRef<"first" | "last" | null>(null);
  /** A press inside the menu is in progress (Safari blurs the button on press without focusing the entry). */
  const pressInside = useRef(false);

  const links = mustChange ? [] : user.role === "admin" ? [...MEMBER_LINKS, ADMIN_LINK] : MEMBER_LINKS;

  // Any navigation (an entry, the back button, another link) closes the menu.
  // biome-ignore lint/correctness/useExhaustiveDependencies: location.key is the trigger, not a value read inside.
  useEffect(() => {
    setOpen(false);
  }, [location.key]);

  // Click/tap outside closes without stealing focus.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target) === false) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open || pendingFocus.current === null) return;
    const items = menuItems(listRef.current);
    const target = pendingFocus.current === "first" ? items[0] : items[items.length - 1];
    pendingFocus.current = null;
    target?.focus();
  }, [open]);

  const close = (returnFocus: boolean): void => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  };

  const onButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const edge = event.key === "ArrowDown" ? "first" : "last";
    if (open) {
      const items = menuItems(listRef.current);
      (edge === "first" ? items[0] : items[items.length - 1])?.focus();
      return;
    }
    pendingFocus.current = edge;
    setOpen(true);
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    const items = menuItems(listRef.current);
    const index = items.findIndex((item) => item === document.activeElement);
    let next: HTMLElement | undefined;
    switch (event.key) {
      case "ArrowDown":
        next = items[(index + 1) % items.length];
        break;
      case "ArrowUp":
        next = items[(index - 1 + items.length) % items.length];
        break;
      case "Home":
        next = items[0];
        break;
      case "End":
        next = items[items.length - 1];
        break;
      default:
        return;
    }
    event.preventDefault();
    next?.focus();
  };

  const name = firstName(user);

  return (
    <div
      ref={rootRef}
      className={styles.root}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          close(true);
        }
      }}
      onPointerDown={() => {
        pressInside.current = true;
        document.addEventListener(
          "pointerup",
          () => {
            pressInside.current = false;
          },
          { once: true, capture: true }
        );
      }}
      onBlur={(event) => {
        // Tab out of the last entry (or Shift+Tab out of the button) closes it.
        if (pressInside.current) return;
        if (open && !(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setOpen(false);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className={styles.trigger}
        aria-expanded={open}
        aria-controls={listId}
        // Keeps the visible first name in the name (label-in-name); phones show only the avatar.
        aria-label={`${ACCOUNT_MENU_LABEL}: ${name}`}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onButtonKeyDown}
      >
        <AvatarCircle name={user.displayName} src={user.avatarUrl ?? undefined} size="sm" decorative />
        <span className={styles.name}>{name}</span>
        <span aria-hidden="true" className={styles.caret}>
          ▾
        </span>
      </button>
      <ul id={listId} ref={listRef} className={styles.list} hidden={!open} onKeyDown={onListKeyDown}>
        {links.map((link) => (
          <li key={link.to}>
            <Link to={link.to} className={styles.item} onClick={() => setOpen(false)}>
              <span aria-hidden="true" className={styles.icon}>
                {link.icon}
              </span>
              {link.label}
            </Link>
          </li>
        ))}
        <li className={links.length > 0 ? styles.separated : undefined}>
          <button
            type="button"
            className={styles.item}
            onClick={() => {
              setOpen(false);
              dispatch(logout()).catch(reportUnexpected);
            }}
          >
            <span aria-hidden="true" className={styles.icon}>
              🚪
            </span>
            Cerrar sesión
          </button>
        </li>
      </ul>
    </div>
  );
}

/** The focusable entries of the open list, in order. */
function menuItems(list: HTMLUListElement | null): HTMLElement[] {
  return list === null ? [] : [...list.querySelectorAll<HTMLElement>("a, button")];
}
