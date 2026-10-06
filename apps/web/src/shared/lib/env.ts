/**
 * Validated client configuration.
 *
 * Only `VITE_*` variables reach the browser bundle, so nothing here may be a
 * secret. Values are validated once at module load: a bad value fails loudly
 * at startup instead of producing confusing network errors later.
 */

const DEFAULT_API_BASE_URL = "/api";

/** Thrown when a `VITE_*` variable has an unusable value. */
export class EnvConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvConfigError";
  }
}

/**
 * Validates `VITE_API_BASE_URL` and resolves it to an absolute URL without a
 * trailing slash.
 *
 * Accepted values: a same-origin path starting with `/` (default `/api`), or
 * an absolute `http:`/`https:` URL. Anything else (`javascript:`, protocol-
 * relative `//host`, embedded credentials) is rejected. Resolving against the
 * page origin keeps relative bases working outside the browser (tests).
 *
 * In production builds an absolute URL must be `https:` [SEC]: the Bearer
 * token and cookies must never cross the network in cleartext. A same-origin
 * path is always allowed (it inherits the page's scheme).
 *
 * @param raw - The raw env value; `undefined` or empty means the default.
 * @param origin - The page origin used to resolve relative paths.
 * @param production - True for production builds (`import.meta.env.PROD`).
 * @returns The absolute base URL without a trailing slash.
 * @throws {EnvConfigError} When the value is not an allowed URL.
 */
export function resolveApiBaseUrl(raw: string | undefined, origin: string, production = false): string {
  const value = raw === undefined || raw.trim() === "" ? DEFAULT_API_BASE_URL : raw.trim();

  if (value.startsWith("//")) {
    throw new EnvConfigError("VITE_API_BASE_URL no puede ser relativo al protocolo (//host).");
  }

  let url: URL;
  try {
    url = new URL(value, origin);
  } catch {
    throw new EnvConfigError(`VITE_API_BASE_URL no es una URL válida: ${value}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new EnvConfigError("VITE_API_BASE_URL debe usar http: o https:.");
  }
  if (production && url.protocol !== "https:" && !value.startsWith("/")) {
    throw new EnvConfigError("En producción VITE_API_BASE_URL debe usar https: o ser una ruta del mismo origen.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new EnvConfigError("VITE_API_BASE_URL no puede incluir credenciales.");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new EnvConfigError("VITE_API_BASE_URL no puede incluir query ni fragmento.");
  }

  return url.toString().replace(/\/+$/, "");
}

/** Typed, validated client environment. */
export interface ClientEnv {
  /** Absolute API base URL without a trailing slash, e.g. `https://cuencada.com/api`. */
  apiBaseUrl: string;
  /** True in `vite dev`; dev-only routes such as `/_ui` depend on it. */
  isDev: boolean;
}

/** The validated environment for this build. */
export const env: ClientEnv = {
  apiBaseUrl: resolveApiBaseUrl(import.meta.env.VITE_API_BASE_URL, window.location.origin, import.meta.env.PROD),
  isDev: import.meta.env.DEV
};
