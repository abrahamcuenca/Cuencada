import type { Ref, SelectHTMLAttributes } from "react";
import styles from "./controls.module.css";
import { cx } from "./cx";

/** One option for {@link Select}. */
export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/** Props for {@link Select}. */
export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "children"> {
  options: readonly SelectOption[];
  /** Optional first, empty option (e.g. "Elige una opción"). */
  placeholder?: string;
  ref?: Ref<HTMLSelectElement>;
}

/** Native `<select>` (best mobile UX: OS picker) with Cuencada styling. Pair with {@link Field}. */
export function Select({ options, placeholder, className, ...rest }: SelectProps): React.ReactNode {
  return (
    <div className={styles.selectWrap}>
      <select {...rest} className={cx(styles.control, styles.select, className)}>
        {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      <span aria-hidden="true" className={styles.chevron}>
        ▼
      </span>
    </div>
  );
}
