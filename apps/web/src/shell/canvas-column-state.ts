// The canvas column's state as pure transitions, separate from
// `breakpoints.ts`'s allow/disallow rule — a user's toggle, a channel the
// user opened into the canvas, and the viewport's veto are three independent
// inputs, and `resolveCanvasVisibility` is the one place they combine.
//
// The canvas hosts the channel chat surface (the retired `/chat` page's
// `ChatWorkspace`), so its state carries the active channel alongside
// open/closed. A deep link (`/c/:channelId`) feeds the same `channelId` from
// the URL; path→state lives here so the shell and tests share one contract.

import { channelIdFromPath } from "../channel-path";

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

/** Open the canvas onto a specific channel (channel-row click or deep link). */
export function openChannelInCanvas(channelId: string): CanvasColumnState {
  return { open: true, channelId };
}

/**
 * Apply a route path to canvas state. A `/c/:id` (or legacy `/chat/:id`) opens
 * the canvas onto that channel; any other path leaves the previous state alone
 * so navigating within the rest of the app does not drop an open conversation.
 */
export function applyChannelPathToCanvas(
  state: CanvasColumnState,
  path: string,
): CanvasColumnState {
  const channelId = channelIdFromPath(path);
  if (channelId === null) return state;
  return openChannelInCanvas(channelId);
}

/** What actually renders: the user's toggle (or a deep-link channel), gated by
 *  whether the current viewport has room for a fourth column at all. */
export function resolveCanvasVisibility(
  state: CanvasColumnState,
  allowed: boolean,
): boolean {
  return state.open && allowed;
}
