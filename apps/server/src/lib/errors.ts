/**
 * Application errors. Throw an {@link AppError} from any route, hook or
 * service; the global error handler (`plugins/errors.ts`) turns it into the
 * `ApiError` envelope with the status from `errorHttpStatus`.
 */
import { type ApiErrorDetail, type ErrorCode, errorHttpStatus } from "@cuencada/types";

/** Default Spanish, user-presentable message for each error code. */
export const defaultErrorMessages = {
  VALIDATION: "Revisa los datos enviados.",
  UNAUTHENTICATED: "No has iniciado sesión.",
  TOKEN_EXPIRED: "Tu sesión expiró. Vuelve a intentarlo.",
  INVALID_CREDENTIALS: "Correo o contraseña incorrectos.",
  FORBIDDEN: "No tienes permiso para hacer esto.",
  PASSWORD_CHANGE_REQUIRED: "Debes cambiar tu contraseña antes de continuar.",
  EMAIL_UNVERIFIED: "Confirma tu correo electrónico para ver esta sección.",
  CSRF_FAILED: "No pudimos verificar el origen de la solicitud.",
  NOT_FOUND: "No encontramos lo que buscas.",
  CONFLICT: "La operación entra en conflicto con datos existentes.",
  REFRESH_RACE: "Otra pestaña está renovando tu sesión. Intenta de nuevo.",
  INVITE_INVALID: "La invitación no es válida o ya venció.",
  TOKEN_INVALID: "El enlace no es válido o ya venció.",
  UPLOAD_INVALID: "El archivo no es válido.",
  PAYLOAD_TOO_LARGE: "La solicitud es demasiado grande.",
  RATE_LIMITED: "Demasiados intentos. Espera un momento y vuelve a intentarlo.",
  SERVICE_UNAVAILABLE: "El servicio no está disponible en este momento.",
  INTERNAL: "Ocurrió un error inesperado. Intenta de nuevo más tarde."
} as const satisfies Record<ErrorCode, string>;

/** Options for {@link AppError}. */
export interface AppErrorOptions {
  /** Field-level problems (capped by the error handler). */
  details?: ApiErrorDetail[];
  /** Underlying error, logged server-side only; never sent to the client. */
  cause?: unknown;
  /** Extra response headers, e.g. `Retry-After`. */
  headers?: Record<string, string>;
}

/**
 * An expected, client-facing failure. `message` must be Spanish and safe to
 * show: no internals, token material or other users' data.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: ApiErrorDetail[] | undefined;
  readonly headers: Record<string, string> | undefined;

  /**
   * @param code - Machine-readable code; the HTTP status comes from `errorHttpStatus`.
   * @param message - Spanish message; defaults to {@link defaultErrorMessages}.
   * @param options - Details, cause and headers.
   */
  constructor(code: ErrorCode, message?: string, options: AppErrorOptions = {}) {
    super(message ?? defaultErrorMessages[code], options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.statusCode = errorHttpStatus[code];
    this.details = options.details;
    this.headers = options.headers;
  }
}

/** Type guard for {@link AppError}. */
export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
