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

/**
 * Validates `VITE_MEDIA_UPLOAD_ORIGIN`: the bucket origin that presigned
 * upload URLs must point to [SEC]. The gallery refuses to PUT a file anywhere
 * else, even if an API response names another host.
 *
 * Accepted values: an absolute `http:`/`https:` origin (a bare trailing `/`
 * is allowed), with no credentials, path, query or fragment. In production
 * it must be `https:`. Unset or blank means "not configured": uploads are
 * refused (fail closed).
 *
 * @param raw - The raw env value.
 * @param production - True for production builds (`import.meta.env.PROD`).
 * @returns The normalised origin (e.g. `https://cuencada.us-southeast-1.linodeobjects.com`), or `null` when unset.
 * @throws {EnvConfigError} When the value is not an allowed origin.
 */
export function resolveMediaUploadOrigin(raw: string | undefined, production = false): string | null {
  const value = raw?.trim() ?? "";
  if (value === "") return null;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EnvConfigError(`VITE_MEDIA_UPLOAD_ORIGIN no es una URL válida: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new EnvConfigError("VITE_MEDIA_UPLOAD_ORIGIN debe usar http: o https:.");
  }
  if (production && url.protocol !== "https:") {
    throw new EnvConfigError("En producción VITE_MEDIA_UPLOAD_ORIGIN debe usar https:.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new EnvConfigError("VITE_MEDIA_UPLOAD_ORIGIN no puede incluir credenciales.");
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new EnvConfigError("VITE_MEDIA_UPLOAD_ORIGIN debe ser solo un origen (sin ruta, query ni fragmento).");
  }
  return url.origin;
}

/** Typed, validated client environment. */
export interface ClientEnv {
  /** Absolute API base URL without a trailing slash, e.g. `https://cuencada.com/api`. */
  apiBaseUrl: string;
  /** Bucket origin for presigned media uploads, or `null` when not configured (uploads refused). */
  mediaUploadOrigin: string | null;
  /** True in `vite dev`; dev-only routes such as `/_ui` depend on it. */
  isDev: boolean;
}

/** The validated environment for this build. */
export const env: ClientEnv = {
  apiBaseUrl: resolveApiBaseUrl(import.meta.env.VITE_API_BASE_URL, window.location.origin, import.meta.env.PROD),
  mediaUploadOrigin: resolveMediaUploadOrigin(import.meta.env.VITE_MEDIA_UPLOAD_ORIGIN, import.meta.env.PROD),
  isDev: import.meta.env.DEV
};
