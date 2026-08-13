/** App-local event so the global context menu can trigger a channel panel
 * row's own inline-rename input without either side owning the other's
 * state, mirroring `command-palette-events.ts`. */

export const REQUEST_CHANNEL_RENAME_EVENT = "workbench:request-channel-rename";

export type ChannelRenameRequest = { readonly channelId: string };

export function requestChannelRename(channelId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<ChannelRenameRequest>(REQUEST_CHANNEL_RENAME_EVENT, {
      detail: { channelId },
    }),
  );
}

export function isChannelRenameRequestFor(
  event: Event,
  channelId: string,
): boolean {
  return (
    event instanceof CustomEvent &&
    (event.detail as ChannelRenameRequest | undefined)?.channelId === channelId
  );
}
