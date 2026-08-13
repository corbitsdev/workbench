// Channel deep links live at `/c/:channelId`. The retired `/chat` prefix
// still resolves here so old bookmarks and in-flight links land on the
// same surface instead of a dead route. A channel's settings are a full
// stage surface (never a dialog — channels are tenants), routed at the
// `/settings` sub-path of its deep link.

export const CHANNEL_PATH_PREFIX = "/c";
const LEGACY_CHAT_PATH_PREFIX = "/chat";
const SETTINGS_SUFFIX = "/settings";

/** Strip a trailing settings sub-path segment, if present. */
function withoutSettingsSuffix(path: string): string {
  return path.endsWith(SETTINGS_SUFFIX)
    ? path.slice(0, -SETTINGS_SUFFIX.length)
    : path;
}

/** Extract a channel id from `/c/:id`, `/c/:id/settings`, or the legacy
 * `/chat/:id`. */
export function channelIdFromPath(path: string): string | null {
  const base = withoutSettingsSuffix(path);
  for (const prefix of [CHANNEL_PATH_PREFIX, LEGACY_CHAT_PATH_PREFIX]) {
    if (base === prefix) return null;
    if (!base.startsWith(`${prefix}/`)) continue;
    const rest = base.slice(prefix.length + 1);
    if (rest === "") return null;
    return decodeURIComponent(rest);
  }
  return null;
}

/** True for `/c`, `/c/:id`, `/c/:id/settings`, and the legacy `/chat`
 * equivalents. */
export function isChannelPath(path: string): boolean {
  return (
    path === CHANNEL_PATH_PREFIX ||
    path.startsWith(`${CHANNEL_PATH_PREFIX}/`) ||
    path === LEGACY_CHAT_PATH_PREFIX ||
    path.startsWith(`${LEGACY_CHAT_PATH_PREFIX}/`)
  );
}

/** True for `/c/:id/settings` (the channel settings stage surface). */
export function isChannelSettingsPath(path: string): boolean {
  return isChannelPath(path) && path.endsWith(SETTINGS_SUFFIX);
}

/** Canonical path for a channel (or the empty channel surface). */
export function channelPath(channelId: string | null): string {
  if (channelId === null) return CHANNEL_PATH_PREFIX;
  return `${CHANNEL_PATH_PREFIX}/${encodeURIComponent(channelId)}`;
}

/** Canonical path for a channel's settings stage surface. */
export function channelSettingsPath(channelId: string): string {
  return `${channelPath(channelId)}${SETTINGS_SUFFIX}`;
}
