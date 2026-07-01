// Browser-safe constants shared by the server workflow definition (index.ts)
// and the client panel (ui.tsx). This module must stay dependency-free: ui.tsx
// is lazily imported into the browser via the package's `/ui` export, so it
// must never transitively pull the workflow definition (which imports
// `@workbench/agents` → `@intx/agent`, server-only). Importing MAX_ROUNDS from
// here — not from ./index — keeps the browser chunk clean.

// Number of generate → render → preview rounds.
export const MAX_ROUNDS = 3;
