// The canvas column's state as pure transitions, separate from
// `breakpoints.ts`'s allow/disallow rule — a user's toggle, a channel the
// user opened into the canvas, a profile subject, and the viewport's veto
// are independent inputs; `resolveCanvasVisibility` is the one place they
// combine.
//
// The canvas hosts the channel chat surface (the retired `/chat` page's
// `ChatWorkspace`) and optionally a ProfileCard overlay. Deep links
// (`/c/:channelId`) feed the same `channelId` from the URL.

import type { ProfileSubject } from "@corbits/chat-ui";

import { channelIdFromPath } from "../channel-path";

export type CanvasColumnState = {
  readonly open: boolean;
  /** The channel rendered in the canvas, or null when no channel is loaded. */
  readonly channelId: string | null;
  /** When set, the canvas shows a ProfileCard for this subject over the chat. */
  readonly profile: ProfileSubject | null;
};

export function initialCanvasColumnState(): CanvasColumnState {
  return { open: false, channelId: null, profile: null };
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
  return { open: true, channelId, profile: null };
}

/** Open (or replace) a profile card in the canvas without dropping the channel. */
export function openProfileInCanvas(
  state: CanvasColumnState,
  profile: ProfileSubject,
): CanvasColumnState {
  return { ...state, open: true, profile };
}

export function clearProfileInCanvas(
  state: CanvasColumnState,
): CanvasColumnState {
  return { ...state, profile: null };
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
