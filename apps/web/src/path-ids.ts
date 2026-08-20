// Path-id helpers for settings deep links. Shared by the shell (col2
// section nav) and the settings sections (stage detail) so neither layer
// owns the other. Same pattern as workbench-path.ts. Agents and Skills used
// to be their own top-level routes (`/agents/:id`, `/skills/:id`); they are
// now Settings sections at `/settings/agents/:id` and `/settings/skills/:id`
// — see `settingsEntityIdFromPath`.

export const SETTINGS_PATH_PREFIX = "/settings";

/** Extract a settings section id from `/settings/:id` or `/settings/:id/…`
 * — only the first path segment, so a section with its own sub-selection
 * (e.g. `/settings/agents/:definitionId`) still resolves to its section id. */
export function settingsSectionIdFromPath(path: string): string | null {
  if (!path.startsWith(`${SETTINGS_PATH_PREFIX}/`)) return null;
  const rest = path.slice(SETTINGS_PATH_PREFIX.length + 1);
  if (rest === "") return null;
  const id = rest.split("/")[0];
  return id === undefined || id === "" ? null : decodeURIComponent(id);
}

/** Extract a section's own sub-selection from `/settings/:sectionId/:entityId`
 * — `null` when the path isn't under that section, or carries no sub-id. */
export function settingsEntityIdFromPath(
  path: string,
  sectionId: string,
): string | null {
  const prefix = `${SETTINGS_PATH_PREFIX}/${sectionId}/`;
  if (!path.startsWith(prefix)) return null;
  const rest = path.slice(prefix.length);
  return rest === "" ? null : decodeURIComponent(rest);
}
