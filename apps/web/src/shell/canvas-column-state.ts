// The canvas column's open/closed state as a pure reducer, separate from
// `breakpoints.ts`'s allow/disallow rule — a user's toggle and the
// viewport's veto are two independent inputs, and `resolveCanvasVisibility`
// is the one place they combine.

export type CanvasColumnState = { readonly open: boolean };

export function initialCanvasColumnState(): CanvasColumnState {
  return { open: false };
}

export function toggleCanvasColumn(
  state: CanvasColumnState,
): CanvasColumnState {
  return { open: !state.open };
}

/** What actually renders: the user's toggle, gated by whether the current
 * viewport has room for a fourth column at all. */
export function resolveCanvasVisibility(
  state: CanvasColumnState,
  allowed: boolean,
): boolean {
  return state.open && allowed;
}
