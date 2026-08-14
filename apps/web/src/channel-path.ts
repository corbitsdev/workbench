// Channel deep links live at `/c/:channelId`. The retired `/chat` prefix
// still resolves here so old bookmarks and in-flight links land on the
// same surface instead of a dead route. A channel's settings are a full
// stage surface (never a dialog — channels are tenants), routed at the
// `/settings` sub-path of its deep link, optionally followed by the
// section id (`/settings/:section`) — same pattern as `path-ids.ts`'s
// `/settings/:section` for the app-level Settings page.

import type { ChannelSettingsSectionId } from "@corbits/chat-ui";

export const CHANNEL_PATH_PREFIX = "/c";
const LEGACY_CHAT_PATH_PREFIX = "/chat";
const SETTINGS_SUFFIX = "/settings";

/** Strip a trailing settings sub-path segment (with or without its own
 * section id), if present. */
function withoutSettingsSuffix(path: string): string {
  const settingsIndex = path.indexOf(SETTINGS_SUFFIX);
  if (settingsIndex === -1) return path;
  const rest = path.slice(settingsIndex + SETTINGS_SUFFIX.length);
  if (rest !== "" && !rest.startsWith("/")) return path;
  return path.slice(0, settingsIndex);
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

/** True for `/c/:id/settings` and `/c/:id/settings/:section` (the channel
 * settings stage surface). */
export function isChannelSettingsPath(path: string): boolean {
  return (
    isChannelPath(path) &&
    (path.endsWith(SETTINGS_SUFFIX) || path.includes(`${SETTINGS_SUFFIX}/`))
  );
}

/** Canonical path for a channel (or the empty channel surface). */
export function channelPath(channelId: string | null): string {
  if (channelId === null) return CHANNEL_PATH_PREFIX;
  return `${CHANNEL_PATH_PREFIX}/${encodeURIComponent(channelId)}`;
}

/** Canonical path for a channel's settings stage surface, optionally
 * scoped to a section (`/c/:id/settings/:section`) for a deep link straight
 * to that tab. */
export function channelSettingsPath(
  channelId: string,
  section?: ChannelSettingsSectionId,
): string {
  const base = `${channelPath(channelId)}${SETTINGS_SUFFIX}`;
  return section === undefined ? base : `${base}/${section}`;
}

/** Extract the section id from `/c/:id/settings/:section` (or its legacy
 * `/chat` equivalent) — `undefined` for bare `/settings` or a non-settings
 * path. Not validated against the known section ids: the settings surface
 * already falls back to its first section for an id it doesn't recognize,
 * the same contract `settingsSectionIdFromPath` in `path-ids.ts` relies on
 * its caller for. */
export function channelSettingsSectionFromPath(
  path: string,
): ChannelSettingsSectionId | undefined {
  const sectionPrefix = `${SETTINGS_SUFFIX}/`;
  const index = path.indexOf(sectionPrefix);
  if (index === -1) return undefined;
  const rest = path.slice(index + sectionPrefix.length);
  if (rest === "") return undefined;
  const section = rest.split("/")[0];
  if (section === undefined || section === "") return undefined;
  return decodeURIComponent(section) as ChannelSettingsSectionId;
}
