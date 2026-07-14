/// <reference types="vite/client" />

// Injected by Vite `define` from the monorepo root package.json version.
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  readonly VITE_APP_ENV?: string;
  /** Set to "true" at web build time to show Myra's mic control (default off). */
  readonly VITE_MYRA_VOICE_INPUT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
