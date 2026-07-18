/// <reference types="vite/client" />

// Injected by Vite `define` from the monorepo root package.json version.
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  readonly VITE_APP_ENV?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
