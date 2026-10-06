/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** API base: a same-origin path (default `/api`) or an absolute http(s) URL. Never a secret. */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
