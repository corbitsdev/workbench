// A one-shot payload carried alongside a "New routine" pending-dialog
// request (see command-palette-actions.ts / pending-dialog-request.ts) so
// "Make this a routine" on a completed task result can prefill the dialog
// with that task's agent and prompt, whether the create dialog is already
// mounted (Routines page) or has to be navigated to first. The pending
// flag and this payload are set together and consumed together — this
// module only holds the data half.

export type RoutinePrefill = {
  readonly definitionId: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
};

let pending: RoutinePrefill | null = null;

export function setPendingRoutinePrefill(prefill: RoutinePrefill): void {
  pending = prefill;
}

/** One-shot read: returns the pending prefill (or null) and clears it. */
export function consumePendingRoutinePrefill(): RoutinePrefill | null {
  const value = pending;
  pending = null;
  return value;
}

/** Test helper — drop leftover pending state between cases. */
export function resetPendingRoutinePrefill(): void {
  pending = null;
}
