/** App-local event so the global context menu can trigger a workbench panel
 * row's own inline-rename input without either side owning the other's
 * state, mirroring `command-palette-events.ts`. */

export const REQUEST_WORKBENCH_RENAME_EVENT =
  "workbench:request-workbench-rename";

export type WorkbenchRenameRequest = { readonly workbenchId: string };

export function requestWorkbenchRename(workbenchId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<WorkbenchRenameRequest>(REQUEST_WORKBENCH_RENAME_EVENT, {
      detail: { workbenchId },
    }),
  );
}

export function isWorkbenchRenameRequestFor(
  event: Event,
  workbenchId: string,
): boolean {
  return (
    event instanceof CustomEvent &&
    (event.detail as WorkbenchRenameRequest | undefined)?.workbenchId ===
      workbenchId
  );
}
