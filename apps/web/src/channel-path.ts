// Channel deep links live at `/c/:channelId`. The retired `/chat` prefix
// still resolves here so old bookmarks and in-flight links land on the
// same surface instead of a dead route.

export const CHANNEL_PATH_PREFIX = "/c";
const LEGACY_CHAT_PATH_PREFIX = "/chat";

/** Extract a channel id from `/c/:id` or the legacy `/chat/:id`. */
export function channelIdFromPath(path: string): string | null {
  for (const prefix of [CHANNEL_PATH_PREFIX, LEGACY_CHAT_PATH_PREFIX]) {
    if (path === prefix) return null;
    if (!path.startsWith(`${prefix}/`)) continue;
    const rest = path.slice(prefix.length + 1);
    if (rest === "") return null;
    return decodeURIComponent(rest);
  }
  return null;
}

/** True for `/c`, `/c/:id`, and the legacy `/chat` equivalents. */
export function isChannelPath(path: string): boolean {
  return (
    path === CHANNEL_PATH_PREFIX ||
    path.startsWith(`${CHANNEL_PATH_PREFIX}/`) ||
    path === LEGACY_CHAT_PATH_PREFIX ||
    path.startsWith(`${LEGACY_CHAT_PATH_PREFIX}/`)
  );
}

/** Canonical path for a channel (or the empty channel surface). */
export function channelPath(channelId: string | null): string {
  if (channelId === null) return CHANNEL_PATH_PREFIX;
  return `${CHANNEL_PATH_PREFIX}/${encodeURIComponent(channelId)}`;
}
