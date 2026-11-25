/** Injected at build time via `define` in vite.config.ts. */
declare const __APP_VERSION__: string;
declare const __GIT_COMMIT__: string;

interface ImportMetaEnv {
  readonly VITE_WS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
