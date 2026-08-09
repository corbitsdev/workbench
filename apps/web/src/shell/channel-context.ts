// Resolve the active channel's display title for the contextual page band.
// Reuses the same channel/chat lists the Channels band already loads so the
// page title does not invent a second fetch.

import type { Channel } from "@corbits/chat-ui";

import type { BenchActivityQuery } from "./bench-activity";

/** Prefer channel title; fall back to untitled label; null when still loading. */
export function resolveChannelTitle(
  activity: BenchActivityQuery,
  channelId: string | null,
): string | null {
  if (channelId === null) return null;
  if (activity.kind !== "ready") return null;
  const match = findChannel(activity.channels, activity.chats, channelId);
  if (match === undefined) return null;
  const title = match.title?.trim();
  return title && title.length > 0 ? title : "Untitled channel";
}

function findChannel(
  channels: readonly Channel[],
  chats: readonly Channel[],
  channelId: string,
): Channel | undefined {
  return (
    channels.find((c) => c.id === channelId) ??
    chats.find((c) => c.id === channelId)
  );
}
