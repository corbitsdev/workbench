/** App-local event so a channel-level 404 (`chat-page.tsx`, driven by
 * `ChatWorkspace`'s `onChannelNotFound`) can tell the command palette to
 * drop a stale Recents entry, without coupling the chat route to
 * `CommandPaletteProvider` state — same pattern as
 * `command-palette-events.ts`'s open-palette event. */

export const CHANNEL_NOT_FOUND_EVENT = "workbench:channel-not-found";

export function reportChannelNotFound(channelId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(CHANNEL_NOT_FOUND_EVENT, { detail: channelId }),
  );
}
