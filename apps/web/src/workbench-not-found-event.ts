/** Lets a workbench-level 404 tell the palette to drop a stale Recents
 * entry, without coupling the chat route to `CommandPaletteProvider`. */

export const WORKBENCH_NOT_FOUND_EVENT = "workbench:workbench-not-found";

export function reportWorkbenchNotFound(workbenchId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(WORKBENCH_NOT_FOUND_EVENT, { detail: workbenchId }));
}
