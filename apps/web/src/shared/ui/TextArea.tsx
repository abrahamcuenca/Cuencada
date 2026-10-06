import type { Ref, TextareaHTMLAttributes } from "react";
import styles from "./controls.module.css";
import { cx } from "./cx";

/** Props for {@link TextArea}. */
export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  ref?: Ref<HTMLTextAreaElement>;
}

/** Multi-line text input. Pair with {@link Field}. */
export function TextArea({ className, rows = 4, ...rest }: TextAreaProps): React.ReactNode {
  return <textarea {...rest} rows={rows} className={cx(styles.control, styles.textarea, className)} />;
}
