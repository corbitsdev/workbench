// The canvas column's state as pure transitions, separate from
// `breakpoints.ts`'s allow/disallow rule — a user's toggle, a channel the
// user opened into the canvas, a profile subject, and the viewport's veto
// are independent inputs; `resolveCanvasVisibility` is the one place they
// combine.
//
// Channels are tenant-scoped. Every open channel is stamped with the
// workbench (tenant) it was opened under; a workbench switch drops the
// channel so col4 never keeps a foreign conversation loaded.

import type { ProfileSubject } from "@corbits/chat-ui";

import { channelIdFromPath } from "../channel-path";

export type CanvasColumnState = {
  readonly open: boolean;
  /** The channel rendered in the canvas, or null when no channel is loaded. */
  readonly channelId: string | null;
  /**
   * Workbench (tenant) the `channelId` was opened under. Null when no channel
   * is loaded. The shell only feeds the channel into ChatWorkspace when this
   * matches the selected workbench — otherwise a switch leaves a foreign id
   * visible until the next list load.
   */
  readonly channelTenantId: string | null;
  /** When set, the canvas shows a ProfileCard for this subject over the chat. */
  readonly profile: ProfileSubject | null;
};

export function initialCanvasColumnState(): CanvasColumnState {
  return {
    open: false,
    channelId: null,
    channelTenantId: null,
    profile: null,
  };
}

/** Flip the canvas open/closed without touching the loaded channel — closing
 *  and reopening lands on the same conversation. */
export function toggleCanvasColumn(
  state: CanvasColumnState,
): CanvasColumnState {
  return { ...state, open: !state.open };
}

/** Open the canvas onto a channel owned by the given workbench. */
export function openChannelInCanvas(
  channelId: string,
  tenantId: string,
): CanvasColumnState {
  return {
    open: true,
    channelId,
    channelTenantId: tenantId,
    profile: null,
  };
}

/** Drop the loaded channel and profile (workbench switch). Canvas closes. */
export function clearCanvasForTenantSwitch(): CanvasColumnState {
  return initialCanvasColumnState();
}

/**
 * Channel id the canvas may render for the selected workbench, or null when
 * the loaded channel belongs to a different workbench (or nothing is loaded).
 */
export function channelIdForTenant(
  state: CanvasColumnState,
  tenantId: string | null,
): string | null {
  if (tenantId === null) return null;
  if (state.channelId === null) return null;
  if (state.channelTenantId !== tenantId) return null;
  return state.channelId;
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
 * the canvas onto that channel under `tenantId`; any other path leaves the
 * previous state alone so navigating within the rest of the app does not drop
 * an open conversation. When `tenantId` is null the path cannot be claimed —
 * return the prior state unchanged (caller should not deep-link without a
 * workbench).
 */
export function applyChannelPathToCanvas(
  state: CanvasColumnState,
  path: string,
  tenantId: string | null,
): CanvasColumnState {
  const channelId = channelIdFromPath(path);
  if (channelId === null) return state;
  if (tenantId === null) return state;
  return openChannelInCanvas(channelId, tenantId);
}

/** What actually renders: the user's toggle (or a deep-link channel), gated by
 *  whether the current viewport has room for a fourth column at all. */
export function resolveCanvasVisibility(
  state: CanvasColumnState,
  allowed: boolean,
): boolean {
  return state.open && allowed;
}
