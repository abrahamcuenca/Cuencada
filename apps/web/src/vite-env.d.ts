/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** API base: a same-origin path (default `/api`) or an absolute URL (`https:` only in production). Never a secret. */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
