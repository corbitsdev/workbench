// Path-id helpers for settings and top-level roster deep links. Shared by
// the shell (col2 section nav) and the settings sections (stage detail) so
// neither layer owns the other. Same pattern as workbench-path.ts. Agents
// and Skills were Settings sections for a stretch (CL-5990) at
// `/settings/agents/:id` and `/settings/skills/:id`; CL-6353/CL-6354/
// CL-6355 moved both back out to their own top-level rail destinations —
// `/agents/:id` and `/skills/:id`, via `agentIdFromPath`/`skillIdFromPath`
// below.

export const SETTINGS_PATH_PREFIX = "/settings";
export const AGENTS_PATH_PREFIX = "/agents";
export const SKILLS_PATH_PREFIX = "/skills";
export const FILES_PATH_PREFIX = "/files";

/** Extract a sub-selection from a flat top-level route (`/agents/:id`,
 * `/skills/:id`) — `null` for the bare prefix or a path outside it. */
function entityIdFromTopLevelPath(path: string, prefix: string): string | null {
  if (path === prefix) return null;
  if (!path.startsWith(`${prefix}/`)) return null;
  const rest = path.slice(prefix.length + 1);
  return rest === "" ? null : decodeURIComponent(rest);
}

export function agentIdFromPath(path: string): string | null {
  return entityIdFromTopLevelPath(path, AGENTS_PATH_PREFIX);
}

export function skillIdFromPath(path: string): string | null {
  return entityIdFromTopLevelPath(path, SKILLS_PATH_PREFIX);
}

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
