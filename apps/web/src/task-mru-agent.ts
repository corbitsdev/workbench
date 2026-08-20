// Remembers the most-recently-used task agent, per bench, so the
// global Cmd+T shortcut can preselect it — the same defensive
// try/catch localStorage access `command-palette-recents.ts` and
// `bench-context.tsx` already use: a private-browsing tab with
// storage disabled just loses the default, never breaks the composer.
// This is browser-local state only, never round-tripped through
// `@corbits/preferences` — losing it on a new device costs nothing
// more than one manual agent pick.

const STORAGE_PREFIX = "workbench.tasks.mru-agent";

function keyFor(tenantId: string): string {
  return `${STORAGE_PREFIX}:${tenantId}`;
}

export function loadMostRecentTaskAgent(tenantId: string): string | null {
  try {
    return window.localStorage.getItem(keyFor(tenantId));
  } catch {
    return null;
  }
}

export function saveMostRecentTaskAgent(
  tenantId: string,
  definitionId: string,
): void {
  try {
    window.localStorage.setItem(keyFor(tenantId), definitionId);
  } catch {
    // Storage disabled or full — the next Cmd+T just opens with no default.
  }
}
