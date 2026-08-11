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
      return { kind: "ready", channelId: existing.id };
    }
    const created = await createChannel(tenantId, {
      kind: "channel",
      name: MYRA_CHANNEL_TITLE,
    });
    return { kind: "ready", channelId: created.id };
  } catch (cause) {
    return {
      kind: "error",
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
}
