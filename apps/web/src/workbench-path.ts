// Workbench deep links live at `/w/:workbenchId`. The retired `/chat` prefix
// still resolves here so old bookmarks and in-flight links land on the
// same surface instead of a dead route. A workbench's settings are a full
// stage surface (never a dialog — workbenches are tenants), routed at the
// `/settings` sub-path of its deep link, optionally followed by the
// section id (`/settings/:section`) and a section's own sub-selection
// (`/settings/:section/:entityId`) — same pattern as `path-ids.ts`'s
// `/settings/:section` and `settingsEntityIdFromPath` for the app-level
// Settings page.

import type { WorkbenchSettingsSectionId } from "@corbits/chat-ui";

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
    return decodeURIComponent(rest);
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

/** Canonical path for a workbench's settings stage surface, optionally
 * scoped to a section (`/w/:id/settings/:section`) and that section's own
 * sub-selection (`/w/:id/settings/:section/:entityId`) for a deep link
 * straight to an agent (or similar) detail. */
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

/** Extract the section id from `/w/:id/settings/:section` (or
 * `/settings/:section/:entityId`, or its legacy `/chat` equivalent) —
 * `undefined` for bare `/settings` or a non-settings path. Only the first
 * segment after `/settings/` is the section, so a trailing entity id does
 * not change the section. Not validated against the known section ids: the
 * settings surface already falls back to its first section for an id it
 * doesn't recognize, the same contract `settingsSectionIdFromPath` in
 * `path-ids.ts` relies on its caller for. */
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
  return decodeURIComponent(section) as WorkbenchSettingsSectionId;
}

/** Extract a section's own sub-selection from
 * `/w/:id/settings/:sectionId/:entityId` (or the legacy `/chat`
 * equivalent) — `null` when the path isn't under that section, or carries
 * no sub-id. Mirrors `settingsEntityIdFromPath` in `path-ids.ts`, but
 * locates the settings suffix the same way `workbenchSettingsSectionFromPath`
 * does (`indexOf`), because workbench paths are not rooted at `/settings`. */
export function workbenchSettingsEntityIdFromPath(
  path: string,
  sectionId: string,
): string | null {
  const sectionPrefix = `${SETTINGS_SUFFIX}/${sectionId}/`;
  const index = path.indexOf(sectionPrefix);
  if (index === -1) return null;
  const rest = path.slice(index + sectionPrefix.length);
  return rest === "" ? null : decodeURIComponent(rest);
}
