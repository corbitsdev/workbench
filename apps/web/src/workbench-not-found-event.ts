/** App-local event so a workbench-level 404 (`chat-page.tsx`, driven by
 * `ChatWorkspace`'s `onWorkbenchNotFound`) can tell the command palette to
 * drop a stale Recents entry, without coupling the chat route to
 * `CommandPaletteProvider` state — the chat route and that provider are
 * siblings in the Shell. */

export const WORKBENCH_NOT_FOUND_EVENT = "workbench:workbench-not-found";

export function reportWorkbenchNotFound(workbenchId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(WORKBENCH_NOT_FOUND_EVENT, { detail: workbenchId }),
  );
}
