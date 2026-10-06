import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from "react";
import styles from "./Tabs.module.css";
import { cx } from "./cx";

/** One tab of {@link Tabs}. */
export interface TabItem {
  id: string;
  label: ReactNode;
  content: ReactNode;
  disabled?: boolean;
}

/** Props for {@link Tabs}. */
export interface TabsProps {
  items: readonly TabItem[];
  /** Controlled selected id. */
  value?: string;
  /** Uncontrolled initial id (defaults to the first enabled tab). */
  defaultValue?: string;
  onChange?: (id: string) => void;
  /** Accessible name of the tablist, e.g. "Días del programa". */
  label: string;
  /** `pill` = segmented control (mobile default), `underline` = classic tabs. */
  variant?: "pill" | "underline";
  className?: string | undefined;
}

/**
 * WAI-ARIA tabs with roving tabindex: ←/→ move, Home/End jump, selection follows focus.
 * The tablist scrolls horizontally on narrow screens instead of wrapping.
 */
export function Tabs({ items, value, defaultValue, onChange, label, variant = "pill", className }: TabsProps): React.ReactNode {
  const baseId = useId();
  // With no enabled tab, still keep the first tab reachable so the tablist is never a keyboard dead end.
  const firstEnabled = items.find((i) => !i.disabled)?.id ?? items[0]?.id ?? "";
  const [internal, setInternal] = useState(defaultValue ?? firstEnabled);
  const requested = value ?? internal;
  // Fall back when the (controlled) value matches no selectable tab, so exactly one tab has tabIndex=0.
  const selected = items.some((i) => i.id === requested && !i.disabled) ? requested : firstEnabled;
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());

  const select = (id: string): void => {
    if (value === undefined) setInternal(id);
    onChange?.(id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const enabled = items.filter((i) => !i.disabled);
    const index = enabled.findIndex((i) => i.id === selected);
    let next: TabItem | undefined;
    if (event.key === "ArrowRight") next = enabled[(index + 1) % enabled.length];
    else if (event.key === "ArrowLeft") next = enabled[(index - 1 + enabled.length) % enabled.length];
    else if (event.key === "Home") next = enabled[0];
    else if (event.key === "End") next = enabled[enabled.length - 1];
    if (!next) return;
    event.preventDefault();
    select(next.id);
    tabRefs.current.get(next.id)?.focus();
  };

  return (
    <div className={cx(styles.tabs, styles[variant], className)}>
      <div role="tablist" aria-label={label} className={styles.list} onKeyDown={onKeyDown}>
        {items.map((item) => {
          const isSelected = item.id === selected;
          return (
            <button
              key={item.id}
              ref={(el) => {
                if (el) tabRefs.current.set(item.id, el);
                else tabRefs.current.delete(item.id);
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${item.id}`}
              aria-controls={`${baseId}-panel-${item.id}`}
              aria-selected={isSelected}
              tabIndex={isSelected ? 0 : -1}
              disabled={item.disabled}
              className={cx(styles.tab, isSelected && styles.selected)}
              onClick={() => select(item.id)}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      {items.map((item) => (
        <div
          key={item.id}
          role="tabpanel"
          id={`${baseId}-panel-${item.id}`}
          aria-labelledby={`${baseId}-tab-${item.id}`}
          hidden={item.id !== selected}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: WAI-ARIA APG makes tabpanels focusable so panels without focusable content are reachable.
          tabIndex={0}
          className={styles.panel}
        >
          {item.id === selected ? item.content : null}
        </div>
      ))}
    </div>
  );
}
