// Default Myra channel: the product land surface. Find an existing channel
// titled Myra (case-insensitive) or create one. Pure helpers stay free of
// React so they unit-test without a DOM.

import { createChannel, listChannels, type Channel } from "@corbits/chat-ui";

export const MYRA_CHANNEL_TITLE = "Myra";

export type EnsureMyraChannelResult =
  | { readonly kind: "ready"; readonly channelId: string }
  | { readonly kind: "error"; readonly message: string };

export function isMyraChannelTitle(title: string): boolean {
  return title.trim().toLowerCase() === MYRA_CHANNEL_TITLE.toLowerCase();
}

/** The last channel id `ensureMyraChannel` resolved to, for the shell's
 * col2-wide derivation (CL-5936): "Myra is the active surface" reduces to
 * "the open channel is the one Talk-to-Myra last landed us on". Module-level
 * because the shell needs it synchronously from `path` alone, with no
 * channel-title fetch of its own. */
let cachedMyraChannelId: string | null = null;

export function isMyraChannelId(channelId: string | null): boolean {
  return channelId !== null && channelId === cachedMyraChannelId;
}

/** Test helper — drop the cached id between cases. */
export function resetMyraChannelCache(): void {
  cachedMyraChannelId = null;
}

/** Prefer an exact Myra title; first match wins across the given list. */
export function findMyraChannel(
  channels: readonly Channel[],
): Channel | undefined {
  return channels.find((channel) => isMyraChannelTitle(channel.title));
}

/**
 * List channel + chat kinds, reuse a Myra-titled row if one exists, otherwise
 * create a multiplayer channel named Myra. Full defineAgent-per-channel seed
 * is CL-5656; this is the land path that opens stage onto a real channel.
 */
export async function ensureMyraChannel(
  tenantId: string,
): Promise<EnsureMyraChannelResult> {
  try {
    const [channels, chats] = await Promise.all([
      listChannels(tenantId, "channel"),
      listChannels(tenantId, "chat"),
    ]);
    const existing = findMyraChannel(channels) ?? findMyraChannel(chats);
    if (existing !== undefined) {
      cachedMyraChannelId = existing.id;
      return { kind: "ready", channelId: existing.id };
    }
    const created = await createChannel(tenantId, {
      kind: "channel",
      name: MYRA_CHANNEL_TITLE,
    });
    cachedMyraChannelId = created.id;
    return { kind: "ready", channelId: created.id };
  } catch (cause) {
    return {
      kind: "error",
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
}
