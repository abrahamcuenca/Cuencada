/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** API base: a same-origin path (default `/api`) or an absolute URL (`https:` only in production). Never a secret. */
  readonly VITE_API_BASE_URL?: string;
  /** Bucket origin that presigned upload URLs must match (`https:` only in production). Never a secret. */
  readonly VITE_MEDIA_UPLOAD_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
