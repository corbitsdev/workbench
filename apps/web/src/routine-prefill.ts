// A one-shot payload carried alongside a "New routine" pending-dialog
// request (see command-palette-actions.ts / pending-dialog-request.ts) so
// a caller can prefill the create dialog before it's even mounted, whether
// that's "Make this a routine" on a completed task result (catalog pick +
// name + input) or "New routine in this space" from a channel header
// (just a destination). The pending flag and this payload are set
// together and consumed together — this module only holds the data half.

export type RoutinePrefill = {
  readonly definitionId?: string;
  readonly name?: string;
  readonly input?: Record<string, unknown>;
  /** Pre-binds the Configure step's destination picker to this space —
   * still just a selection, not a commitment; the person can change it
   * before creating. Set by "New routine in this space". */
  readonly deliveryChannelId?: string;
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
