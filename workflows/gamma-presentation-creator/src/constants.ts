// Browser-safe constants shared by the server workflow definition (index.ts)
// and the client panel (ui.tsx). This module must stay dependency-free: ui.tsx
// is lazily imported into the browser via the package's `/ui` export, so it
// must never transitively pull the workflow definition (which imports
// `@workbench/agents` → `@intx/agent`, server-only).
