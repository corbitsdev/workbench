// The canvas column's state as a pure reducer, separate from `breakpoints.ts`'s
// allow/disallow rule — a user's toggle, a channel the user opened into the
// canvas, and the viewport's veto are three independent inputs, and
// `resolveCanvasVisibility` is the one place they combine.
//
// The canvas hosts the channel chat surface (the retired `/chat` page's
// `ChatWorkspace`), so its state carries the active channel alongside
// open/closed. A deep link (`/c/:channelId`) feeds the same `channelId` from
// the URL in `app-shell.tsx`; this reducer only owns the toggle-and-channel
// shape, never the URL.

export type CanvasColumnState = {
  readonly open: boolean;
  /** The channel rendered in the canvas, or null when no channel is loaded. */
  readonly channelId: string | null;
};

export function initialCanvasColumnState(): CanvasColumnState {
  return { open: false, channelId: null };
}

/** Flip the canvas open/closed without touching the loaded channel — closing
 *  and reopening lands on the same conversation. */
export function toggleCanvasColumn(
  state: CanvasColumnState,
): CanvasColumnState {
  return { ...state, open: !state.open };
}

/** Open the canvas onto a specific channel (a channel-row click). */
export function openChannelInCanvas(
  _state: CanvasColumnState,
  channelId: string,
): CanvasColumnState {
  return { open: true, channelId };
}

/** Close the canvas and drop the loaded channel. */
export function closeCanvasColumn(
  _state: CanvasColumnState,
): CanvasColumnState {
  return { open: false, channelId: null };
}

/** What actually renders: the user's toggle (or a deep-link channel), gated by
 *  whether the current viewport has room for a fourth column at all. */
export function resolveCanvasVisibility(
  state: CanvasColumnState,
  allowed: boolean,
): boolean {
  return state.open && allowed;
}
