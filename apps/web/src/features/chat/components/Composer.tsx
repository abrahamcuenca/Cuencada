import { CHAT_BODY_MAX_LENGTH } from "@cuencada/types";
import { type FormEvent, type KeyboardEvent, type ReactNode, type Ref, useId, useLayoutEffect, useRef, useState } from "react";
import { cx } from "../../../shared/ui/cx";
import { IconButton } from "../../../shared/ui/IconButton";
import styles from "../chat.module.css";

/** The counter appears from this many characters (90% of the limit). */
export const COUNTER_FROM = Math.floor(CHAT_BODY_MAX_LENGTH * 0.9);
/** The textarea grows up to this many lines, then scrolls. */
export const MAX_LINES = 5;

/**
 * Whether Enter should send: only with a fine pointer and hover (a desktop
 * with a physical keyboard). On phones Enter inserts a newline and the send
 * button sends (wireframes §8.2).
 *
 * @returns True on desktop-like devices.
 */
export function enterSends(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(hover: hover) and (pointer: fine)").matches;
}

/** Props for {@link Composer}. */
export interface ComposerProps {
  /** Sends the text; returns an error message to show, or `null` when accepted. */
  onSend: (body: string) => string | null;
  /** Called (throttled by the caller) while the user types. */
  onTyping: () => void;
  disabled?: boolean;
  ref?: Ref<HTMLTextAreaElement>;
}

function resize(textarea: HTMLTextAreaElement): void {
  const style = window.getComputedStyle(textarea);
  const lineHeight = Number.parseFloat(style.lineHeight) || 20;
  const padding = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
  const border = (Number.parseFloat(style.borderTopWidth) || 0) + (Number.parseFloat(style.borderBottomWidth) || 0);
  const max = lineHeight * MAX_LINES + padding + border;
  textarea.style.height = "auto";
  const wanted = textarea.scrollHeight + border;
  textarea.style.height = `${Math.min(wanted, max)}px`;
  textarea.style.overflowY = wanted > max ? "auto" : "hidden";
}

/**
 * Message composer: an auto-growing textarea (≤ 5 lines), a 44px send button
 * and a character counter near the 2000 limit. Enter sends on desktop and
 * Shift+Enter adds a line; on touch devices Enter always adds a line.
 */
export function Composer({ onSend, onTyping, disabled = false, ref }: ComposerProps): ReactNode {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const localRef = useRef<HTMLTextAreaElement | null>(null);
  const counterId = useId();
  const errorId = useId();
  const inputId = useId();
  const length = value.length;
  const over = length > CHAT_BODY_MAX_LENGTH;
  const blank = value.trim() === "";

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure whenever the text changes.
  useLayoutEffect(() => {
    if (localRef.current !== null) resize(localRef.current);
  }, [value]);

  const submit = (): void => {
    if (blank || over || disabled) return;
    const problem = onSend(value);
    if (problem === null) {
      setValue("");
      setError(null);
    } else {
      setError(problem);
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    submit();
    localRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Enter" || event.shiftKey || event.altKey || event.nativeEvent.isComposing) return;
    if (!enterSends()) return;
    event.preventDefault();
    submit();
  };

  const describedBy = [length >= COUNTER_FROM ? counterId : null, error === null ? null : errorId].filter(Boolean).join(" ");

  return (
    <form className={styles.composer} onSubmit={onSubmit} noValidate>
      <div className={styles.field}>
        <label htmlFor={inputId} className="visually-hidden">
          Mensaje
        </label>
        <textarea
          id={inputId}
          ref={(node) => {
            localRef.current = node;
            if (typeof ref === "function") ref(node);
            else if (ref) ref.current = node;
          }}
          className={styles.textarea}
          rows={1}
          value={value}
          placeholder="Escribe un mensaje…"
          autoComplete="off"
          autoCorrect="on"
          spellCheck
          enterKeyHint="enter"
          aria-invalid={over || error !== null ? true : undefined}
          aria-describedby={describedBy === "" ? undefined : describedBy}
          disabled={disabled}
          onChange={(event) => {
            setValue(event.target.value);
            if (error !== null) setError(null);
            if (event.target.value.trim() !== "") onTyping();
          }}
          onKeyDown={onKeyDown}
        />
        {length >= COUNTER_FROM ? (
          <span id={counterId} className={cx(styles.counter, over && styles.counterOver)}>
            {length.toLocaleString("es-MX")} / {CHAT_BODY_MAX_LENGTH.toLocaleString("es-MX")}
            {over ? " · Demasiado largo" : null}
          </span>
        ) : null}
        {error === null ? null : (
          <p id={errorId} className={styles.composerError} role="alert">
            {error}
          </p>
        )}
      </div>
      <IconButton type="submit" variant="solid" icon="➤" label="Enviar" disabled={disabled || blank || over} />
    </form>
  );
}
