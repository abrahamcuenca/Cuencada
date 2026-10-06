/** Machine-readable reasons an email could not be rendered. */
export const EmailRenderErrorCode = {
  InvalidUrl: "INVALID_URL",
  InsecureUrl: "INSECURE_URL",
  InvalidDate: "INVALID_DATE",
  InvalidDuration: "INVALID_DURATION",
  InvalidOption: "INVALID_OPTION",
} as const;

export type EmailRenderErrorCode =
  (typeof EmailRenderErrorCode)[keyof typeof EmailRenderErrorCode];

/**
 * Thrown by `renderEmail` (and the template components) when props are unsafe
 * or malformed. The message never echoes the offending value, because URLs
 * passed here carry single-use tokens that must not reach logs.
 */
export class EmailRenderError extends Error {
  /** Stable code for callers and structured logs. */
  readonly code: EmailRenderErrorCode;
  /** Name of the prop or option that failed validation (never its value). */
  readonly field: string;

  /**
   * @param code - Stable error code.
   * @param field - Prop or option name that failed validation.
   * @param message - Human-readable description without the offending value.
   */
  constructor(code: EmailRenderErrorCode, field: string, message: string) {
    super(message);
    this.name = "EmailRenderError";
    this.code = code;
    this.field = field;
  }

  /** Log-safe serialization: code, field and message only. */
  toJSON(): {
    name: string;
    code: EmailRenderErrorCode;
    field: string;
    message: string;
  } {
    return {
      name: this.name,
      code: this.code,
      field: this.field,
      message: this.message,
    };
  }
}
