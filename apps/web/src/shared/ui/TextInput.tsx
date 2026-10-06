import type { InputHTMLAttributes, Ref } from "react";
import styles from "./controls.module.css";
import { cx } from "./cx";

/** Props for {@link TextInput}. Always set `type`, `inputMode` and `autoComplete` deliberately. */
export interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  ref?: Ref<HTMLInputElement>;
}

/** Single-line text input (16px text so iOS never zooms). Pair with {@link Field}. */
export function TextInput({ className, type = "text", ...rest }: TextInputProps): React.ReactNode {
  return <input {...rest} type={type} className={cx(styles.control, className)} />;
}
