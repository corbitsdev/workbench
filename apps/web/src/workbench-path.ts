// The retired `/chat` prefix still resolves to `/w/:workbenchId` so old
// bookmarks land on the same surface instead of a dead route. Settings is
// a full stage surface, never a dialog, since a workbench is a tenant.

import { decodedOrNull } from "@corbits/url-path";

/** The settings sub-paths a workbench deep link still resolves. */
export const WORKBENCH_SETTINGS_SECTION_IDS = ["general", "members", "agents", "danger"] as const;
export type WorkbenchSettingsSectionId = (typeof WORKBENCH_SETTINGS_SECTION_IDS)[number];

function isWorkbenchSettingsSectionId(value: string): value is WorkbenchSettingsSectionId {
  return (WORKBENCH_SETTINGS_SECTION_IDS as readonly string[]).includes(value);
}

export const WORKBENCH_PATH_PREFIX = "/w";
const LEGACY_CHAT_PATH_PREFIX = "/chat";
const SETTINGS_SUFFIX = "/settings";

/** Strip a trailing settings sub-path segment (with or without its own
 * section id / entity id), if present. */
function withoutSettingsSuffix(path: string): string {
  const settingsIndex = path.indexOf(SETTINGS_SUFFIX);
  if (settingsIndex === -1) return path;
  const rest = path.slice(settingsIndex + SETTINGS_SUFFIX.length);
  if (rest !== "" && !rest.startsWith("/")) return path;
  return path.slice(0, settingsIndex);
}

/** Extract a workbench id from `/w/:id`, `/w/:id/settings`, or the legacy
 * `/chat/:id`. */
export function workbenchIdFromPath(path: string): string | null {
  const base = withoutSettingsSuffix(path);
  for (const prefix of [WORKBENCH_PATH_PREFIX, LEGACY_CHAT_PATH_PREFIX]) {
    if (base === prefix) return null;
    if (!base.startsWith(`${prefix}/`)) continue;
    const rest = base.slice(prefix.length + 1);
    if (rest === "") return null;
    return decodedOrNull(rest);
  }
  return null;
}

/** True for `/w`, `/w/:id`, `/w/:id/settings`, and the legacy `/chat`
 * equivalents. */
export function isWorkbenchPath(path: string): boolean {
  return (
    path === WORKBENCH_PATH_PREFIX ||
    path.startsWith(`${WORKBENCH_PATH_PREFIX}/`) ||
    path === LEGACY_CHAT_PATH_PREFIX ||
    path.startsWith(`${LEGACY_CHAT_PATH_PREFIX}/`)
  );
}

/** True for `/w/:id/settings`, `/w/:id/settings/:section`, and
 * `/w/:id/settings/:section/:entityId` (the workbench settings stage
 * surface). */
export function isWorkbenchSettingsPath(path: string): boolean {
  return (
    isWorkbenchPath(path) &&
    (path.endsWith(SETTINGS_SUFFIX) || path.includes(`${SETTINGS_SUFFIX}/`))
  );
}

/** Canonical path for a workbench (or the empty workbench surface). */
export function workbenchPath(workbenchId: string | null): string {
  if (workbenchId === null) return WORKBENCH_PATH_PREFIX;
  return `${WORKBENCH_PATH_PREFIX}/${encodeURIComponent(workbenchId)}`;
}

/** Canonical settings path, optionally scoped to a section and its own
 * sub-selection, for a deep link straight to a detail like an agent. */
export function workbenchSettingsPath(
  workbenchId: string,
  section?: WorkbenchSettingsSectionId,
  entityId?: string,
): string {
  const base = `${workbenchPath(workbenchId)}${SETTINGS_SUFFIX}`;
  if (section === undefined) return base;
  const withSection = `${base}/${section}`;
  if (entityId === undefined) return withSection;
  return `${withSection}/${encodeURIComponent(entityId)}`;
}

/** `undefined` for bare `/settings`, a malformed escape, or an unrecognized
 * section id — the caller falls back to the first section, same contract
 * as `settingsSectionIdFromPath` in `path-ids.ts`. */
export function workbenchSettingsSectionFromPath(
  path: string,
): WorkbenchSettingsSectionId | undefined {
  const sectionPrefix = `${SETTINGS_SUFFIX}/`;
  const index = path.indexOf(sectionPrefix);
  if (index === -1) return undefined;
  const rest = path.slice(index + sectionPrefix.length);
  if (rest === "") return undefined;
  const section = rest.split("/")[0];
  if (section === undefined || section === "") return undefined;
  const decoded = decodedOrNull(section);
  if (decoded === null || !isWorkbenchSettingsSectionId(decoded)) {
    return undefined;
  }
  return decoded;
}

/** Mirrors `settingsEntityIdFromPath` in `path-ids.ts`, but locates the
 * settings suffix by `indexOf` since workbench paths aren't rooted at it. */
export function workbenchSettingsEntityIdFromPath(path: string, sectionId: string): string | null {
  const sectionPrefix = `${SETTINGS_SUFFIX}/${sectionId}/`;
  const index = path.indexOf(sectionPrefix);
  if (index === -1) return null;
  const rest = path.slice(index + sectionPrefix.length);
  return rest === "" ? null : decodedOrNull(rest);
}
